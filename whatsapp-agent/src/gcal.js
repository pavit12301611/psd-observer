// gcal.js — 🗓️ Google Calendar sync (no OAuth!): pull via ICS feed URL
// (Google Calendar → Settings → "Secret address in iCal format"), push via
// exported .ics file (import in any calendar app). Two-way-ish, free.

import fs from 'node:fs';
import path from 'node:path';
import { loadCal, CAL_FILE, fmt } from './calendar.js';

/** Parse .ics text → [{uid, title, start(ms), end(ms)}]. */
export function parseICS(text) {
  const events = [];
  const s = String(text ?? '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); // unfold
  for (const block of s.split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0] ?? '';
    const uid = val(body, 'UID');
    const summary = val(body, 'SUMMARY');
    const dtStart = val(body, 'DTSTART');
    const dtEnd = val(body, 'DTEND');
    if (!dtStart) continue;
    const start = parseICSDate(dtStart);
    if (start == null) continue;
    const end = dtEnd ? parseICSDate(dtEnd) : start + 3600_000;
    events.push({ uid, title: summary ?? '(untitled)', start, end });
  }
  return events;
}

function val(block, key) {
  const m = block.match(new RegExp(`^${key}(?:;[^:]*)?:(.*)$`, 'mi'));
  return m ? m[1].trim() : null;
}

export function parseICSDate(s) {
  // 20261022T143000Z or 20261022 (all-day)
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', sec = '0', z] = m;
  return z
    ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec)
    : new Date(+y, +mo - 1, +d, +h, +mi, +sec).getTime();
}

/** Local calendar → .ics text (for import into Google). */
export function exportICS(events, opts = {}) {
  const { calName = 'PSD_Ai Calendar' } = opts;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//PSD_Ai//${calName}//EN`, `X-WR-CALNAME:${calName}`,
  ];
  for (const e of events ?? []) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id ?? `psd-${e.at ?? e.start}`}@psd-ai`,
      `DTSTAMP:${icsDate(Date.now())}`,
      `DTSTART:${icsDate(e.at ?? e.start)}`,
      `DTEND:${icsDate((e.at ?? e.start) + 3600_000)}`,
      `SUMMARY:${String(e.title ?? '').replace(/\n/g, ' ')}`,
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

export function icsDate(ts) {
  return `${new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}

/**
 * Pull ICS feed → merge into local calendar via addEvent (skip dupes by
 * title+time). `fetchText(url)` injected.
 */
export async function syncFromICS(url, opts = {}) {
  const { fetchText, file = CAL_FILE, now = Date.now } = opts;
  if (typeof fetchText !== 'function') return '🗓️ sync ke liye fetch chahiye.';
  let text;
  try {
    text = await fetchText(url);
  } catch (err) {
    return `🗓️ ICS feed nahi khula: ${err?.message ?? err}`;
  }
  const events = parseICS(text);
  if (!events.length) return '🗓️ ICS feed me koi event nahi mila.';
  const data = loadCal(file);
  const existing = new Set(data.events.map((e) => `${e.title}|${e.at}`));
  let added = 0;
  for (const e of events) {
    const key = `${e.title}|${e.start}`;
    if (existing.has(key)) continue;
    data.events.push({ id: `ics-${e.uid ?? e.start}`, at: e.start, title: e.title });
    added++;
  }
  data.events.sort((a, b) => a.at - b.at);
  fsync(data, file);
  return `🗓️ *Calendar sync done* — ${events.length} events mile, ${added} naye add hue.\nAaj: \`/cal today\` · Export: \`/cal export\``;
}

function fsync(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

export { fmt };
