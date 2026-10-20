// progress.js — "step 2/8: Search pe click kiya…" while the agent is working.
//
// A computer-use run can be 30–60s of silence, which feels broken even when it
// is working. This sends a short line every few steps (and at most once every
// `everyMs`) so the owner can watch it move — and can see /stop take effect.
//
// Deliberately cheap: no AI call, no screenshot upload, no store write. If the
// send fails (WhatsApp hiccup), the task itself is never affected.

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))}s`;

/** One-line description of a hands/agent step. */
export function stepLine({ label = 'Hands', n = null, total = null, action = '', detail = '', elapsedMs = 0, startedMs = 0 } = {}) {
  const counter = n && total ? ` · step ${n}/${total}` : '';
  const took = startedMs ? ` · ${seconds(startedMs)}` : elapsedMs ? ` · ${seconds(elapsedMs)}` : '';
  const what = detail ? `${action} — ${detail}` : action;
  return `⏳ *${label}*${counter}${took}${what ? `\n${what}` : ''}`;
}

/**
 * Create a throttled progress sender.
 *   const p = createProgress({ send, label: 'Hands', total: 8 });
 *   p.step({ n: 1, action: 'click "Search"' });
 *   p.done();
 */
export function createProgress({ send, label = 'Hands', total = null, everyMs = 7000, minGapMs = 3000, log = console, now = () => Date.now() } = {}) {
  const started = now();
  let lastSent = 0;
  let sent = 0;
  let disabled = typeof send !== 'function';

  async function step({ n = null, action = '', detail = '', force = false } = {}) {
    if (disabled) return false;
    const ts = now();
    if (!force && ts - lastSent < Math.max(minGapMs, 1)) return false;
    if (!force && ts - started < Math.min(2500, everyMs)) return false; // very first step: stay quiet
    lastSent = ts;
    const text = stepLine({ label, n, total, action, detail, startedMs: ts - started });
    try {
      await send(text);
      sent += 1;
      return true;
    } catch (err) {
      // One failed send disables progress for this task: the real reply still
      // has to go out, and retrying would spam.
      disabled = true;
      log?.warn?.(`[progress] send failed, turning off for this task: ${err.message}`);
      return false;
    }
  }

  return {
    step,
    get sent() { return sent; },
    get elapsedMs() { return now() - started; },
    summary: () => `${sent} updates · ${seconds(now() - started)}`,
  };
}

/** Pick a step good enough to show: the model's thought, else the action name. */
export function describeHandsStep(action = {}) {
  const name = action.action ?? 'step';
  const target = action.text ?? action.words ?? action.word ?? action.key ?? action.app ?? action.target ?? '';
  const thought = action.thought ? String(action.thought).split(/[.\n]/)[0].slice(0, 80) : '';
  if (thought) return { action: thought, detail: '' };
  const detail = target ? String(target).slice(0, 60) : '';
  return { action: name, detail };
}
