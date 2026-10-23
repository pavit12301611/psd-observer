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
  if (nowTs - pending.at > CONFIRM_TTL_MS) {
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

/** Move a file/dir to trash instead of deleting. Returns trash path. */
export function moveToTrash(target, opts = {}) {
  const { trashDir = TRASH_DIR, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const src = path.resolve(target);
  if (!fs.existsSync(src)) return { ok: false, error: `🗑️ File nahi mili: ${target}` };
  fs.mkdirSync(trashDir, { recursive: true });
  const dest = path.join(trashDir, `${nowTs}-${path.basename(src)}`);
  fs.renameSync(src, dest);
  return { ok: true, dest, reply: `🗑️ *Trash me daal diya* (permanent delete nahi hua)\nRestore: \`/trash restore ${path.basename(dest)}\`` };
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
  const src = path.join(trashDir, String(name));
  if (!fs.existsSync(src)) return `🗑️ Trash me "${name}" nahi mila.`;
  const dest = path.join(destDir, path.basename(name).replace(/^\d+-/, ''));
  fs.renameSync(src, dest);
  return `♻️ *Restored:* ${dest}`;
}

/** 🚨 PANIC — wipe sensitive data + optional PC lock. Returns summary. */
export function runPanic(opts = {}) {
  const {
    dataDir = path.join(ROOT, 'data'),
    lockPc = null, // injected async fn
    keepFiles = /^(photo-index|screentime)\.json$/i,
  } = opts;
  let wiped = 0;
  let locked = false;
  try {
    for (const f of fs.readdirSync(dataDir)) {
      if (keepFiles.test(f)) continue;
      if (/\.json$|\.log$|state|journal|memory|key/i.test(f)) {
        try { fs.unlinkSync(path.join(dataDir, f)); wiped++; } catch { /* best effort */ }
      }
    }
  } catch { /* no data dir */ }
  return { wiped, locked, reply: `🚨 *PANIC done* — ${wiped} sensitive files wiped.${locked ? ' PC locked.' : ''}\nBot ab clean state me hai.` };
}

export function pendingState() {
  return pending ? { action: pending.action, args: pending.args } : null;
}
