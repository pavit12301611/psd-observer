// journal.js — every file-changing action leaves a receipt, so /undo works.
//
// Full PC control is only comfortable if mistakes are reversible. Each write /
// move / copy / delete / mkdir / zip records what it replaced:
//
//   write  → the previous bytes are copied to data/undo/ first
//   delete → the file is backed up before it goes to the trash
//   move   → recorded as from/to, undo moves it back
//   copy   → undo deletes the copy
//   mkdir  → undo removes the (still empty) folder
//   zip    → undo deletes the archive it created
//
// One JSON file (data/journal.json) + one folder of small backups. Capped: a
// journal that grows forever is a disk leak, not a feature. Anything too big to
// back up is recorded as "not undoable" instead of pretending.

import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 40;
const MAX_BACKUP_BYTES = 512 * 1024; // 512 KB per file is plenty for notes/code

const nowId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function createJournal({ config = {}, log = console, dir = null, file = null } = {}) {
  const baseDir = dir ?? path.join(config.dataDir ?? path.resolve('data'), 'undo');
  const journalFile = file ?? path.join(baseDir, 'journal.json');

  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      return Array.isArray(data?.entries) ? data.entries : [];
    } catch {
      return [];
    }
  }

  function write(entries) {
    try {
      fs.mkdirSync(path.dirname(journalFile), { recursive: true });
      const tmp = `${journalFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
      fs.renameSync(tmp, journalFile);
    } catch (err) {
      log.warn?.(`[journal] could not save: ${err.message}`);
    }
  }

  function record(entry) {
    const entries = read();
    const full = { id: nowId(), ts: Date.now(), ...entry };
    entries.push(full);
    while (entries.length > MAX_ENTRIES) {
      const dropped = entries.shift();
      for (const backup of dropped?.backups ?? []) {
        try { fs.rmSync(backup, { force: true }); } catch { /* gone is fine */ }
      }
    }
    write(entries);
    return full;
  }

  /** Copy a file into data/undo/ so the previous version survives the write. */
  function backup(target) {
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > MAX_BACKUP_BYTES) return null;
      fs.mkdirSync(baseDir, { recursive: true });
      const dest = path.join(baseDir, `${nowId()}-${path.basename(target)}`);
      fs.copyFileSync(target, dest);
      return dest;
    } catch {
      return null;
    }
  }

  function entryCount() {
    return read().length;
  }

  // ── wrapped operations ────────────────────────────────────────────────────
  // Each one runs the real action first; only a successful action is journaled.

  async function wrapWrite(target, fn, { append = false } = {}) {
    let existed = false;
    try { existed = fs.statSync(target).isFile(); } catch { existed = false; }
    const backupPath = existed ? backup(target) : null;
    const result = await fn();
    record({
      kind: 'write',
      path: target,
      existed,
      append,
      backups: backupPath ? [backupPath] : [],
      undoable: !existed || Boolean(backupPath),
      label: `write ${path.basename(target)}`,
    });
    return result;
  }

  async function wrapMove(from, to, fn) {
    const result = await fn();
    record({ kind: 'move', from, to, undoable: true, label: `move ${path.basename(from)}` });
    return result;
  }

  async function wrapCopy(from, to, fn) {
    const result = await fn();
    record({ kind: 'copy', to, undoable: true, label: `copy ${path.basename(to)}` });
    return result;
  }

  async function wrapDelete(target, fn, { isDirectory = false } = {}) {
    const backupPath = isDirectory ? null : backup(target);
    const result = await fn();
    record({
      kind: 'delete',
      path: target,
      backups: backupPath ? [backupPath] : [],
      undoable: Boolean(backupPath),
      label: `delete ${path.basename(target)}`,
    });
    return result;
  }

  async function wrapMkdir(target, fn) {
    const result = await fn();
    record({ kind: 'mkdir', path: target, undoable: true, label: `mkdir ${path.basename(target)}` });
    return result;
  }

  async function wrapZip(out, fn) {
    const result = await fn();
    record({ kind: 'zip', out, undoable: true, label: `zip ${path.basename(out)}` });
    return result;
  }

  // ── undo ──────────────────────────────────────────────────────────────────

  /**
   * Undo the most recent undoable entry. Older entries that cannot be undone
   * are skipped and reported, so one weird op never blocks the whole feature.
   */
  async function undo() {
    const entries = read();
    const skipped = [];
    while (entries.length) {
      const entry = entries.pop();
      if (!entry.undoable) {
        skipped.push(entry);
        continue;
      }
      try {
        const how = restore(entry);
        write(entries);
        for (const backup of entry.backups ?? []) {
          try { fs.rmSync(backup, { force: true }); } catch { /* fine */ }
        }
        return { ok: true, entry, how, skipped };
      } catch (err) {
        // Put it back: a failed undo must not silently disappear from history.
        entries.push(entry);
        write(entries);
        return { ok: false, entry, error: err.message, skipped };
      }
    }
    write(entries);
    return { ok: false, entry: null, reason: skipped.length ? 'nothing undoable' : 'empty', skipped };
  }

  function restore(entry) {
    switch (entry.kind) {
      case 'write': {
        if (!entry.existed) {
          fs.rmSync(entry.path, { force: true });
          return 'file removed (it did not exist before)';
        }
        const backupPath = entry.backups?.[0];
        if (!backupPath) throw new Error('no backup of the previous content');
        fs.copyFileSync(backupPath, entry.path);
        return 'previous content restored';
      }
      case 'move': {
        if (!fs.existsSync(entry.to)) throw new Error(`${path.basename(entry.to)} is gone`);
        if (fs.existsSync(entry.from)) throw new Error(`${path.basename(entry.from)} already exists`);
        fs.renameSync(entry.to, entry.from);
        return `moved back to ${path.basename(entry.from)}`;
      }
      case 'copy': {
        fs.rmSync(entry.to, { recursive: true, force: true });
        return 'copy deleted';
      }
      case 'delete': {
        const backupPath = entry.backups?.[0];
        if (!backupPath) throw new Error('no backup (folder or file too big)');
        if (fs.existsSync(entry.path)) throw new Error(`${path.basename(entry.path)} exists again`);
        fs.mkdirSync(path.dirname(entry.path), { recursive: true });
        fs.copyFileSync(backupPath, entry.path);
        return `${path.basename(entry.path)} restored`;
      }
      case 'mkdir': {
        fs.rmdirSync(entry.path); // only works if still empty — exactly right
        return 'empty folder removed';
      }
      case 'zip': {
        fs.rmSync(entry.out, { force: true });
        return 'archive deleted';
      }
      default:
        throw new Error(`cannot undo ${entry.kind}`);
    }
  }

  /** WhatsApp-ready list of what /undo would walk back. */
  function describe(limit = 8) {
    const entries = read().slice(-limit).reverse();
    if (!entries.length) return '📓 Undo journal khali hai — abhi kuch badla nahi.';
    const lines = entries.map((e, i) => {
      const when = new Date(e.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      return `${i === 0 ? '↩️' : '•'} ${when} — ${e.label ?? e.kind}${e.undoable ? '' : ' _(undo nahi ho sakta)_'}`;
    });
    return `📓 *Undo journal* (${entries.length}${entryCount() > limit ? ` of ${entryCount()}` : ''})\n${lines.join('\n')}\n\n_Wapas karne ke liye: /undo_`;
  }

  return {
    dir: baseDir,
    file: journalFile,
    record,
    list: read,
    count: entryCount,
    wrapWrite,
    wrapMove,
    wrapCopy,
    wrapDelete,
    wrapMkdir,
    wrapZip,
    undo,
    describe,
    clear() { write([]); },
  };
}

/** Human line for the /undo reply. */
export function undoReply(result) {
  if (!result?.entry) {
    if (result?.reason === 'empty') return '📓 Undo journal khali hai — abhi kuch badla nahi.';
    return '🤷 Undo karne layak kuch nahi mila (purane kaam undo nahi ho sakte).';
  }
  const line = `↩️ *Undo ho gaya* — ${result.entry.label ?? result.entry.kind} → ${result.how}`;
  const tail = result.skipped?.length
    ? `\n_(${result.skipped.length} purane step skip kiye — unka backup nahi tha.)_`
    : '';
  return line + tail;
}
