// focus.js — 🎯 Focus Mode: pomodoro with a distraction gate. While focus is
// ON, listed distraction apps get closed at start and re-checked every
// minute (they can reopen, we close again), and the owner gets a session
// report at the end. `/focus 25` · `/focus 25 block:youtube, steam` ·
// `/focus stop` · `/focus status`
//
// Stats live in data/focus.json — daily deep-work minutes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FOCUS_FILE = path.join(ROOT, 'data', 'focus.json');
export const DEFAULT_MINUTES = 25;

let session = null; // { endsAt, minutes, blocks: [], closed: n, startedAt }

export function loadFocusStats(file = FOCUS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { days: {} };
  }
}

function saveFocusStats(stats, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(stats, null, 2));
  } catch { /* best effort */ }
}

export function dayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function addFocusMinutes(minutes, opts = {}) {
  const { file = FOCUS_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const stats = loadFocusStats(file);
  const key = dayKey(nowTs);
  stats.days[key] = (stats.days[key] ?? 0) + minutes;
  saveFocusStats(stats, file);
  return stats.days[key];
}

export function focusStatus(opts = {}) {
  const { file = FOCUS_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const today = loadFocusStats(file).days[dayKey(nowTs)] ?? 0;
  if (!session) return `🎯 Focus: *OFF* · aaj ka deep work: ${today} min · start: \`/focus 25\``;
  const minsLeft = Math.max(0, Math.ceil((session.endsAt - now) / 60_000));
  return `🎯 Focus: *ON* — ${minsLeft} min baaki · blocks: ${session.blocks.join(', ') || 'none'} · re-closed ${session.closed} · stop: \`/focus stop\``;
}

export function stopFocus(opts = {}) {
  const { file = FOCUS_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  if (!session) return '🎯 Focus chal hi nahi raha.';
  clearInterval(session.timer);
  const doneMin = Math.max(1, Math.round((nowTs - session.startedAt) / 60_000));
  const total = addFocusMinutes(doneMin, { file, now: nowTs });
  const s = session;
  session = null;
  return `🎯 *Focus session done* — ${doneMin} min deep work (blocks re-closed ${s.closed} baar).\nAaj ka total: *${total} min* 💪`;
}

/** Close a distraction app if it is running. Injected in tests. */
async function closeIfRunning(app, closeApp) {
  try {
    const result = await closeApp(app);
    return Boolean(result);
  } catch {
    return false;
  }
}

/**
 * Start a focus session. `closeApp(name)` closes an app (injected); the
 * re-check loop keeps closing distractions whenever they pop back up.
 */
export async function startFocus(opts = {}) {
  const {
    minutes = DEFAULT_MINUTES,
    blocks = [],
    closeApp,
    now = Date.now,
    file = FOCUS_FILE,
  } = opts;
  if (session) return `🎯 Focus pehle se ON hai (${Math.ceil((session.endsAt - now()) / 60_000)} min baaki). Pehle \`/focus stop\`.`;
  const mins = Math.min(180, Math.max(5, Number(minutes) || DEFAULT_MINUTES));
  const startedAt = now();
  session = {
    startedAt,
    endsAt: startedAt + mins * 60_000,
    minutes: mins,
    blocks: [...blocks],
    closed: 0,
    timer: null,
    file,
  };

  // initial sweep: close every distraction NOW
  if (typeof closeApp === 'function') {
    for (const app of blocks) {
      if (await closeIfRunning(app, closeApp)) session.closed += 1;
    }
  }

  const recheck = setInterval(async () => {
    if (!session) return;
    if (Date.now() >= session.endsAt) {
      clearInterval(session.timer);
      clearInterval(recheck);
      const doneMin = session.minutes;
      const total = addFocusMinutes(doneMin, { file });
      const closed = session.closed;
      session = null;
      opts.onDone?.(`🎯 *Focus ${doneMin} min POORA!** 🎉 (distractions ${closed} baar hataye).\nAaj ka total: *${total} min*`);
      return;
    }
    if (typeof closeApp === 'function') {
      for (const app of blocks) {
        if (await closeIfRunning(app, closeApp)) session.closed += 1;
      }
    }
  }, 60_000);
  recheck.unref?.();
  session.timer = recheck;

  return `🎯 *Focus ON — ${mins} min*${blocks.length ? `\n🚫 Blocked: ${blocks.join(', ')} (jo kholo, main band kar dunga)` : ''}\nStatus: \`/focus status\` · Stop: \`/focus stop\``;
}

export function weeklyReport(opts = {}) {
  const { file = FOCUS_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const stats = loadFocusStats(file);
  const rows = [];
  for (let i = 6; i >= 0; i--) {
    const key = dayKey(nowTs - i * 86_400_000);
    const mins = stats.days[key] ?? 0;
    rows.push(`  ${key.slice(5)}: ${mins ? `${mins} min ${'█'.repeat(Math.min(10, Math.round(mins / 10)))}` : '—'}`);
  }
  const total = rows.reduce((s, r) => s + (Number(r.match(/(\d+) min/)?.[1]) || 0), 0);
  return `🎯 *Focus — last 7 days* (total ${total} min)\n${rows.join('\n')}`;
}
