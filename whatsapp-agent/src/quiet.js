// quiet.js — 🌙 Quiet hours + priority notifications: raat ko sirf
// emergency ping, baaki sab subah digest me. `/quiet 22:00-07:00` ·
// `/digest` · priority:true always goes through.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const QUIET_FILE = path.join(ROOT, 'data', 'quiet.json');

export function loadQuiet(file = QUIET_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { window: null, queue: [] }; // window = {startMin, endMin}
  }
}

function saveQuiet(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/** "22:00-07:00" → {startMin, endMin}; handles overnight windows. */
export function parseWindow(text) {
  const m = String(text ?? '').match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return {
    startMin: Number(m[1]) * 60 + Number(m[2]),
    endMin: Number(m[3]) * 60 + Number(m[4]),
  };
}

export function isQuiet(window, opts = {}) {
  const { now = Date.now, tzOffsetMin = 330 } = opts; // IST default
  if (!window) return false;
  const nowTs = typeof now === 'function' ? now() : now;
  const d = new Date(nowTs + tzOffsetMin * 60_000);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const { startMin, endMin } = window;
  return startMin <= endMin
    ? min >= startMin && min < endMin
    : min >= startMin || min < endMin; // overnight
}

export function setWindow(text, opts = {}) {
  const { file = QUIET_FILE } = opts;
  const window = parseWindow(text);
  if (!window) return '🌙 Usage: `/quiet 22:00-07:00`';
  const data = loadQuiet(file);
  data.window = window;
  saveQuiet(data, file);
  return `🌙 *Quiet hours set* — ${text}\n(non-priority yahan queue honge, subah digest milega)`;
}

export function clearWindow(opts = {}) {
  const { file = QUIET_FILE } = opts;
  const data = loadQuiet(file);
  data.window = null;
  saveQuiet(data, file);
  return '🌙 Quiet hours hata diye.';
}

/**
 * Decide send-now vs queue. Returns {send:bool, queued:bool, message?}.
 */
export function gate(text, opts = {}) {
  const { file = QUIET_FILE, priority = false, now = Date.now, tzOffsetMin = 330 } = opts;
  const data = loadQuiet(file);
  if (priority || !isQuiet(data.window, { now, tzOffsetMin })) {
    return { send: true, queued: false };
  }
  data.queue.push({ text: String(text), at: typeof now === 'function' ? now() : now });
  data.queue = data.queue.slice(-30);
  saveQuiet(data, file);
  return { send: false, queued: true, message: '🌙 Quiet hours me queue ho gaya — subah digest me aayega.' };
}

export function digest(opts = {}) {
  const { file = QUIET_FILE, clear = true } = opts;
  const data = loadQuiet(file);
  const items = data.queue;
  if (clear) {
    data.queue = [];
    saveQuiet(data, file);
  }
  if (!items.length) return '🌙 Digest khaali hai.';
  return `🌙 *Morning digest* (${items.length})\n${items.map((q, i) => `${i + 1}. ${q.text.slice(0, 120)}`).join('\n')}`;
}
