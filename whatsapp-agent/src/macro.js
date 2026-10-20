// macro.js — /teach: do it once by hand, replay it forever.
//
// /learn already lets you *type* a sequence. /teach records one instead:
//
//   /teach start morning        ← shuru
//   /open chrome                ← jo tum normally karte ho
//   /pc type github.com/pavit
//   /screenshot
//   /teach stop                 ← save
//   /morning                    ← ab ek command me poora kaam
//
// The steps land in the same `learned` list that /learn uses, so replay is the
// existing, tested path (runLearned) — no second interpreter to keep in sync.
// Only commands are recorded (free text would quietly need the AI again).

import * as learn from './learn.js';

const SKIP = new Set([
  'teach', 'stop', 'cancel', 'abort', 'ruko', 'undo', 'learn', 'unlearn',
  'help', 'commands', 'menu', 'start', 'status', 'ping',
]);

const norm = (cmd) => String(cmd ?? '').trim().toLowerCase();

export function recording(store) {
  const rec = store?.data?.recording;
  return rec && typeof rec === 'object' ? rec : null;
}

/** Returns {ok, name} or {ok:false, error}. */
export function startRecording(store, nameRaw) {
  if (!store?.data) return { ok: false, error: 'store nahi hai' };
  const name = learn.normalizeKeyword(nameRaw);
  const err = learn.validateKeyword(name);
  if (err) return { ok: false, error: err };
  if (store.getLearned?.(name)) {
    return { ok: false, error: `/${name} pehle se sikha hua hai. Naya naam lo, ya pehle /teach delete ${name}.` };
  }
  store.data.recording = { name, steps: [], startedTs: Date.now() };
  store.save?.();
  return { ok: true, name };
}

/** Called after a command succeeded. Returns the step, or null when skipped. */
export function recordStep(store, cmd, args = '') {
  const rec = recording(store);
  if (!rec) return null;
  const c = norm(cmd);
  if (!c || SKIP.has(c)) return null;
  const raw = `/${c}${args ? ` ${String(args).trim()}` : ''}`;
  if (rec.steps.some((s) => s.raw === raw)) return null; // exact repeat adds nothing
  const step = { cmd: c, args: String(args ?? '').trim(), raw };
  rec.steps.push(step);
  if (rec.steps.length > 16) rec.steps.shift(); // keep the recording bounded
  store.save?.();
  return step;
}

export function stopRecording(store) {
  const rec = recording(store);
  if (!rec) return { ok: false, error: 'recording chal rahi hi nahi. Pehle /teach start <naam>' };
  if (!rec.steps.length) {
    store.data.recording = null;
    store.save?.();
    return { ok: false, error: 'Koi command record nahi hui — /teach start ke baad commands bhejo, phir /teach stop.' };
  }
  const rawText = rec.steps.map((s) => s.raw).join(' | ');
  const entry = store.addLearned(rec.name, rec.steps, rawText);
  store.data.recording = null;
  store.save?.();
  return { ok: true, name: rec.name, steps: rec.steps.length, entry };
}

export function cancelRecording(store) {
  if (!store?.data) return false;
  const had = Boolean(store.data.recording);
  store.data.recording = null;
  store.save?.();
  return had;
}

/** "/teach start x" | "/teach stop" | "/teach cancel" | "/teach delete x" | "/teach list" */
export function parseTeachArgs(args = '') {
  const raw = String(args ?? '').trim();
  const lower = raw.toLowerCase();
  const start = raw.match(/^(?:start|shuru|begin|record)\s+(.+)$/i);
  if (start) return { action: 'start', name: start[1].trim() };
  if (!raw || /^(list|ls|all)$/.test(lower)) return { action: 'list' };
  if (/^(stop|save|done|band|khatam)$/.test(lower)) return { action: 'stop' };
  if (/^(cancel|chhodo|abort|ruko)$/.test(lower)) return { action: 'cancel' };
  const del = raw.match(/^(?:delete|del|rm|remove|unlearn)\s+(.+)$/i);
  if (del) return { action: 'delete', name: del[1].trim() };
  // "/teach morning" is a shortcut for "start recording as morning".
  return { action: 'start', name: raw.replace(/^\/+/, '') };
}

export function teachStatusText(store) {
  const rec = recording(store);
  if (!rec) return null;
  const lines = rec.steps.map((s, i) => `${i + 1}. ${s.raw}`);
  return [
    `🔴 *Recording* — /${rec.name} (${rec.steps.length} steps)`,
    ...lines,
    '',
    '_/teach stop — save · /teach cancel — chhodo_',
  ].join('\n');
}

/** Replay a taught macro through an injected command runner. */
export async function replayMacro(store, name, runCommand) {
  const entry = store.getLearned?.(learn.normalizeKeyword(name));
  if (!entry) return null;
  const outputs = [];
  for (const step of entry.commands) {
    const cmd = step.inferredOpen ? 'open' : step.cmd;
    const out = await runCommand(cmd, step.args ?? '');
    const text = typeof out === 'string' ? out : out?.text;
    if (text) outputs.push(text);
  }
  return { entry, outputs, text: `📚 /${entry.keyword} (${entry.commands.length} steps):\n\n${outputs.join('\n\n---\n\n')}` };
}
