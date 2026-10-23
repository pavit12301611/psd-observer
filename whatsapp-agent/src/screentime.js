// screentime.js — 📊 Screen Time: lightweight per-window samples via the
// existing focus window helper → daily app-time report. `/stats today` ·
// `/stats week`. Sampling runs on the heartbeat only while the stats module
// is asked for (lazy) OR via /stats start — no always-on daemon.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STATS_FILE = path.join(ROOT, 'data', 'screentime.json');
export const SAMPLE_MINUTES = 5;

export function loadStats(file = STATS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { days: {}, sampling: false };
  }
}

function saveStats(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

export function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Current focused window via wmctrl (same approach as focus window helper). */
export async function activeWindowName(run = execFileAsync) {
  try {
    const { stdout } = await run('wmctrl', ['-l'], { timeout: 3000 });
    // Pick the FIRST window line's title — cheap heuristic; good enough for
    // per-app minutes (a title usually contains the app/document name).
    const line = String(stdout ?? '').split('\n').find((l) => l.trim());
    if (!line) return null;
    const parts = line.split(/\s{2,}/);
    return (parts[parts.length - 1] ?? '').trim() || null;
  } catch {
    return null;
  }
}

/** Crude app attribution from a window title. */
export function appNameFromTitle(title) {
  if (!title) return 'unknown';
  const t = title.toLowerCase();
  if (/libreoffice|writer|calc|impress|notion|obsidian|google docs|\bdocs\b/.test(t)) return 'docs';
  if (/chrome|chromium|firefox|brave/.test(t)) return 'browser';
  if (/code|vscode|terminal|konsole|alacritty/.test(t)) return 'dev tools';
  if (/spotify|vlc|youtube|netflix/.test(t)) return 'entertainment';
  if (/whatsapp|telegram|slack|discord/.test(t)) return 'chat';
  return title.split(' — ')[0].split(' - ')[0].slice(0, 28) || 'unknown';
}

export function recordSample(title, opts = {}) {
  const { file = STATS_FILE, now = Date.now, minutes = SAMPLE_MINUTES } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const app = appNameFromTitle(title);
  const data = loadStats(file);
  const key = dayKey(nowTs);
  data.days[key] ??= {};
  data.days[key][app] = (data.days[key][app] ?? 0) + minutes;
  saveStats(data, file);
  return app;
}

export function topApps(dayEntry, n = 5) {
  return Object.entries(dayEntry ?? {}).sort((a, b) => b[1] - a[1]).slice(0, n);
}

export function todayReply(opts = {}) {
  const { file = STATS_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const day = loadStats(file).days[dayKey(nowTs)] ?? {};
  const total = Object.values(day).reduce((s, m) => s + m, 0);
  if (!total) return '📊 Aaj ka screen time abhi record nahi hua. Sampling: `/stats on` · ya thodi der baad check karo.';
  const rows = topApps(day).map(([app, mins]) => `  • ${app}: ${mins} min ${'█'.repeat(Math.min(12, Math.round(mins / 15)))}`);
  return `📊 *Screen time — aaj* (total ${total} min)\n${rows.join('\n')}`;
}

export function weekReply(opts = {}) {
  const { file = STATS_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const data = loadStats(file);
  const rows = [];
  let grand = 0;
  for (let i = 6; i >= 0; i--) {
    const key = dayKey(nowTs - i * 86_400_000);
    const total = Object.values(data.days[key] ?? {}).reduce((s, m) => s + m, 0);
    grand += total;
    rows.push(`  ${key.slice(5)}: ${total} min`);
  }
  return `📊 *Screen time — last 7 days* (total ${grand} min)\n${rows.join('\n')}`;
}

export function toggleSampling(on, opts = {}) {
  const { file = STATS_FILE } = opts;
  const data = loadStats(file);
  data.sampling = on;
  saveStats(data, file);
  return on
    ? `📊 Screen-time sampling *ON* — har ${SAMPLE_MINUTES} min ek sample (window title → app category). Report: \`/stats today\``
    : '📊 Screen-time sampling *OFF*.';
}
