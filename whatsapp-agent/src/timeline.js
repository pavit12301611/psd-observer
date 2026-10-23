// timeline.js — 🕒 Screenshot visual timeline: "dopahar 3 baje screen pe kya
// tha?" — timestamps + lazy-OCR index. Opt-in (`/timeline on`) — janitor ke
// saath rehta hai; sirf index yaad rehta hai. Privacy: index PC pe hi.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TL_FILE = path.join(ROOT, 'data', 'timeline.json');
export const MAX_ENTRIES = 500;

export function loadTimeline(file = TL_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { enabled: false, entries: [] };
  }
}

function saveTimeline(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/** Record a shot (OCR text optional — filled lazily later). */
export function recordShot(buffer, opts = {}) {
  const { file = TL_FILE, now = Date.now, text = null, label = null } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const data = loadTimeline(file);
  if (!data.enabled) return false;
  data.entries.push({ at: nowTs, text, label, size: buffer?.length ?? 0 });
  if (data.entries.length > MAX_ENTRIES) data.entries = data.entries.slice(-MAX_ENTRIES);
  saveTimeline(data, file);
  return true;
}

/** Backfill OCR text for entries missing it. `ocr(buffer)` injected. */
export function indexText(entry, text) {
  entry.text = String(text ?? '').slice(0, 500);
}

/** Find what was on screen around a time. `hh:mm` or "3pm". */
export function timelineQuery(query, opts = {}) {
  const { file = TL_FILE, now = Date.now, windowMin = 45 } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const data = loadTimeline(file);
  const m = String(query ?? '').match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  let target = nowTs;
  if (m) {
    let hour = Number(m[1]);
    const a = (m[3] ?? '').toLowerCase();
    if (a === 'pm' && hour < 12) hour += 12;
    if (a === 'am' && hour === 12) hour = 0;
    // local-time target (server TZ = owner's TZ in practice)
    const d = new Date(nowTs);
    target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, Number(m[2] ?? 0)).getTime();
  }
  const from = target - windowMin * 60_000;
  const to = target + windowMin * 60_000;
  return data.entries.filter((e) => e.at >= from && e.at <= to);
}

export function timelineReply(query, opts = {}) {
  const hits = timelineQuery(query, opts);
  if (!hits.length) return '🕒 Us time ka kuch record nahi mila (timeline on tha bhi?). `/timeline on` · `/timeline 3pm`';
  const rows = hits.map((e) => {
    const t = new Date(e.at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
    return `• ${t} — ${e.text ? e.text.slice(0, 70) : '(shot, OCR pending)'}`;
  });
  return `🕒 *Screen timeline*\n${rows.join('\n')}`;
}

export function setTimeline(enabled, opts = {}) {
  const { file = TL_FILE } = opts;
  const data = loadTimeline(file);
  data.enabled = enabled;
  saveTimeline(data, file);
  return enabled
    ? '🕒 Timeline *ON* — shots ka index yahan (sirf PC pe). Query: `/timeline 3pm`'
    : '🕒 Timeline *OFF*.';
}
