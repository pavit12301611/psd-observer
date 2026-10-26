// laya.js — optional typed-decision oracle.
//
// Laya (Convai Innovations, Apache-2.0) is a non-autoregressive "System 1"
// decision model: it takes a state plus typed questions and returns calibrated
// probabilities in a single forward pass (~33ms on a T4). It generates no text
// at all, which is exactly why it is useful here — when every brain is down it
// can still answer "is this a command or a question?" without hallucinating a
// reply, and a command does not need an LLM to run.
//
// It is wired in as the last rung of brainfallback.completeWithFallback, ahead
// of the dead-end "all brains offline" template. It never replaces a brain: it
// only decides *what kind of thing* the message is, so the agent can still act
// when the models cannot talk.
//
// Optional by construction: if laya-serve is not running, every entry point
// returns null and the existing template is used unchanged.
//
// Accuracy note, so nobody ships this blind: the base Laya checkpoints score
// ~0.36 on the typed-decisions benchmark against a ~0.32 random baseline —
// chance. The published 0.766 belongs to a checkpoint fine-tuned on that
// benchmark's own training split. Treat the shipped weights as a base to
// specialise on this agent's decision types before trusting it, and keep the
// confidence gate closed until you have measured it on your own traffic.

/** The three question primitives Laya answers. */
export const QUESTION_KINDS = ['choice', 'score', 'noul'];

/**
 * The decisions this agent actually needs when the brains are gone.
 * Each becomes a typed question; the ids are the contract with the caller.
 */
export function stuckQuestions() {
  return [
    {
      id: 'kind',
      kind: 'choice',
      question: 'Is this message a command to run on the PC, or a question to answer?',
      options: ['command', 'question', 'chatter'],
    },
    {
      id: 'command',
      kind: 'choice',
      question: 'Which command best matches this request?',
      options: [],
    },
    {
      id: 'act',
      kind: 'noul',
      question: 'Should the agent act on this now without asking the owner?',
    },
    {
      id: 'urgency',
      kind: 'score',
      question: 'How urgent is this request?',
      options: ['not urgent', 'soon', 'now', 'overdue'],
    },
  ];
}

/**
 * Build the request body for laya-serve's Jev-compatible endpoint.
 * `commandOptions` fills the one question whose answer space is dynamic.
 */
export function buildDecisionRequest(state, questions = stuckQuestions(), commandOptions = []) {
  const list = (Array.isArray(questions) ? questions : stuckQuestions()).map((q) => {
    const base = { id: q.id, kind: QUESTION_KINDS.includes(q.kind) ? q.kind : 'choice', question: q.question };
    if (q.kind !== 'noul') base.options = q.id === 'command' && commandOptions.length ? commandOptions : (q.options ?? []);
    return base;
  });
  return { state: String(state ?? ''), questions: list };
}

/**
 * Normalise a laya-serve response into `{ [id]: { answer, probability } }`.
 * Returns null when the envelope is unusable, so callers fall back silently.
 */
export function parseLayaResult(body) {
  let data = body;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  if (!data || typeof data !== 'object') return null;
  const answers = data.answers ?? data.results ?? data.questions ?? null;
  if (!Array.isArray(answers)) return null;
  const out = {};
  for (const entry of answers) {
    const id = String(entry?.id ?? entry?.question ?? '');
    if (!id) continue;
    const probability = Number(entry?.probability ?? entry?.confidence ?? entry?.p);
    out[id] = {
      answer: entry?.answer ?? entry?.value ?? null,
      probability: Number.isFinite(probability) ? probability : null,
      // Laya can return the whole distribution; keep it when present.
      distribution: entry?.distribution && typeof entry.distribution === 'object' ? entry.distribution : null,
    };
  }
  return Object.keys(out).length ? out : null;
}

/** True when an answer is present and its probability clears the gate. */
export function decided(answer, minProbability = 0.7) {
  if (!answer || answer.answer === null || answer.answer === undefined) return false;
  const min = Number(minProbability);
  if (!Number.isFinite(min) || min <= 0) return true;
  return typeof answer.probability === 'number' && answer.probability >= min;
}

/**
 * Build a decision client. `post` is injected so tests never touch the network;
 * the default uses fetch against a local laya-serve.
 *
 * The endpoint is Jev-compatible (`POST /v1/systemone`) because that is what
 * laya-serve ships, and it keeps the door open for a hosted Jev later without
 * changing this module.
 */
export function createLaya(options = {}) {
  const {
    baseUrl = (process.env.LAYA_URL || 'http://127.0.0.1:8765').replace(/\/$/, ''),
    path = process.env.LAYA_PATH || '/v1/systemone',
    timeoutMs = Number(process.env.LAYA_TIMEOUT_MS) || 5000,
    minProbability = Number(process.env.LAYA_MIN_PROBABILITY) || 0.7,
    postFn = null,
    log = console,
  } = options;

  // Remember a dead endpoint so a down server costs one failed request, not one
  // per message. Cleared on any successful answer.
  let down = false;

  const post = postFn ?? (async (url, body, headers, ms) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, Number(ms) || timeoutMs)),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`laya ${res.status}: ${text.slice(0, 200)}`);
    return text;
  });

  const decide = async (state, questions = stuckQuestions(), commandOptions = []) => {
    if (down) return null;
    try {
      const raw = await post(`${baseUrl}${path}`, buildDecisionRequest(state, questions, commandOptions), {}, timeoutMs);
      const parsed = parseLayaResult(raw);
      if (parsed) down = false;
      return parsed;
    } catch (error) {
      // A refused connection is "not running", which is a normal state.
      if (!/timeout|abort/i.test(String(error?.message ?? ''))) down = true;
      log?.warn?.(`[laya] ${error?.message ?? error}`);
      return null;
    }
  };

  return {
    decide,
    /** Only the answers that clear the gate. Never throws. */
    async confidentDecide(state, questions, commandOptions, min = minProbability) {
      const parsed = await decide(state, questions, commandOptions);
      if (!parsed) return null;
      const out = {};
      for (const [id, answer] of Object.entries(parsed)) {
        if (decided(answer, min)) out[id] = answer;
      }
      return Object.keys(out).length ? out : null;
    },
    get down() { return down; },
  };
}

/** A client that never answers, for callers that want to opt out. */
export function nullLaya() {
  return { decide: async () => null, confidentDecide: async () => null, down: true };
}

let shared = null;

/**
 * One client per config, created on first use and only when enabled.
 *
 * The client remembers a dead endpoint so a down server costs one failed
 * request rather than one per message, which means it has to be shared rather
 * than rebuilt per call. Passing an explicit `client` to askLaya/completeWithFallback
 * always wins over this, so tests never touch it.
 */
export function layaFor(config = {}) {
  if (!config?.layaEnabled) return nullLaya();
  if (!shared || shared.__config !== config) {
    shared = Object.assign(
      createLaya({ baseUrl: config.layaUrl, minProbability: config.layaMinProbability }),
      { __config: config },
    );
  }
  return shared;
}
