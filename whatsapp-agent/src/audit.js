// audit.js — 📜 Audit log: kisne kab kya kiya (owner + guest attempts).
// `/audit [n]` — last n entries. Append-only JSONL (data/audit.jsonl).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const AUDIT_FILE = path.join(ROOT, 'data', 'audit.jsonl');
export const MAX_SHOW = 30;

export function logAudit(entry, opts = {}) {
  const { file = AUDIT_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: nowTs, ...entry })}\n`);
    return true;
  } catch {
    return false;
  }
}

export function readAudit(opts = {}) {
  const { file = AUDIT_FILE, limit = MAX_SHOW } = opts;
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function auditReply(opts = {}) {
  const { limit = 15 } = opts;
  const entries = readAudit({ ...opts, limit });
  if (!entries.length) return '📜 Audit log khaali hai.';
  const rows = entries.reverse().map((e) => {
    const t = new Date(e.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return `• ${t} · ${e.who ?? 'owner'} · ${e.cmd ?? e.event ?? '?'}${e.ok === false ? ' ❌' : ''}`;
  });
  return `📜 *Audit log* (last ${entries.length})\n${rows.join('\n')}`;
}
