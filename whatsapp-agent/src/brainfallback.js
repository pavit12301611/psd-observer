// brainfallback.js — 🧠 Auto-failover ladder: cloud brain hang/fail → next
// brain → last-resort smart template. Jawab kabhi blank nahi.

/**
 * Try each attempt fn in order. First non-empty answer wins.
 * `attempts` = array of async (prompt) => string.
 */
export async function completeWithFallback(prompt, opts = {}) {
  const { attempts = [], minChars = 1, timeoutMs = 25_000 } = opts;
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
  return { text: null, source: 'none', tried: attempts.length, errors };
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
