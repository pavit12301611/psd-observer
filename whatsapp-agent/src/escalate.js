// escalate.js — ⏰ Escalating reminders: hw/calendar deadlines ke liye
// T-2h nudge → T-30min strict → overdue 🔴. Pure schedule math + injected
// send. The heartbeat calls tick(); catchup.js already handles missed runs.

export const STAGES = [
  { key: 'soon', beforeMs: 2 * 3600_000, label: '⏰', msg: (t, d) => `⏰ *${t}* ${d} me due hai — ready ho jao.` },
  { key: 'urgent', beforeMs: 30 * 60_000, label: '⚠️', msg: (t, d) => `⚠️ *${t}* sirf ${d} me due! Abhi khatam karo.` },
  { key: 'overdue', beforeMs: -1, label: '🔴', msg: (t) => `🔴 *OVERDUE:* ${t} — abhi submit/finish karo!` },
];

/**
 * Which stage applies for an item due at `at`, right now.
 * Returns {stage, message} or null (not yet / already notified).
 */
export function stageFor(at, opts = {}) {
  const { now = Date.now, notified = new Set() } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const delta = at - nowTs;
  for (let i = STAGES.length - 1; i >= 0; i--) {
    const s = STAGES[i];
    const crossed = s.key === 'overdue' ? delta < 0 : (delta <= s.beforeMs && delta > (STAGES[i + 1]?.beforeMs ?? -1));
    if (crossed && !notified.has(s.key)) return s;
  }
  return null;
}

export function humanDelta(ms) {
  const mins = Math.round(Math.abs(ms) / 60_000);
  if (mins < 60) return `${mins} min`;
  return `${Math.round(mins / 60)} ghante`;
}

/**
 * Tick all items [{title, at, id}]. Mutates `state.notified[id]` so each
 * stage fires once. Returns messages to send.
 */
export function tick(items, opts = {}) {
  const { now = Date.now, state = {} } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const out = [];
  for (const item of items ?? []) {
    state[item.id] ??= [];
    const notified = new Set(state[item.id]);
    const stage = stageFor(item.at, { now: nowTs, notified });
    if (!stage) continue;
    state[item.id].push(stage.key);
    out.push(stage.msg(item.title, humanDelta(item.at - nowTs)));
  }
  return out;
}
