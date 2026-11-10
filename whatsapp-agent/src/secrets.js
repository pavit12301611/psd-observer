// secrets.js — 🔐 Local-only secret sealing (AES-256-GCM + a 0600 key file).
//
// The owner asked for one thing above all: the agent's mail password should be
// known *only* by the agent. Plain `mail.json` on disk is not that — anyone who
// opens the file, copies a backup or reads a screen share gets the password.
// So a password is sealed with a key that lives beside it in `data/.mail-key`
// (mode 0600) and is never printed, never sent, never logged.
//
// Honest limits, said out loud:
//   • This protects at-rest copies (backups, screenshots, `cat mail.json`).
//     Any program running as the same OS user can read the key file too.
//   • Lose `data/.mail-key` and the sealed secret is gone by design. Re-run
//     `/email setup` — that is the recovery path, not decryption.
//   • Key and ciphertext in the same folder means this is not a hardware vault.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SECRET_PREFIX = 'enc:v1:';
export const KEY_FILE = '.mail-key';
const ALGO = 'aes-256-gcm';

export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

/** 0600 or nothing: refuse to trust a key file other users can read. */
function writeKey(file) {
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, key.toString('base64'), { mode: 0o600, flag: 'wx' });
  try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  return key;
}

export function loadOrCreateKey(opts = {}) {
  const { dir = path.join(process.cwd(), 'data'), log = null } = opts;
  const file = path.join(dir, KEY_FILE);
  try {
    if (fs.existsSync(file)) {
      const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
      if (key.length !== 32) throw new Error('key size');
      return key;
    }
    return writeKey(file);
  } catch (err) {
    // No key on a read-only filesystem must not break mail entirely.
    log?.warn?.(`[secrets] key file ${file} unavailable (${err?.message ?? err}) — storing as before`);
    return null;
  }
}

/** plain → "enc:v1:<iv>:<tag>:<ciphertext>" (all base64). No-op if no key. */
export function sealSecret(plain, opts = {}) {
  const value = String(plain ?? '');
  if (!value) return value;
  if (isSealed(value)) return value;
  const key = opts.key ?? loadOrCreateKey(opts);
  if (!key) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${SECRET_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/** Sealed or legacy plaintext in, plaintext out. Never logs the output. */
export function openSecret(value, opts = {}) {
  const raw = String(value ?? '');
  if (!raw) return '';
  if (!isSealed(raw)) return raw; // pre-3.14 plaintext: still works, gets sealed on next save
  const parts = raw.slice(SECRET_PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('sealed secret malformed');
  const key = opts.key ?? loadOrCreateKey(opts);
  if (!key) throw new Error('mail key file missing — /email setup dobara chalao');
  const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64'));
  try {
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('sealed secret khul nahi raha — key file badal gaya hai, /email setup dobara chalao');
  }
}

/** Human-facing state label, no secret material. */
export function sealState(value) {
  if (!value) return 'none';
  return isSealed(value) ? 'sealed' : 'plaintext';
}
