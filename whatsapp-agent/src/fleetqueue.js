// fleetqueue.js — 🖥️ Fleet remote commands: "/pcs ask <name> <cmd>" — command
// queue file me; target PC apne heartbeat loop me queue padhke chalata hai
// + result file likhta hai. Shared data/ folder = transport (git/ssh sync).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const QUEUE_DIR = path.join(ROOT, 'data', 'fleet');

export function queueFile(name) {
  return path.join(QUEUE_DIR, `${String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-')}.queue.json`);
}

export function resultFile(name) {
  return path.join(QUEUE_DIR, `${String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-')}.result.json`);
}

/** Enqueue a command for a PC (or 'all'). */
export function enqueue(name, cmd, opts = {}) {
  const { now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const qf = queueFile(name);
  try {
    fs.mkdirSync(path.dirname(qf), { recursive: true });
    let q = { items: [] };
    try { q = JSON.parse(fs.readFileSync(qf, 'utf8')); } catch { /* fresh */ }
    const item = { id: String(nowTs).slice(-6), cmd: String(cmd), at: nowTs };
    q.items.push(item);
    fs.writeFileSync(qf, JSON.stringify(q, null, 2));
    return { ok: true, item, reply: `🖥️ *${name}* ke queue me daal diya: \`/${item.cmd}\`\n(Dono PC sync hote hi chalega — ya \`/pcs check ${name}\` se poll karo)` };
  } catch (err) {
    return { ok: false, error: `🖥️ Queue fail: ${err?.message ?? err}` };
  }
}

/** Peek my own queue (target PC runs this on heartbeat). */
export function takeNext(name) {
  const qf = queueFile(name);
  try {
    const q = JSON.parse(fs.readFileSync(qf, 'utf8'));
    const item = q.items?.shift() ?? null;
    fs.writeFileSync(qf, JSON.stringify({ items: q.items ?? [] }, null, 2));
    return item;
  } catch {
    return null;
  }
}

export function postResult(name, id, output, opts = {}) {
  const { now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  try {
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    fs.writeFileSync(resultFile(name), JSON.stringify({ id, output: String(output ?? '').slice(0, 1500), at: nowTs }, null, 2));
    return true;
  } catch {
    return false;
  }
}

export function readResult(name) {
  try {
    return JSON.parse(fs.readFileSync(resultFile(name), 'utf8'));
  } catch {
    return null;
  }
}

export function checkResult(name, lastSeenId = null) {
  const r = readResult(name);
  if (!r) return `🖥️ *${name}* ka result abhi nahi aaya.`;
  if (r.id === lastSeenId) return `🖥️ *${name}* — wahi purana result (id ${r.id}).`;
  return `🖥️ *${name}* ka result (id ${r.id}):\n${r.output}`;
}
