// today.js — 📅 Master timeline: ek message me poora din — calendar + homework
// + expenses + battery + focus + net + exams + nudges. Sab compose, zero AI.

import os from 'node:os';

function safe(fn, fallback = '') {
  try {
    const r = fn();
    return r ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Compose the /today timeline. Every source is injected — tests pass stubs,
 * prod passes the real modules' reply functions.
 */
export function buildToday(opts = {}) {
  const {
    calToday = () => '🗓️ Aaj koi event nahi. 🎉',
    hwToday = () => '📝 Aaj/kal koi homework due nahi. 🎉',
    expToday = () => null,
    pgStatus = () => null,
    focusStatus = () => null,
    netReport = () => null,
    examCountdown = () => null,
    nudgeList = () => null,
    statsToday = () => null,
  } = opts;

  const now = new Date();
  const head = `📅 *Aaj ka din* — ${now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short' })}`;
  const blocks = [head];

  for (const src of [examCountdown, calToday, hwToday, expToday, pgStatus, focusStatus, statsToday, netReport, nudgeList]) {
    const line = safe(src, '');
    if (line && !/^(🗓️ Aaj koi event|📝 Aaj\/kal koi homework|🔋 Power Guardian: \*OFF)/.test(line)) {
      blocks.push(line.length > 400 ? `${line.slice(0, 400)}…` : line);
    }
  }
  if (blocks.length === 1) blocks.push('Sab calm hai — koi pending cheez nahi. 🎉');
  void os;
  return blocks.join('\n\n');
}
