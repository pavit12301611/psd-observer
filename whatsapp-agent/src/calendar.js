// calendar.js — 🗓️ Calendar + events: "/cal add kal 4pm meeting", "/cal
// today", "/cal week". Reminders come from the existing cron loop — this is
// the calendar brain: parse when, store events, answer "kya hai kal?".
//
//   /cal add <when> <title>   ·  /cal today  ·  /cal week  ·  /cal del <id>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CAL_FILE = path.join(ROOT, 'data', 'calendar.json');
const DAY = 24 * 60 * 60 * 1000;

export function loadCal(file = CAL_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { events: [] };
  }
}

function saveCal(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/**
 * Tiny when-parser: "kal 4pm", "tomorrow 16:30", "in 2h", "friday 10am",
 * "25 dec 5pm", "aaj 9pm". Returns { at, rest } or null.
 */
export function parseWhen(text, now = Date.now()) {
  let s = String(text ?? '').trim();
  const base = new Date(now);
  let dayShift = 0;
  let hour = null;
  let minute = 0;

  const timeM = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i) || s.match(/\b(\d{1,2}):(\d{2})\b/);
  if (timeM) {
    hour = Number(timeM[1]);
    minute = Number(timeM[2] ?? 0);
    const ampm = (timeM[3] ?? '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    s = s.replace(timeM[0], ' ').trim();
  }

  const relH = s.match(/\bin\s+(\d+)\s*h(?:ours?)?\b/i);
  if (relH) {
    const at = now + Number(relH[1]) * 60 * 60 * 1000;
    return { at, rest: s.replace(relH[0], ' ').trim() };
  }
  const relM = s.match(/\bin\s+(\d+)\s*m(?:in(?:utes?)?)?\b/i);
  if (relM) {
    const at = now + Number(relM[1]) * 60 * 1000;
    return { at, rest: s.replace(relM[0], ' ').trim() };
  }

  if (/\b(kal|tomorrow)\b/i.test(s)) dayShift = 1;
  else if (/\b(aaj|today)\b/i.test(s)) dayShift = 0;
  else if (/\b(pars?o|day after)\b/i.test(s)) dayShift = 2;
  else {
    const wd = s.match(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i);
    if (wd) {
      const map = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
      const target = map[wd[1].toLowerCase().slice(0, 3)];
      dayShift = (target - base.getDay() + 7) % 7 || 7;
      s = s.replace(wd[0], ' ').trim();
    } else {
      const dm = s.match(/\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i);
      if (dm) {
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const d = new Date(base.getFullYear(), months[dm[2].toLowerCase()], Number(dm[1]), hour ?? 9, minute);
        if (d.getTime() < now) d.setFullYear(d.getFullYear() + 1);
        return { at: d.getTime(), rest: s.replace(dm[0], ' ').trim() };
      }
    }
  }
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayShift, hour ?? 9, minute);
  return { at: d.getTime(), rest: s.replace(/\b(kal|tomorrow|aaj|today|pars?o|day after)\b/gi, ' ').replace(/\s+/g, ' ').trim() };
}

export function addEvent(text, opts = {}) {
  const { file = CAL_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const parsed = parseWhen(text, nowTs);
  if (!parsed || !parsed.rest) return { ok: false, error: '🗓️ Usage: `/cal add <when> <title>` — e.g. `/cal add kal 4pm meeting with sir`' };
  const data = loadCal(file);
  const event = { id: `${nowTs}-${Math.floor(Math.random() * 9999)}`, at: parsed.at, title: parsed.rest };
  data.events.push(event);
  data.events.sort((a, b) => a.at - b.at);
  saveCal(data, file);
  return { ok: true, event, reply: `🗓️ Added: *${event.title}* — ${fmt(event.at)}` };
}

export function fmt(ts) {
  return new Date(ts).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
  });
}

export function eventsBetween(fromTs, toTs, file = CAL_FILE) {
  return loadCal(file).events.filter((e) => e.at >= fromTs && e.at <= toTs);
}

export function todayReply(opts = {}) {
  const { file = CAL_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const d = new Date(nowTs);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const events = eventsBetween(start, start + DAY - 1, file);
  if (!events.length) return '🗓️ Aaj koi event nahi. 🎉';
  return `🗓️ *Aaj ke events*\n${events.map((e) => `• ${fmt(e.at)} — ${e.title}`).join('\n')}`;
}

export function weekReply(opts = {}) {
  const { file = CAL_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const events = eventsBetween(nowTs, nowTs + 7 * DAY, file);
  if (!events.length) return '🗓️ Agle 7 din koi event nahi.';
  return `🗓️ *Agle 7 din*\n${events.map((e) => `• ${fmt(e.at)} — ${e.title}`).join('\n')}`;
}

export function delEvent(id, opts = {}) {
  const { file = CAL_FILE } = opts;
  const data = loadCal(file);
  const before = data.events.length;
  data.events = data.events.filter((e) => !String(e.id).endsWith(String(id)) && e.title !== id);
  saveCal(data, file);
  return data.events.length < before
    ? '🗓️ Event hata diya.'
    : '🗓️ Koi matching event nahi mila.';
}
