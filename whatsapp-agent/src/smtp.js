// smtp.js — ✉️ Minimal SMTP-over-TLS client (zero deps, node:tls/net only).
// Just enough protocol: EHLO, STARTTLS (587) or implicit TLS (465), AUTH
// PLAIN/LOGIN, MAIL FROM, RCPT TO, DATA, QUIT. Socket factories are injected —
// tests feed canned server bytes, production uses real TLS.
//
// Why: reading mail landed in 3.7.0 (imap.js + mail.js), but *sending* still
// went through the paid cloud (api.observer-ai.com → SendGrid → Auth0). This
// file is the missing half, so "email kar do" works from this PC alone.
//
// Safety: the password is never put in an error message, a log line or a reply.
// Every failure is re-thrown as a short, human sentence with the credentials
// scrubbed out.

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export const SMTP_TIMEOUT_MS = 20_000;
export const MAX_RECIPIENTS = 12;
/** RFC 2045 base64 line length — safe for every server and every client. */
const BASE64_LINE = 76;

/** Never let a password or an AUTH blob reach a reply, a log or a stack trace. */
export function scrubCredentials(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length < 3) continue;
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.split(secret).join('[redacted]').replace(new RegExp(escaped, 'g'), '[redacted]');
  }
  // Server echo of base64 AUTH material (some mail servers do this).
  return out.replace(/\bAUTH\s+(?:PLAIN|LOGIN)?\s*[A-Za-z0-9+/=]{8,}/gi, 'AUTH [redacted]');
}

const b64 = (value) => Buffer.from(String(value), 'utf8').toString('base64');

function assertLineSafe(text, what) {
  const value = String(text ?? '');
  if (/[\r\n]/.test(value)) throw new Error(`${what} me line break nahi ho sakta`);
  return value;
}

/** "a@x.com, B <b@y.com>" → ['a@x.com', 'b@y.com'] (validated, deduped). */
export function parseAddressList(input) {
  const raw = Array.isArray(input) ? input.join(',') : String(input ?? '');
  // Header injection: a CR/LF inside an address can add Bcc:/RCPT: lines.
  if (/[\r\n]/.test(raw)) throw new Error('address me line break nahi ho sakta');
  const found = raw
    .split(/[,;]/)
    .map((part) => part.trim())
    .map((part) => {
      const angle = /<([^>]+)>/.exec(part);
      return (angle ? angle[1] : part).trim();
    })
    .filter(Boolean);
  const valid = [];
  for (const address of found) {
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address)) {
      throw new Error(`"${address}" valid email address nahi lagta`);
    }
    if (!valid.includes(address)) valid.push(address);
  }
  return valid;
}

/** RFC 2047 encoded-word for non-ASCII headers (subject, display names). */
export function encodeHeader(value) {
  const text = assertLineSafe(value, 'Header');
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7E]/.test(text)) return text;
  const chunks = [];
  let rest = text;
  while (rest.length) {
    let take = Math.min(45, rest.length);
    while (take > 1 && /[\uD800-\uDBFF]/.test(rest[take - 1] ?? '')) take -= 1;
    chunks.push(`=?UTF-8?B?${b64(rest.slice(0, take))}?=`);
    rest = rest.slice(take);
  }
  return chunks.join(' ');
}

/** Dot-stuff a body block and normalise newlines to CRLF (RFC 5321 §4.5.2). */
export function dotStuff(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');
}

/**
 * Build a complete RFC 5322 message. Text is base64-encoded so Hinglish,
 * emoji and Devanagari all survive without quoted-printable guesswork.
 */
