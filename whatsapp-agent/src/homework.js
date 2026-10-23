// homework.js — 📝 Homework/Deadline Tracker: "/hw add maths pg 42 kal",
// "/hw today", "/hw week". Built on the tiny calendar parser — deadlines get
// due dates, and the daily 7AM brief picks up due-soon homework.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWhen, fmt } from './calendar.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HW_FILE = path.join(ROOT, 'data', 'homework.json');
const DAY = 24 * 60 * 60 * 1000;

export function loadHw(file = HW_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { items: [] };
  }
}

function saveHw(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/** "/hw add maths pg 42 kal" → due date from the tail words. */
export function addHw(text, opts = {}) {
  const { file = HW_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: '📝 Usage: `/hw add <kaam> <due>` — e.g. `/hw add maths pg 42 kal`' };
  const parsed = parseWhen(raw, nowTs);
  // If no when-words matched, everything is the title and due = end of today.
  const hasWhen = /\b(kal|tomorrow|aaj|today|pars?o|day after|mon|tue|wed|thu|fri|sat|sun|in \d+|\d{1,2} (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec))\b/i.test(raw);
  const title = (hasWhen ? parsed.rest : raw) || raw;
  const at = hasWhen && parsed.at ? parsed.at : nowTs + 6 * 3600_000; // default: tonight
  const data = loadHw(file);
  const item = { id: String(nowTs).slice(-8), title, at, done: false };
  data.items.push(item);
  data.items.sort((a, b) => a.at - b.at);
  saveHw(data, file);
  return { ok: true, item, reply: `📝 *Added:* ${title} — due ${fmt(at)}` };
}

export function doneHw(id, opts = {}) {
  const { file = HW_FILE } = opts;
  const data = loadHw(file);
  let hit = false;
  for (const item of data.items) {
    if (!item.done && (item.id.endsWith(String(id)) || item.title.includes(id))) {
      item.done = true;
      hit = true;
    }
  }
  saveHw(data, file);
  return hit ? '📝 ✅ Marked done!' : '📝 Koi matching homework nahi mila.';
}

export function openItems(file = HW_FILE) {
  return loadHw(file).items.filter((i) => !i.done);
}

export function todayReply(opts = {}) {
  const { file = HW_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const due = openItems(file).filter((i) => i.at <= nowTs + 2 * DAY); // today + tomorrow
  const overdue = due.filter((i) => i.at < nowTs);
  if (!due.length) return '📝 Aaj/kal koi homework due nahi. 🎉';
  return `📝 *Homework — due soon*\n${due.map((i) => `  ${i.at < nowTs ? '🔴 OVERDUE' : '🟡'} ${i.title} — ${fmt(i.at)}`).join('\n')}${overdue.length ? `\n\n⚠️ ${overdue.length} overdue hai — jaldi finish karo!` : ''}`;
}

export function weekReply(opts = {}) {
  const { file = HW_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const items = openItems(file).filter((i) => i.at <= nowTs + 7 * DAY);
  if (!items.length) return '📝 Agle 7 din koi homework nahi.';
  return `📝 *Homework — next 7 days*\n${items.map((i) => `  • ${i.title} — ${fmt(i.at)}`).join('\n')}`;
}
