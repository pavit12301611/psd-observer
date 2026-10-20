// brief.js — ek message me din ki poori tasveer.
//
//   /brief                  → abhi ka brief
//   /brief on 9am           → roz subah 9 baje khud aayega (cron job bana deta hai)
//   /brief off
//
// Sab kuch local se banta hai (store + /proc), isliye offline bhi chalta hai:
// aaj ke reminders, overdue kaam, todos, cron jobs, disk, battery, uptime,
// chalu watchers, aur pichhli baar adhoora chhoda hua task.
//
// AI sirf tab lagta hai jab tum `weather` bhi maango — warna zero tokens.

import os from 'node:os';
import fs from 'node:fs';
import { batteryStatus, humanDuration } from './tools.js';
import { watchers } from './watch.js';

function diskFree() {
  try {
    const stat = fs.statfsSync(os.homedir());
    return { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize };
  } catch {
    return null;
  }
}

const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

function startOfDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function greeting(now = new Date()) {
  const h = now.getHours();
  if (h < 5) return '🌙 Raat ka waqt';
  if (h < 12) return '☀️ Subah bakhair';
  if (h < 17) return '🌤️ Namaste';
  if (h < 21) return '🌆 Shaam bakhair';
  return '🌙 Namaste';
}

/**
 * Build the brief. Everything is injected (`now`, `store`) so the output is
 * deterministic in tests and identical on any PC.
 */
export function buildBrief({ store, config = {}, now = Date.now(), tz = config.timezone ?? 'Asia/Kolkata' } = {}) {
  const data = store?.data ?? {};
  const today0 = startOfDay(now);
  const dayMs = 86_400_000;
  const lines = [];
  let pendingItems = 0;

  const dateLine = new Date(now).toLocaleDateString('en-IN', {
    timeZone: tz, weekday: 'long', day: 'numeric', month: 'long',
  });
  const timeLine = new Date(now).toLocaleTimeString('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  lines.push(`*${greeting(new Date(now))} — ${dateLine}*`, `_${timeLine}_`, '');

  // ── reminders ────────────────────────────────────────────────────────────
  const reminders = (data.reminders ?? []).slice().sort((a, b) => a.dueTs - b.dueTs);
  const overdue = reminders.filter((r) => r.dueTs < now);
  const dueToday = reminders.filter((r) => r.dueTs >= now && r.dueTs < today0 + dayMs);
  if (overdue.length) {
    pendingItems += 1;
    lines.push(`🔴 *Overdue* (${overdue.length})`);
    for (const r of overdue.slice(0, 4)) lines.push(`• ${r.text} — ${humanDuration(now - r.dueTs)} pehle`);
    lines.push('');
  }
  if (dueToday.length) {
    pendingItems += 1;
    lines.push(`⏰ *Aaj* (${dueToday.length})`);
    for (const r of dueToday.slice(0, 6)) {
      const t = new Date(r.dueTs).toLocaleTimeString('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      lines.push(`• ${t} — ${r.text}`);
    }
    lines.push('');
  }

  // ── todos ────────────────────────────────────────────────────────────────
  const openTodos = (data.todos ?? []).filter((t) => !t.done);
  if (openTodos.length) {
    pendingItems += 1;
    lines.push(`✅ *Kaam* (${openTodos.length} baaki)`);
    for (const t of openTodos.slice(0, 5)) lines.push(`• ${t.text}`);
    if (openTodos.length > 5) lines.push(`_…aur ${openTodos.length - 5}_`);
    lines.push('');
  }

  // ── scheduled jobs that fire today ───────────────────────────────────────
  const jobs = (data.cronJobs ?? []).filter((j) => j.nextDueTs && j.nextDueTs < today0 + dayMs && j.nextDueTs >= now);
  if (jobs.length) {
    pendingItems += 1;
    lines.push(`🔁 *Aaj scheduled* (${jobs.length})`);
    for (const j of jobs.slice(0, 5)) {
      const t = new Date(j.nextDueTs).toLocaleTimeString('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
      lines.push(`• ${t} — ${j.text.slice(0, 60)}`);
    }
    lines.push('');
  }

  // ── watchers ─────────────────────────────────────────────────────────────
  const watching = watchers(store);
  if (watching.length) {
    pendingItems += 1;
    lines.push(`👁️ *Nazar* (${watching.length})`);
    for (const w of watching.slice(0, 3)) lines.push(`• ${w.condition.slice(0, 70)}`);
    lines.push('');
  }

  // ── system ───────────────────────────────────────────────────────────────
  const disk = diskFree();
  const battery = batteryStatus();
  const sys = [];
  if (disk) {
    const usedPct = Math.round(((disk.total - disk.free) / disk.total) * 100);
    sys.push(`💾 Disk ${usedPct}% bhara · ${gb(disk.free)} free`);
  }
  if (battery) sys.push(`🔋 ${battery}`);
  sys.push(`🖥️ Uptime ${humanDuration(os.uptime() * 1000)} · RAM ${Math.round((1 - os.freemem() / os.totalmem()) * 100)}% used`);
  lines.push(...sys);

  // ── resume point ─────────────────────────────────────────────────────────
  const last = data.lastTask;
  if (last?.text && !last.done) {
    lines.push('', `⏸️ *Adhoora kaam:* ${String(last.text).slice(0, 90)}`);
    lines.push('_/resume se wahin se shuru kar sakte ho._');
  }

  if (!pendingItems && !last?.text) {
    lines.push('', '_Kuch pending nahi — din tumhara hai. Koi kaam ho to bas bolo._');
  }
  return lines.join('\n').trim();
}

/**
 * Ensure the daily brief is scheduled at `time` (e.g. "9am", "09:30").
 * Uses the same cron store as /cron, so /cron list shows it.
 */
export function scheduleBrief(store, timeRaw = '9am') {
  const raw = String(timeRaw ?? '').trim();
  const at = raw.replace(/^(at|roz|daily|every day)\s+/i, '').trim() || '9am';
  const clock = /^\d{1,2}$/.test(at) ? `${at} baje` : at;
  const text = '/brief';
  const existing = (store.data.cronJobs ?? []).find((j) => j.text === text);
  if (existing) return { ok: true, updated: true, job: existing };
  // "roz 9am /brief" is the shape cron.parseCronSchedule() understands.
  return { ok: true, updated: false, text, scheduleRaw: `roz ${clock}`, at };
}

export function unscheduleBrief(store) {
  const jobs = store.data.cronJobs ?? [];
  const idx = jobs.findIndex((j) => j.text === '/brief');
  if (idx === -1) return false;
  jobs.splice(idx, 1);
  store.save?.();
  return true;
}
