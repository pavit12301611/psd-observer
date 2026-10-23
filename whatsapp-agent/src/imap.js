// imap.js — 📧 Minimal IMAP-over-TLS client (zero deps, node:tls only).
// Just enough protocol: LOGIN, SELECT, UID SEARCH UNSEEN, UID FETCH
// header fields, LOGOUT. Socket factory injected — tests feed canned
// server bytes. App-password auth (Gmail/Outlook/Yahoo all speak this).

import tls from 'node:tls';

const CRLF = '\r\n';

export function createImapClient(opts = {}) {
  const {
    host, port = 993, user, pass,
    connectSocket = (h, p) => tls.connect({ host: h, port: p, servername: h, rejectUnauthorized: true }),
    timeoutMs = 20_000,
  } = opts;

  let socket = null;
  let buffer = '';
  let tagSeq = 0;
  const waiters = new Map(); // tag -> {resolve, reject, acc}

  function feed(chunk) {
    buffer += chunk;
    // untagged + tagged lines; server literals keep raw until sized read
    let idx;
    while ((idx = buffer.indexOf(CRLF)) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleLine(line);
    }
    // pending literals: "* 1 FETCH ... {123}" — the literal body + ")" follow
    for (const [, w] of waiters) {
      w.acc.push(lineOrEmpty());
    }
    function lineOrEmpty() { return ''; }
  }

  function handleLine(line) {
    if (!line) return;
    const tagM = line.match(/^(\S+)\s+(OK|NO|BAD)\b/i);
    if (tagM && waiters.has(tagM[1])) {
      const w = waiters.get(tagM[1]);
      waiters.delete(tagM[1]);
      w.resolve({ status: tagM[2].toUpperCase(), lines: w.lines, raw: w.raw });
      return;
    }
    for (const [, w] of waiters) {
      w.lines.push(line);
      w.raw += line + CRLF;
    }
  }

  function cmd(tag, command) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(tag);
        reject(new Error(`IMAP timeout: ${command.split(' ')[0]}`));
      }, timeoutMs);
      timer.unref?.();
      waiters.set(tag, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
        lines: [],
        raw: '',
      });
      socket.write(`${tag} ${command}${CRLF}`);
    });
  }

  return {
    async connect() {
      socket = connectSocket(host, port);
      socket.setEncoding('utf8');
      await new Promise((resolve, reject) => {
        socket.once('data', () => resolve()); // greeting
        socket.once('error', reject);
        socket.once('close', () => reject(new Error('IMAP connection closed')));
      });
      socket.on('data', feed);
      socket.on('error', () => { /* handled per-command */ });
      const tag = `A${++tagSeq}`;
      const r = await cmd(tag, `LOGIN ${quote(user)} ${quote(pass)}`);
      if (r.status !== 'OK') throw new Error(`IMAP login failed (${r.status})`);
      return true;
    },

    async fetchUnseen(limit = 20) {
      const t1 = `A${++tagSeq}`;
      const sel = await cmd(t1, 'SELECT INBOX');
      if (sel.status !== 'OK') throw new Error('IMAP select failed');
      const t2 = `A${++tagSeq}`;
      const search = await cmd(t2, 'UID SEARCH UNSEEN');
      const uids = (search.lines.join(' ').match(/\d+/g) ?? []).map(Number).filter(Boolean);
      const take = uids.slice(-limit);
      if (!take.length) return [];
      const t3 = `A${++tagSeq}`;
      const fetch = await cmd(
        t3,
        `UID FETCH ${take.join(',')} (UID BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`,
      );
      return parseFetches(fetch.raw);
    },

    async logout() {
      try {
        await cmd(`A${++tagSeq}`, 'LOGOUT');
      } catch { /* bye */ }
      socket?.destroy?.();
    },
  };
}

function quote(s) {
  return `"${String(s ?? '').replace(/"/g, '\\"')}"`;
}

/** Parse FETCH responses into [{uid, from, subject, date}]. */
export function parseFetches(raw) {
  const out = [];
  const blocks = String(raw ?? '').split(/(?=^\* \d+ FETCH)/m);
  for (const block of blocks) {
    const uidM = block.match(/UID (\d+)/);
    const headerPart = block.slice(block.indexOf('{'));
    const from = (block.match(/^From:\s*(.+)$/im) ?? block.match(/From:\s*(.+?)(?:\r?\n|$)/i) ?? [])[1]?.trim();
    const subject = (block.match(/^Subject:\s*(.+)$/im) ?? block.match(/Subject:\s*(.+?)(?:\r?\n|$)/i) ?? [])[1]?.trim();
    const date = (block.match(/^Date:\s*(.+)$/im) ?? block.match(/Date:\s*(.+?)(?:\r?\n|$)/i) ?? [])[1]?.trim();
    if (uidM && (from || subject)) {
      out.push({
        uid: Number(uidM[1]),
        from: decodeMime(from ?? ''),
        subject: decodeMime(subject ?? ''),
        date: date ?? '',
      });
    }
    void headerPart;
  }
  return out;
}

/** Best-effort RFC2047 decode of =?UTF-8?B?...?= words. */
export function decodeMime(s) {
  return String(s ?? '').replace(
    /=\?([\w-]+)\?([BbQq])\?([^?]*)\?=/g,
    (m, _cs, enc, payload) => {
      try {
        return enc.toLowerCase() === 'b'
          ? Buffer.from(payload, 'base64').toString('utf8')
          : decodeURIComponent(payload.replace(/_/g, ' '));
      } catch {
        return m;
      }
    },
  );
}
