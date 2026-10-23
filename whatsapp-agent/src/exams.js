// exams.js — 🎓 Exam countdown + auto-scheduler: "/exam add physics 12 dec"
// → countdown, /today me jhalak, aur /study priorities ke liye days-left.
// Pure + injected now; state in data/exams.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXAM_FILE = path.join(ROOT, 'data', 'exams.json');

export function loadExams(file = EXAM_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { exams: [] };
  }
}

function saveExams(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "/exam add physics 12 dec" or "physics 2026-12-12" → {subject, at}. */
export function parseExam(text, now = Date.now()) {
  const nowTs = typeof now === 'function' ? now() : now;
  const s = String(text ?? '').trim();
  const iso = s.match(/^(.+?)\s+(\d{4}-\d{2}-\d{2})$/);
  if (iso) {
    return { subject: iso[1].trim(), at: new Date(`${iso[2]}T09:00:00`).getTime() };
  }
  const m = s.match(/^(.+?)\s+(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i);
  if (!m) return null;
  const base = new Date(nowTs);
  let year = base.getFullYear();
  const at = new Date(year, MONTHS[m[3].toLowerCase()], Number(m[2]), 9, 0).getTime();
  if (at < nowTs - 86_400_000) year += 1;
  return { subject: m[1].trim(), at: new Date(year, MONTHS[m[3].toLowerCase()], Number(m[2]), 9, 0).getTime() };
}

export function addExam(text, opts = {}) {
  const { file = EXAM_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const parsed = parseExam(text, nowTs);
  if (!parsed) return { ok: false, error: '🎓 Usage: `/exam add <subject> <date>` — e.g. `/exam add physics 12 dec`' };
  const data = loadExams(file);
  data.exams = data.exams.filter((e) => e.subject.toLowerCase() !== parsed.subject.toLowerCase());
  data.exams.push({ ...parsed, id: String(nowTs).slice(-6) });
  data.exams.sort((a, b) => a.at - b.at);
  saveExams(data, file);
  return { ok: true, reply: `🎓 *${parsed.subject}* exam — ${new Date(parsed.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} (${daysLeft(parsed.at, nowTs)} din baaki)` };
}

export function daysLeft(at, now = Date.now()) {
  const nowTs = typeof now === 'function' ? now() : now;
  return Math.max(0, Math.ceil((at - nowTs) / 86_400_000));
}

/** Countdown lines — nearest exams first. */
export function examCountdownReply(opts = {}) {
  const { file = EXAM_FILE, now = Date.now, limit = 5 } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const upcoming = loadExams(file).exams.filter((e) => e.at > nowTs - 86_400_000).slice(0, limit);
  if (!upcoming.length) return null;
  const rows = upcoming.map((e) => {
    const d = daysLeft(e.at, nowTs);
    const bar = '█'.repeat(Math.min(12, Math.max(0, 12 - Math.floor(d / 3))));
    return `  • ${e.subject}: ${d} din ${bar}`;
  });
  return `🎓 *Exams*\n${rows.join('\n')}`;
}

/** Which subject is most urgent (for /study auto-priority). */
export function nextExam(opts = {}) {
  const { file = EXAM_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  return loadExams(file).exams.find((e) => e.at > nowTs) ?? null;
}

export function removeExam(subject, opts = {}) {
  const { file = EXAM_FILE } = opts;
  const data = loadExams(file);
  const before = data.exams.length;
  data.exams = data.exams.filter((e) => e.subject.toLowerCase() !== String(subject).toLowerCase());
  saveExams(data, file);
  return data.exams.length < before ? `🎓 ${subject} hata diya.` : '🎓 Wo exam list me nahi mila.';
}
