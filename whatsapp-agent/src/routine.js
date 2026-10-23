// routine.js — ⏰ Auto-routines: "/routine at 7am morning" — saved macro ko
// time pe khud chalao (cron job ke through). `/routine save morning` macro
// se pehle /savemacro se banao.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROUTINE_FILE = path.join(ROOT, 'data', 'routines.json');

export function loadRoutines(file = ROUTINE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { routines: [] };
  }
}

function saveRoutines(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/** "at 7am morning" / "roz 8:30 gym-check" → {time, name, scheduleRaw}. */
export function parseRoutine(text) {
  const m = String(text ?? '').match(/^(?:at|roz|daily)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s+([\w-]+)$/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = (m[3] ?? '').toLowerCase();
  if (ampm === 'pm' && hour < 12) hour += 12;
  if (ampm === 'am' && hour === 12) hour = 0;
  return { hour, minute, name: m[4].toLowerCase(), timeLabel: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}` };
}

export function addRoutine(text, opts = {}) {
  const { file = ROUTINE_FILE } = opts;
  const parsed = parseRoutine(text);
  if (!parsed) return { ok: false, error: '⏰ Usage: `/routine at 7am <macro-name>` (macro pehle /savemacro se banao)' };
  const data = loadRoutines(file);
  data.routines = data.routines.filter((r) => r.name !== parsed.name);
  data.routines.push({ ...parsed, id: String(Date.now()).slice(-6) });
  saveRoutines(data, file);
  return {
    ok: true,
    routine: parsed,
    reply: `⏰ *Routine set* — roz ${parsed.timeLabel} pe \`/${parsed.name}\` khud chalega.\nList: \`/routine list\` · Off: \`/routine off ${parsed.name}\``,
  };
}

export function removeRoutine(name, opts = {}) {
  const { file = ROUTINE_FILE } = opts;
  const data = loadRoutines(file);
  const before = data.routines.length;
  data.routines = data.routines.filter((r) => r.name !== String(name).toLowerCase());
  saveRoutines(data, file);
  return data.routines.length < before ? `⏰ Routine ${name} hata diya.` : '⏰ Wo routine nahi mili.';
}

/** Routines due at this hour:minute (cron-hook friendly). */
export function dueRoutines(opts = {}) {
  const { file = ROUTINE_FILE, now = Date.now, toleranceMin = 2 } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const d = new Date(nowTs + 330 * 60_000); // IST
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return loadRoutines(file).routines.filter((r) => Math.abs(r.hour * 60 + r.minute - mins) <= toleranceMin);
}

export function routineList(opts = {}) {
  const data = loadRoutines(opts.file ?? ROUTINE_FILE);
  return data.routines.length
    ? `⏰ *Routines*\n${data.routines.map((r) => `• ${r.timeLabel} → /${r.name}`).join('\n')}`
    : '⏰ Koi routine nahi. Set: `/routine at 7am <macro-name>`';
}
