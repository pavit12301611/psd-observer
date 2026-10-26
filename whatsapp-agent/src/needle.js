// needle.js — optional on-device intent classification.
//
// Needle 3 (Cactus Compute, Apache-2.0) is an 8-29 MB tool-calling model that
// runs locally at 400-4000 tok/s. It is used here for exactly one job: a second
// opinion on which tier a message belongs to and whether it is a web task, so
// the router does not have to wake a multi-billion-parameter local model just
// to classify "screenshot lo". The local brain is kept resident by Ollama for
// `keep_alive` (30m by default), so every avoided classification is real RAM
// and real wake-up latency saved.
//
// It is NOT a reply generator and never becomes one. Needle does not chat — it
// returns function calls with a calibrated confidence score. Every call through
// this module is a classification, and the answer text still comes from the
// existing brains.
//
// Optional by construction: if the `needle` command, the Python adapter, or the
// model file is missing, every entry point returns null and the caller keeps
// its existing behaviour. Nothing in the agent depends on this being installed.
//
// Accuracy note, so nobody ships this blind: the base Needle 3 checkpoint
// scores ~27% on Cactus's own held-out tool-calling eval, and ~84% after LoRA
// fine-tuning on that task (61% at 4 layers). Treat the shipped weights as a
// starting point that needs tuning on *this* command catalog before it can
// replace the keyword floor in router.js — which is why it is wired in as a
// second opinion, never as the decider.

import { spawn } from 'node:child_process';

/** The four tiers router.js already speaks. Kept identical on purpose. */
export const NEEDLE_TIERS = ['tiny', 'light', 'standard', 'heavy'];

/**
 * The tool schema handed to Needle. One tier decision, plus two orthogonal
 * flags. Needle picks from names, so the names carry the whole meaning.
 */
export function intentTools() {
  const tier = (name, description) => ({
    name,
    description,
    parameters: { type: 'object', properties: {}, required: [] },
  });
  return [
    tier('tier_tiny', 'A greeting, a one-line lookup, or a reply that needs no action and no reasoning.'),
    tier('tier_light', 'One simple action on the PC, or a short factual answer.'),
    tier('tier_standard', 'A real question needing reasoning, or two or more steps.'),
    tier('tier_heavy', 'Long, complex, code-heavy, or research-grade work.'),
    tier('web_task', 'The request needs the browser or the internet to complete.'),
    tier('needs_tools', 'Completing this needs the agent to call a tool, not just talk.'),
  ];
}

/**
 * Parse the adapter's stdout into a normalised intent, or null.
 *
 * The adapter is a separate process speaking one JSON object on stdout. Every
 * failure mode — no output, invalid JSON, an error envelope, no tier call —
 * returns null rather than throwing, because a classifier that cannot answer
 * must never take the router down with it.
 */
export function parseNeedleResult(stdout) {
  let data;
  try {
    data = JSON.parse(String(stdout ?? '').trim());
  } catch {
    return null;
  }
  if (!data || data.ok === false) return null;
  const calls = Array.isArray(data.calls) ? data.calls : [];
  return pickIntent(calls, data.confidence);
}

/**
 * Reduce Needle's function calls to the shape router.js wants.
 * Returns null when no tier was chosen, so the caller can ignore it.
 */
export function pickIntent(calls, confidence) {
  const list = Array.isArray(calls) ? calls : [];
  let tier = null;
  let web = false;
  let tools = false;
  for (const call of list) {
    const name = String(call?.name ?? '');
    if (name.startsWith('tier_')) {
      const candidate = name.slice('tier_'.length);
      // Unknown tiers are ignored rather than guessed at.
      if (NEEDLE_TIERS.includes(candidate)) tier = candidate;
    } else if (name === 'web_task') web = true;
    else if (name === 'needs_tools') tools = true;
  }
  if (!tier) return null;
  const score = Number(confidence);
  return { tier, web, tools, confidence: Number.isFinite(score) ? score : null };
}

