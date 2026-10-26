// brainfallback.js — 🧠 Auto-failover ladder: cloud brain hang/fail → next
// brain → last-resort smart template. Jawab kabhi blank nahi.
//
// The ladder gained one rung: when every brain has failed, a typed-decision
// model (Laya) is asked what kind of message this is. Laya writes no text, so it
// cannot answer a question — but it can tell a command from a question, and a
// command does not need an LLM to run. That turns the old dead end ("all brains
// offline, try later") into "I could not think, but I did the thing you asked".
//
// It is optional by construction: with no Laya running, the rung is skipped and
// the template is used exactly as before.

import { stuckQuestions } from './laya.js';

/**
 * Try each attempt fn in order. First non-empty answer wins.
 * `attempts` = array of async (prompt) => string.
 *
 * `opts.laya` is an optional decision client (see laya.js). When present and
 * every brain has failed, it is asked one typed question set about the prompt.
 * `opts.onDecision` receives the confident answers and may return a string,
 * which wins over the template. Anything it returns that is not a non-empty
 * string is ignored, so a broken handler can never produce a blank reply.
 */
export async function completeWithFallback(prompt, opts = {}) {
  const { attempts = [], minChars = 1, timeoutMs = 25_000, laya = null, onDecision = null } = opts;
  const errors = [];
  for (let i = 0; i < attempts.length; i++) {
    const fn = attempts[i];
    const name = fn.name || `brain${i}`;
    try {
      const winner = await Promise.race([
        Promise.resolve(fn(prompt)),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`${name} timeout`)), timeoutMs).unref?.()),
      ]);
      const text = typeof winner === 'string' ? winner.trim() : '';
      if (text.length >= minChars) return { text, source: name, tried: i + 1, errors };
    } catch (err) {
      errors.push(`${name}: ${err?.message ?? err}`);
    }
  }

  // ── Last rung before the honest template ─────────────────────────────────
  // Only reached when no brain answered. A decision model that cannot tell us
  // anything confident leaves this as a no-op.
  const decision = await askLaya(prompt, { laya });
  if (decision && typeof onDecision === 'function') {
    try {
      const acted = await onDecision(decision, prompt);
      const text = typeof acted === 'string' ? acted.trim() : '';
      if (text.length >= minChars) {
        return { text, source: 'laya-decision', tried: attempts.length + 1, errors, decision };
      }
    } catch (err) {
      errors.push(`laya-decision: ${err?.message ?? err}`);
    }
  }

  return { text: null, source: 'none', tried: attempts.length, errors, decision };
}

/**
 * Ask the decision model what this message is. Returns the confident answers,
 * or null when Laya is absent, down, or unsure about everything.
 *
 * `commandOptions` lets the caller supply the answer space for the dynamic
 * "which command" question — the runnable catalog, usually.
 */
export async function askLaya(prompt, opts = {}) {
  const { laya = null, commandOptions = [], questions = stuckQuestions(), minProbability } = opts;
  if (!laya || typeof laya.confidentDecide !== 'function') return null;
  try {
    const answers = await laya.confidentDecide(String(prompt ?? ''), questions, commandOptions, minProbability);
    return answers ?? null;
  } catch {
    return null;
  }
}

/** Last-resort template — honest, never pretends to know. */
export function fallbackReply(kind = 'general') {
  const lines = {
    general: '🧠 Abhi saare brains busy/offline hain — thodi der baad dobara try karo. Local model: `/brains`.',
    question: '🧠 Sawal samjha, par brain offline hai. Local LLM on karo (`/model`) ya thodi der baad poochho.',
    code: '🧠 Code brain offline — Groq key ya local Ollama setup karo (`/brains`).',
  };
  return lines[kind] ?? lines.general;
}
