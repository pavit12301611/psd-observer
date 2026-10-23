// nudges.js — 🤖 Proactive nudge engine: patterns detect karke bot KHUD
// bolta hai — "3h youtube, focus lagaun?", "kal bill due", "5 din se padhai
// nahi". Rules pure; sources injected. `/nudges on|off|now`

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NUDGE_FILE = path.join(ROOT, 'data', 'nudges.json');

export function loadNudgeState(file = NUDGE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { enabled: true, sent: {} };
  }
}

export function saveNudgeState(state, file = NUDGE_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch { /* best effort */ }
}

/**
 * Rule table: each rule looks at world facts and returns a nudge (or null).
 * facts = {youtubeMin, hwOverdue, examsSoon, battery, streakDays, budgetPct,
 *          idleMin, pendingTask}
 */
export function evaluateNudges(facts = {}, opts = {}) {
  const { now = Date.now } = opts;
  void now;
  const out = [];
  if ((facts.youtubeMin ?? 0) >= 120) {
    out.push({ key: 'youtube', msg: `🤖 Aaj ${Math.round(facts.youtubeMin / 60)}h entertainment hua — focus lagaun? \`/focus 25\`` });
  }
  if ((facts.hwOverdue ?? 0) > 0) {
    out.push({ key: 'hw', msg: `🤖 ${facts.hwOverdue} homework OVERDUE hai — dekh lo \`/hw today\`` });
  }
  if ((facts.examsSoon ?? 99) <= 3) {
    out.push({ key: 'exam', msg: `🤖 Exam ${facts.examsSoon} din me hai — aaj ka target set karein? \`/revise\`` });
  }
  if ((facts.battery ?? 100) <= 15) {
    out.push({ key: 'battery', msg: `🤖 Battery ${facts.battery}% — charge lagao warna kaam atkega.` });
  }
  if ((facts.streakDays ?? 0) >= 3) {
    out.push({ key: 'streak', msg: `🤖 ${facts.streakDays}-din ki padhai streak chal rahi hai 🔥 todna mat!` });
  }
  if ((facts.budgetPct ?? 0) >= 90) {
    out.push({ key: 'budget', msg: `🤖 Budget ka ${Math.round(facts.budgetPct)}% khatam — thoda sambhal ke? \`/exp report\`` });
  }
  if ((facts.idleMin ?? 0) >= 45) {
    out.push({ key: 'idle', msg: `🤖 PC ${facts.idleMin} min se idle hai — break khatam? kaam shuru karein?` });
  }
  if (facts.pendingTask) {
    out.push({ key: 'followup', msg: `🤖 Kal ka pending: *"${String(facts.pendingTask).slice(0, 60)}"* — karna hai?` });
  }
  return out;
}

/** Fire nudges respecting once-per-day-per-key. Returns messages to send. */
export function fireNudges(facts, opts = {}) {
  const { file = NUDGE_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const state = loadNudgeState(file);
  if (!state.enabled) return [];
  const today = new Date(nowTs).toISOString().slice(0, 10);
  const fresh = [];
  for (const n of evaluateNudges(facts, { now: nowTs })) {
    if (state.sent[n.key] === today) continue;
    state.sent[n.key] = today;
    fresh.push(n.msg);
  }
  saveNudgeState(state, file);
  return fresh;
}

export function setNudges(enabled, opts = {}) {
  const state = loadNudgeState(opts.file ?? NUDGE_FILE);
  state.enabled = enabled;
  saveNudgeState(state, opts.file ?? NUDGE_FILE);
  return enabled ? '🤖 Nudges *ON* — main khud yaad dilaunga.' : '🤖 Nudges *OFF*.';
}