/** True when the confidence is present and clears the gate. */
export function confident(intent, minConfidence = 0.6) {
  if (!intent) return false;
  const min = Number(minConfidence);
  if (!Number.isFinite(min) || min <= 0) return true;
  return typeof intent.confidence === 'number' && intent.confidence >= min;
}

/**
 * Build a classifier. `spawn` is injected so tests never touch a real process;
 * the default is node's own.
 *
 * The command is configurable because installs differ: a pip install exposes
 * the Python package, a manual build exposes the engine plus weights. The
 * contract is one JSON object in on stdin, one JSON object out on stdout.
 */
export function createNeedle(options = {}) {
  const {
    command = options.command || process.env.NEEDLE_CMD || 'python3',
    args = options.args || (process.env.NEEDLE_ARGS || '-m needle_classify').split(/\s+/).filter(Boolean),
    cwd = process.cwd(),
    timeoutMs = Number(process.env.NEEDLE_TIMEOUT_MS) || 4000,
    minConfidence = Number(process.env.NEEDLE_MIN_CONFIDENCE) || 0.6,
    spawnFn = spawn,
    log = console,
  } = options;

  // A missing command is the common case, so remember it instead of paying for
  // a failed spawn on every message.
  let missing = false;

  const classify = (text, options_ = {}) =>
    new Promise((resolve) => {
      if (missing) return resolve(null);
      const body = String(text ?? '').trim();
      if (!body) return resolve(null);
      const limit = Number(options_.timeoutMs) || timeoutMs;
      let child;
      try {
        child = spawnFn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch {
        missing = true;
        return resolve(null);
      }
      let out = '';
      let err = '';
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        done(null);
      }, Math.max(1, limit));
      // Deliberately NOT unref'd: this timer is the only thing that guarantees
      // the promise settles when the child hangs. It is bounded by the timeout,
      // so the worst case is a short delay, not a process that never exits.
      child.stdout?.on('data', (chunk) => {
        out += chunk;
        // A single JSON object is all we ever want; stop reading past it.
        if (out.length > 1_000_000) done(null);
      });
      child.stderr?.on('data', (chunk) => { err += chunk; });
      child.on('error', (error) => {
        // ENOENT is "not installed", which is a normal state, not a fault.
        if (error?.code === 'ENOENT') missing = true;
        else log?.warn?.(`[needle] ${error.message}`);
        done(null);
      });
      child.on('close', (code) => {
        if (code !== 0 && err.trim()) log?.warn?.(`[needle] exit ${code}: ${err.trim().slice(0, 200)}`);
        done(code === 0 ? parseNeedleResult(out) : null);
      });
      try {
        child.stdin?.end(JSON.stringify({ text: body, tools: intentTools() }));
      } catch {
        done(null);
      }
    });

  return {
    classify,
    /** A confident intent, or null. Never throws. */
    async intent(text, options_ = {}) {
      try {
        const parsed = await classify(text, options_);
        return confident(parsed, minConfidence) ? parsed : null;
      } catch (error) {
        log?.warn?.(`[needle] ${error?.message ?? error}`);
        return null;
      }
    },
    get missing() { return missing; },
  };
}

/** A classifier that never answers, for callers that want to opt out. */
export function nullNeedle() {
  return { classify: async () => null, intent: async () => null, missing: true };
}

let shared = null;

/**
 * One classifier per config, created on first use and only when enabled.
 *
 * The classifier latches "command not found" so a missing install costs one
 * failed spawn rather than one per message, which means it has to be shared
 * rather than rebuilt per call. Passing an explicit classifier to
 * createModelRouter/routerFor always wins over this, so tests never touch it.
 */
export function needleFor(config = {}) {
  if (!config?.needleEnabled) return nullNeedle();
  if (!shared || shared.__config !== config) {
    const args = String(config.needleArgs || '').trim()
      ? config.needleArgs.split(/\s+/).filter(Boolean)
      : undefined;
    shared = Object.assign(
      createNeedle({
        command: config.needleCmd || undefined,
        args,
        timeoutMs: config.needleTimeoutMs,
      }),
      { __config: config },
    );
  }
  return shared;
}
