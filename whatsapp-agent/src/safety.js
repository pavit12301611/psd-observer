// safety.js — 🔒 Destructive-action safety:
//   1. /rm & /kill pe double-confirm (token system) — galti se delete nahi.
//   2. delete → TRASH (recoverable), permanent wipe sirf /trash empty se.
//   3. /panic — ek message pe bot lock + sensitive data wipe (kill-switch).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TRASH_DIR = path.join(ROOT, 'data', 'trash');
export const CONFIRM_TTL_MS = 5 * 60_000;

let pending = null; // {token, action, args, at}

export function isDestructive(cmd) {
  return /^(rm|kill|unlearn|del|delete|format)$/i.test(String(cmd ?? ''));
}

export function requestConfirm(action, args, opts = {}) {
  const { now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const token = crypto.randomBytes(2).toString('hex');
  pending = { token, action: String(action), args: String(args ?? ''), at: nowTs };
  return `🔒 *Pakka?* — \`/${pending.action} ${pending.args}\` chalega.\nConfirm: \`/confirm ${token}\` · Cancel: \`/cancel\``;
}

export function confirmPending(token, opts = {}) {
  const { now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  if (!pending) return { ok: false, error: '🔒 Koi pending action nahi hai.' };
  if (!Number.isFinite(nowTs - pending.at) || nowTs < pending.at || nowTs - pending.at >= CONFIRM_TTL_MS) {
    pending = null;
    return { ok: false, error: '🔒 Confirm expire ho gaya (5 min). Dobara bhejo.' };
  }
  const t = String(token).trim().toLowerCase();
  const affirmed = ['yes', 'y', 'ya', 'haan', 'han', 'ha', 'confirm', 'karo'].includes(t);
  if (t !== pending.token.toLowerCase() && !affirmed) {
    return { ok: false, error: '🔒 Token galat hai.' };
  }
  const out = { ok: true, action: pending.action, args: pending.args };
  pending = null;
  return out;
}

export function cancelPending() {
  if (!pending) return '🔒 Kuch pending tha hi nahi.';
  pending = null;
  return '🗑️ Action cancel kar diya.';
}

// Resolve existing ancestors too, so a symlink cannot hide a trash directory
// inside the very tree being moved. Do not dereference a trashed symlink itself.
function realPath(file) {
  try { return fs.realpathSync(file); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    const parent = path.dirname(file);
    if (parent === file) throw err;
    return path.join(realPath(parent), path.basename(file));
  }
}

function moveWithoutClobber(src, dest) {
  const directory = fs.lstatSync(src).isDirectory();
  let owned = false;
  try {
    if (directory) fs.mkdirSync(dest, { mode: 0o700 });
    else fs.closeSync(fs.openSync(dest, 'wx', 0o600));
    owned = true;
    fs.renameSync(src, dest);
    owned = false;
  } finally {
    // Only remove the empty reservation we created, never existing data.
    if (owned) { try { if (directory) fs.rmdirSync(dest); else fs.unlinkSync(dest); } catch { /* preserve on failure */ } }
  }
}

/** Same-filesystem recoverable move. Cross-device failures leave source intact. */
export function moveToTrash(target, opts = {}) {
  const { trashDir = TRASH_DIR, now = Date.now } = opts;
  try {
    const nowTs = typeof now === 'function' ? now() : now;
    if (!Number.isSafeInteger(nowTs) || nowTs < 0) throw new Error('Invalid trash timestamp');
    const src = path.resolve(target), trash = path.resolve(trashDir), stat = fs.lstatSync(src);
    if (stat.isDirectory()) {
      const relative = path.relative(fs.realpathSync(src), realPath(trash));
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Trash cannot be inside the target directory');
    }
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    for (let i = 0; i < 1000; i++) {
      const dest = path.join(trash, `${nowTs + i}-${path.basename(src)}`);
      try {
        moveWithoutClobber(src, dest);
        return { ok: true, dest, reply: `🗑️ *Trash me daal diya* (permanent delete nahi hua)\nRestore: \`/trash restore ${path.basename(dest)}\`` };
      } catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    throw new Error('Too many colliding trash entries; nothing moved');
  } catch (err) { return { ok: false, error: `🗑️ ${err.code === 'ENOENT' ? `File nahi mili: ${target}` : err.message}` }; }
}

export function listTrash(trashDir = TRASH_DIR) {
  try {
    const items = fs.readdirSync(trashDir);
    return items.length
      ? `🗑️ *Trash* (${items.length})\n${items.map((i) => `• ${i}`).join('\n')}\n\nRestore: \`/trash restore <name>\` · Empty: \`/trash empty\``
      : '🗑️ Trash khaali hai.';
  } catch {
    return '🗑️ Trash khaali hai.';
  }
}

export function restoreTrash(name, opts = {}) {
  const { trashDir = TRASH_DIR, destDir = process.env.HOME ?? ROOT } = opts;
  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[/\\\0]/.test(name)) return '🗑️ Invalid trash entry name (use a name from /trash).';
  const restoredName = name.replace(/^\d+-/, '');
  if (!restoredName || restoredName === '.' || restoredName === '..') return '🗑️ Invalid restored filename.';
  const src = path.join(path.resolve(trashDir), name), dest = path.join(path.resolve(destDir), restoredName);
  try {
    moveWithoutClobber(src, dest);
    return `♻️ *Restored:* ${dest}`;
  } catch (err) {
    return err.code === 'EEXIST' ? '🗑️ Destination already exists; nothing overwritten. Move/rename that file first.'
      : `🗑️ Restore nahi hua: ${err.message}`;
  }
}

/** Filesystem unlink is NOT secure erasure and cannot retract remote copies. */
export function runPanic(opts = {}) {
  const { dataDir = path.join(ROOT, 'data'), store = null, keepFiles = /^(photo-index|screentime)\.json$/i } = opts;
  let wiped = 0, memoryCleared = false;
  const failures = [];
  // Cancel a pending debounced save BEFORE removing its on-disk state.
  if (store) {
    try { store.reset(); memoryCleared = true; }
    catch (err) { failures.push(`owner-memory reset: ${err.message}`); }
  }
  pending = null;
  try {
    for (const f of fs.readdirSync(dataDir)) {
      keepFiles.lastIndex = 0;
      if (keepFiles.test(f)) continue;
      if (/\.json$|\.log$|state|journal|memory|key/i.test(f)) {
        try { fs.unlinkSync(path.join(dataDir, f)); wiped++; }
        catch (err) { failures.push(`${f}: ${err.code ?? 'not removed'}`); }
      }
    }
  } catch (err) { if (err.code !== 'ENOENT') failures.push(`data directory: ${err.code ?? err.message}`); }
  return { wiped, locked: false, memoryCleared, failures, reply: `🚨 *PANIC* — ${wiped} sensitive files removed.${memoryCleared ? ' Owner history/facts reset; pending saves cancelled.' : ''}${failures.length ? `\n⚠️ Not fully cleared: ${failures.join('; ')}` : ''}\nLocal unlink only — not secure erase or deletion of external copies.` };
}

export function pendingState({ now = Date.now } = {}) {
  const ts = typeof now === 'function' ? now() : now;
  if (pending && (!Number.isFinite(ts - pending.at) || ts < pending.at || ts - pending.at >= CONFIRM_TTL_MS)) pending = null;
  return pending ? { action: pending.action, args: pending.args } : null;
}

/** Mobile approval identity; opaque nonce binds identical re-created requests. */
export function pendingTicket() {
  if (!pendingState()) return null;
  return { action: pending.action, args: pending.args, at: pending.at,
    nonce: crypto.createHash('sha256').update(`${pending.token}\0${pending.at}`).digest('hex') };
}
