// planpreview.js — 🤖 Plan-preview mode: "/agent plan <task>" pe bot pehle
// plan bhejta hai ("ye 4 steps karunga"), phir `/go` se execute. Galat kaam
// ka risk khatam — full automation + full control.

let pending = null; // { id, task, steps, createdAt }

export function makePlan(task, steps, now = Date.now()) {
  const nowTs = typeof now === 'function' ? now() : now;
  pending = {
    id: String(nowTs).slice(-6),
    task: String(task),
    steps: (steps ?? []).map((s, i) => `${i + 1}. ${s}`),
    createdAt: nowTs,
  };
  return pending;
}

export function planStatus() {
  if (!pending) return '🤖 Koi pending plan nahi. Banao: `/agent plan <task>`';
  return `📋 *Pending plan* (id ${pending.id}) — ${pending.task}\n${pending.steps.join('\n')}\n\nExecute: \`/go\` · Cancel: \`/no\``;
}

export function cancelPlan() {
  if (!pending) return '❌ Koi plan tha hi nahi.';
  const t = pending.task;
  pending = null;
  return `🗑️ Plan cancel: *${t.slice(0, 60)}*`;
}

/** Approve: returns the plan to execute (caller runs it) and clears state. */
export function approvePlan() {
  if (!pending) return null;
  const p = pending;
  pending = null;
  return p;
}

/**
 * Turn a task + planner output (free text or array) into step lines.
 * `plannerFn` is injected (usually the brain) — pure fallback is a
 * 3-step generic plan so preview ALWAYS works.
 */
export async function buildSteps(task, opts = {}) {
  const { plannerFn } = opts;
  if (typeof plannerFn === 'function') {
    try {
      const raw = await plannerFn(task);
      const lines = String(raw ?? '')
        .split('\n')
        .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
        .filter((l) => l.length > 3);
      if (lines.length) return lines.slice(0, 8);
    } catch { /* generic plan below */ }
  }
  return [
    `Samjho: "${String(task).slice(0, 80)}"`,
    'Screen/browser state check karo (screenshot + context)',
    'Steps execute karo, har step ke baad verify karo',
  ];
}

export function planReply(plan) {
  return `📋 *Plan ready — approve karo*\nTask: ${plan.task}\n${plan.steps.join('\n')}\n\n✅ Execute: \`/go\`\n❌ Cancel: \`/no\``;
}