export function buildMessage({ from, to, subject = '', text = '', html = null, attachments = [], messageId = null, date = new Date() }) {
  const recipients = parseAddressList(to);
  if (!recipients.length) throw new Error('Kam se kam ek To address chahiye');
  if (recipients.length > MAX_RECIPIENTS) throw new Error(`Ek baar me max ${MAX_RECIPIENTS} recipients`);
  const sender = parseAddressList(from)[0] ?? assertLineSafe(from, 'From');
  const id = messageId ?? `<${crypto.randomUUID()}@${String(sender).split('@')[1] ?? 'observer.local'}>`;
  const files = attachments.slice(0, 5);

  const headers = [
    `From: ${encodeHeader(sender)}`,
    `To: ${recipients.map((address) => encodeHeader(address)).join(', ')}`,
    `Subject: ${encodeHeader(subject || '(no subject)')}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
  ];

  const bodyBlock = (text ?? '') || ' ';

  if (!files.length && !html) {
    // Single part: content headers belong in the top block, body after the blank line.
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64');
    return { message: `${headers.join('\r\n')}\r\n\r\n${wrapBase64(b64(bodyBlock))}`, messageId: id };
  }

  if (!files.length) {
    headers.push('Content-Type: multipart/alternative; boundary="obs-alt"');
    const parts = [
      ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrapBase64(b64(bodyBlock))].join('\r\n'),
      ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrapBase64(b64(html))].join('\r\n'),
    ];
    return { message: `${headers.join('\r\n')}\r\n\r\n${parts.map((part) => `--obs-alt\r\n${part}`).join('\r\n')}\r\n--obs-alt--`, messageId: id };
  }

  headers.push('Content-Type: multipart/mixed; boundary="obs-mixed"');
  const parts = [['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrapBase64(b64(bodyBlock))].join('\r\n')];
  if (html) {
    parts.push(['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', wrapBase64(b64(html))].join('\r\n'));
  }
  for (const file of files) {
    const name = encodeHeader(String(file.name ?? 'attachment.bin').replace(/["\r\n]/g, ''));
    const type = String(file.type ?? 'application/octet-stream');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data ?? ''), 'utf8');
    parts.push([
      `Content-Type: ${type}; name="${name}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${name}"`,
      '',
      wrapBase64(data.toString('base64')),
    ].join('\r\n'));
  }
  return {
    message: `${headers.join('\r\n')}\r\n\r\n${parts.map((part) => `--obs-mixed\r\n${part}`).join('\r\n')}\r\n--obs-mixed--`,
    messageId: id,
  };
}

function wrapBase64(value) {
  const out = [];
  for (let i = 0; i < value.length; i += BASE64_LINE) out.push(value.slice(i, i + BASE64_LINE));
  return out.join('\r\n');
}

/**
 * Create the client. `secure` defaults to true (implicit TLS, port 465 — the
 * Gmail default); pass secure:false + port 587 for STARTTLS.
 */
export function createSmtpClient(opts = {}) {
  const {
    host,
    port = 465,
    secure = true,
    user = null,
    pass = null,
    helo = 'observer-agent.local',
    timeoutMs = SMTP_TIMEOUT_MS,
    connectSocket = secure
      ? (h, p) => tls.connect({ host: h, port: p, servername: h })
      : (h, p) => net.connect({ host: h, port: p }),
    upgradeSocket = (socket, h) => tls.connect({ socket, servername: h }),
    starttls = !secure,
  } = opts;

  if (!host) throw new Error('SMTP host missing');
  const secrets = [pass, user && b64(user), pass && b64(pass)].filter(Boolean);

  let socket = null;
  let buffer = '';
  let queue = [];               // complete lines nobody has read yet
  let pending = null;           // the one reader waiting for the next line
  let failure = null;
  let commandCount = 0;
  let closed = false;

  const fail = (err) => {
    failure = err instanceof Error ? err : new Error(String(err));
    if (pending) { const p = pending; pending = null; p.reject(failure); }
  };

  function pushLine(line) {
    if (pending) { const p = pending; pending = null; p.resolve(line); }
    else queue.push(line);
  }

  function nextLine() {
    if (queue.length) return Promise.resolve(queue.shift());
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => { pending = { resolve, reject }; });
  }

  function attach(target) {
    target.setEncoding?.('utf8');
    target.setTimeout?.(timeoutMs, () => fail(new Error('SMTP server ne jawab nahi diya (timeout)')));
    target.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        pushLine(line);
      }
    });
    target.on('error', (err) => fail(new Error(scrubCredentials(err?.message ?? err, secrets))));
    target.on('close', () => {
      closed = true;
      fail(new Error('SMTP connection band ho gaya'));
    });
  }

  /** Read one complete reply (handles 250-first / 250-last continuation lines). */
  async function readReply() {
    const lines = [];
    for (;;) {
      const line = await nextLine();
      lines.push(line);
      const match = /^(\d{3})([ -])/.exec(line);
      if (match && match[2] === ' ') return { code: Number(match[1]), text: lines.join('\n'), lines };
    }
  }

  async function command(line, expected, label) {
    commandCount += 1;
    if (closed) throw new Error('SMTP connection band hai');
    socket.write(`${line}\r\n`);
    const reply = await readReply();
    if (expected && !expected.includes(reply.code)) {
      const detail = scrubCredentials(reply.text, secrets).split('\n').slice(-1)[0]?.slice(0, 160) ?? '';
      throw new Error(`${label ?? 'SMTP'} fail (${reply.code}): ${detail}`);
    }
    return reply;
  }

  async function connect() {
    socket = connectSocket(host, port);
    attach(socket);
    await new Promise((resolve, reject) => {
      if (secure) socket.once('secureConnect', resolve);
      else socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const banner = await readReply();
    if (banner.code !== 220) throw new Error(`SMTP server ne 220 nahi bheja (${banner.code})`);
    let ehlo = await command(`EHLO ${helo}`, [250], 'EHLO');
    if (starttls) {
      if (!/\bSTARTTLS\b/i.test(ehlo.text)) throw new Error('Server STARTTLS support nahi karta — port 465 (TLS) try karo');
      await command('STARTTLS', [220], 'STARTTLS');
      socket = upgradeSocket(socket, host);
      attach(socket);
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      ehlo = await command(`EHLO ${helo}`, [250], 'EHLO (TLS)');
    }
    if (user && pass) {
      const mechanisms = (/\bAUTH\b([^\n]*)/i.exec(ehlo.text)?.[1] ?? '').toUpperCase();
      try {
        if (!mechanisms || mechanisms.includes('PLAIN')) {
          await command(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`, [235], 'AUTH PLAIN');
        } else {
          await command('AUTH LOGIN', [334], 'AUTH LOGIN');
          await command(b64(user), [334], 'AUTH (user)');
          await command(b64(pass), [235], 'AUTH (password)');
        }
      } catch (err) {
        throw new Error(scrubCredentials(err?.message, secrets)
          .replace(/^AUTH[^:]*fail/, 'Login fail')
          .concat(' — app password check karo (normal Gmail password nahi chalega)'));
      }
    }
    return { ehlo: ehlo.text };
  }

  async function send({ from, to, subject = '', text = '', html = null, attachments = [], date } = {}) {
    const recipients = parseAddressList(to);
    const sender = parseAddressList(from ?? user ?? '')[0];
    if (!sender) throw new Error('From address missing (mail setup karo)');
    if (!recipients.length) throw new Error('To address missing');
    if (recipients.length > MAX_RECIPIENTS) throw new Error(`Ek baar me max ${MAX_RECIPIENTS} recipients`);
    const { message, messageId } = buildMessage({ from: sender, to: recipients, subject, text, html, attachments, date });

    await command(`MAIL FROM:<${assertLineSafe(sender, 'From')}>`, [250], 'MAIL FROM');
    for (const address of recipients) {
      await command(`RCPT TO:<${assertLineSafe(address, 'To')}>`, [250, 251], `RCPT TO ${address}`);
    }
    await command('DATA', [354], 'DATA');
    socket.write(`${dotStuff(message)}\r\n.\r\n`);
    const done = await readReply();
    if (done.code !== 250) throw new Error(`Server ne mail accept nahi kiya (${done.code}): ${scrubCredentials(done.text, secrets).slice(-120)}`);
    return { ok: true, messageId, recipients, bytes: message.length, commands: commandCount };
  }

  async function quit() {
    try { if (!closed) { socket.write('QUIT\r\n'); socket.end(); } } catch { /* already gone */ }
  }

  async function verify() {
    await connect();
    await quit();
    return { ok: true, host, port, secure, auth: Boolean(user && pass) };
  }

  return { connect, send, quit, verify, get state() { return { host, port, secure, auth: Boolean(user && pass), closed }; } };
}
