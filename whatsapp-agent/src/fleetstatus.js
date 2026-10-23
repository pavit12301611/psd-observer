// fleetstatus.js — 🖥️ Fleet: `/pcs` shows every registered PC + heartbeat
// liveness. `/pcs register <name>` registers THIS machine with a heartbeat
// file; `/pcs` reports each machine's last-seen + status. Nothing polls the
// network — each machine writes its own heartbeat; the shared data dir IS
// the registry (synced however the user syncs: git/ssh/Drive).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FLEET_DIR = path.join(ROOT, 'data', 'fleet');
export const HEARTBEAT_TTL_MS = 2 * 60_000;

export function heartbeatFile(name) {
  return path.join(FLEET_DIR, `${String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-')}.json`);
}

export function registerPc(name, opts = {}) {
  const { file = heartbeatFile(name) } = opts;
  if (!String(name ?? '').trim()) return '🖥️ Usage: `/pcs register <name>`';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name, os: os.platform(), at: Date.now() }));
  } catch (err) {
    return `🖥️ Register nahi hua: ${err?.message ?? err}`;
  }
  return `🖥️ *${name}* registered! Ab \`/pcs\` me dikhega. Heartbeat update karna ho to phir se \`/pcs register ${name}\` chalao (ya observer heartbeat se auto).`;
}

export function beat(name, opts = {}) {
  const { file = heartbeatFile(name), now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ name, os: os.platform(), at: nowTs }));
    return true;
  } catch {
    return false;
  }
}

export function listPcs(opts = {}) {
  const { dir = FLEET_DIR, now = Date.now, ttl = HEARTBEAT_TTL_MS } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((f) => {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const ageMs = nowTs - raw.at;
      return {
        name: raw.name ?? f.replace('.json', ''),
        os: raw.os ?? '?',
        at: raw.at,
        alive: ageMs <= ttl,
        agoMin: Math.max(0, Math.round(ageMs / 60_000)),
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => Number(b.alive) - Number(a.alive));
}

export function fleetReply(opts = {}) {
  const pcs = listPcs(opts);
  if (!pcs.length) {
    return '🖥️ Fleet khaali hai. Kisi PC ko add karo: us PC pe `/pcs register <name>` chalao.';
  }
  const rows = pcs.map((p) => `  ${p.alive ? '🟢' : '🔴'} *${p.name}* (${p.os}) — ${p.alive ? 'abhi active' : `last seen ${p.agoMin}m ago`}`);
  const alive = pcs.filter((p) => p.alive).length;
  return `🖥️ *Fleet status* — ${alive}/${pcs.length} online\n${rows.join('\n')}`;
}

export function removePc(name, opts = {}) {
  const { file = heartbeatFile(name) } = opts;
  try {
    fs.unlinkSync(file);
    return `🖥️ *${name}* fleet se hata diya.`;
  } catch {
    return `🖥️ *${name}* fleet me mila hi nahi.`;
  }
}
