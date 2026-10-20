// router.js — the "right amount of brain" layer.
//
// The agent can have several free brains at once: Ollama on the PC, Groq's free
// tier, Gemini's free tier, OpenRouter's free models. Before this file, every
// request walked that list in a hard-coded order and used whatever answered
// first — so a one-word question could hit a 70B model (slow, wasteful) and a
// real multi-step task could land on a 1B model (useless).
//
// This module decides, per message:
//   1. HOW HARD the request is      → tier: tiny / light / standard / heavy
//   2. WHAT it needs                → tools? vision? (multimodal)
//   3. WHICH model fits that tier   → cheapest capable model first, local first
//   4. HOW MANY steps/tools to give → tiny tasks don't get a 10-step budget
//
// It also remembers failures: a brain that timed out is put on a short
// cooldown so the next WhatsApp message does not wait for it again, and it
// caps how many "heavy" calls may run per hour (power budget).
//
// Pure + injectable: nothing here touches the network, so it is fully testable.

export const TIERS = ['tiny', 'light', 'standard', 'heavy'];
export const TIER_RANK = { tiny: 1, light: 2, standard: 3, heavy: 4 };
export const RANK_TIER = { 1: 'tiny', 2: 'light', 3: 'standard', 4: 'heavy' };

const clampRank = (n) => Math.max(1, Math.min(4, Math.round(Number(n) || 0)));

const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);

// Verbs that mean "actually do something on the PC", not "chat".
const ACTION_VERBS = [
  'open', 'close', 'launch', 'kill', 'run', 'execute', 'install', 'download', 'upload',
  'save', 'write', 'create', 'make', 'delete', 'remove', 'move', 'copy', 'rename', 'zip',
  'unzip', 'extract', 'send', 'share', 'search', 'find', 'scan', 'record', 'capture',
  'screenshot', 'type', 'click', 'tap', 'press', 'play', 'pause', 'mute', 'volume',
  'brightness', 'wifi', 'bluetooth', 'restart', 'reboot', 'shutdown', 'lock', 'restart',
  'schedule', 'remind', 'translate', 'summarise', 'summarize', 'email', 'backup',
  // Hinglish
  'kholo', 'khol', 'band', 'bhej', 'bhejo', 'banao', 'bana', 'likho', 'likh', 'dhundo',
  'dhoondo', 'hata', 'hatao', 'chalao', 'chalu', 'bandh', 'kaato', 'lagao', 'karo',
];

// Words that mean the answer has to be reasoned, not just looked up.
const HARD_WORDS = [
  'compare', 'comparison', 'analyse', 'analyze', 'analysis', 'design', 'architect',
  'architecture', 'strategy', 'research', 'essay', 'thesis', 'report', 'proposal',
  'debug', 'refactor', 'optimise', 'optimize', 'implementation', 'algorithm',
  'step-by-step', 'step by step', 'trade-off', 'tradeoff', 'difference between',
  'pros and cons', 'explain why', 'how does', 'kaise kaam', 'kyun', 'kyu',
  'explain', 'describe how', 'teach me', 'samjhao',
];
const CODE_WORDS = [
  'code', 'coding', 'script', 'function', 'class', 'api', 'sql', 'regex', 'python',
  'javascript', 'typescript', 'bash', 'html', 'css', 'json', 'bug', 'compile', 'deploy',
];
const MULTI_STEP = /\b(then|after\s+that|afterwards|and\s+then|next|finally|also|phir|fir|uske\s+baad|uske\s+bad|pehle|pahle|first)\b/gi;
const WEB_DEST = /\b(website|web\s*site|browser|internet|google|youtube|chatgpt|gpt|gemini|claude|arena|gmail|whatsapp\s*web|instagram|facebook|twitter|x\.com|linkedin|amazon|flipkart|netflix|github|stackoverflow|stack\s*overflow|https?:\/\/|(?:[a-z0-9-]+\.)+(?:com|in|org|net|io|ai|dev|co))\b/i;
const WEB_ACTION = /\b(open|kholo|khol|search|google|type|likho|likh|ask|poocho|pooch|poch|pucho|puch|click|tap|login|log\s*in|sign\s*in|download|bhej|send|play|chalao|visit|jao|check)\b/i;

/**
 * How hard is this request, really?
 *
 * Returns { score, tier, rank, reasons, needsTools, needsVision, wantsPlan }.
 * Deliberately explainable: every point added records a short reason, so
 * `/brains why` can tell the owner why a big model was (or wasn't) used.
 */
export function estimateComplexity(text, opts = {}) {
  const raw = String(text ?? '');
  const list = words(raw);
  const lower = raw.toLowerCase();
  const reasons = [];
  let score = 0;

  const add = (points, why) => { score += points; reasons.push(`${points > 0 ? '+' : ''}${points} ${why}`); };

  // ── length: long asks usually carry several requirements ──────────────────
  if (list.length >= 150) add(5, 'very long request');
  else if (list.length >= 60) add(3, 'long request');
  else if (list.length >= 25) add(1, 'medium length');
  else if (list.length <= 4) add(-1, 'very short');

  // ── how many separate actions / steps ────────────────────────────────────
  const actionHits = new Set();
  for (const word of list) {
    const clean = word.toLowerCase().replace(/[^a-z\u0900-\u097f]/g, '');
    if (clean && ACTION_VERBS.includes(clean)) actionHits.add(clean);
  }
  if (actionHits.size >= 4) add(4, `${actionHits.size} actions`);
  else if (actionHits.size >= 2) add(2, `${actionHits.size} actions`);
  else if (actionHits.size === 1) add(1, 'one action');

  // "all / every / har / sab" plus an action = bulk work, not a one-liner.
  if (actionHits.size > 0 && /\b(all|every|each|har|sab|saare|saari|bulk)\b/i.test(lower)) add(2, 'bulk change');

  const connectors = (lower.match(MULTI_STEP) ?? []).length;
  if (connectors) add(Math.min(connectors * 2, 6), `${connectors} step connector(s)`);

  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length >= 3) add(2, `${lines.length} listed instructions`);

  // ── reasoning / knowledge work ───────────────────────────────────────────
  const hardHits = HARD_WORDS.filter((w) => lower.includes(w)).length;
  if (hardHits) add(Math.min(hardHits * 2, 6), `${hardHits} reasoning cue(s)`);
  const codeHits = CODE_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(lower)).length;
  if (codeHits) add(Math.min(codeHits * 3, 6), `${codeHits} code cue(s)`);
  if (/\b(how|why|kaise|kyun)\b/.test(lower) && list.length > 5) add(1, 'explanation question');

  // ── "make it long / complete" ────────────────────────────────────────────
  if (/\b(detailed|in\s+detail|in\s+depth|step\s+by\s+step|complete|full|everything|all\s+the|comprehensive|long)\b/.test(lower)) {
    add(2, 'asks for a thorough answer');
  }

  // ── raw score → tier ─────────────────────────────────────────────────────
  let rank;
  if (score <= 1) rank = 1;
  else if (score <= 4) rank = 2;
  else if (score <= 8) rank = 3;
  else rank = 4;

  if (opts.forceTier && TIER_RANK[opts.forceTier]) {
    rank = TIER_RANK[opts.forceTier];
    reasons.push(`forced to ${opts.forceTier}`);
  }
  if (opts.minTier && TIER_RANK[opts.minTier]) rank = Math.max(rank, TIER_RANK[opts.minTier]);
  if (opts.maxTier && TIER_RANK[opts.maxTier]) rank = Math.min(rank, TIER_RANK[opts.maxTier]);
  rank = clampRank(rank);

  // Taking a screenshot does NOT need a vision model — only interpreting an
  // image does. Callers therefore opt in explicitly (describeImage does).
  const needsVision = Boolean(opts.needsVision || opts.image);
  // Only the text decides this here; plan() can force it for a /agent call.
  const needsTools = actionHits.size > 0;
  const wantsPlan = Boolean(opts.wantsPlan || /^(plan|steps)\b/i.test(raw) || (rank >= 3 && connectors > 0));

  return {
    score,
    rank,
    tier: RANK_TIER[rank],
    reasons,
    needsTools,
    needsVision,
    wantsPlan,
    wordCount: list.length,
  };
}

/** True when the task clearly belongs on a website (needs a real browser). */
export function looksLikeWebTask(text) {
  const t = String(text ?? '');
  return WEB_DEST.test(t) && WEB_ACTION.test(t);
}

// ── the model catalog ────────────────────────────────────────────────────────

/**
 * Rough capability score (1-10) from the model name. Not science — just
 * enough to stop a 3B local model from being handed a heavy job while a free
 * 70B model sits idle, and to stop a 70B model being woken for "hi".
 */
export function inferQuality(name, fallback = 5) {
  const text = String(name ?? '').toLowerCase();
  const params = text.match(/(\d+(?:\.\d+)?)\s*b\b/);
  if (params) {
    const size = Number(params[1]);
    if (size <= 1.5) return 2;
    if (size <= 4) return 3;
    if (size <= 9) return 5;
    if (size <= 15) return 6;
    if (size <= 34) return 7;
    if (size <= 80) return 8;
    return 9;
  }
  return fallback;
}

/**
 * Build the list of brains this install can actually use.
 *
 * Every entry: { id, provider, model, label, minTier, maxTier, local, cost,
 *                speed, vision, tools }
 *   minTier/maxTier = the work sizes this model should be given.
 *   cost           = 0 local · 1 free cloud · 2 paid (never used by default).
 */
export function buildCatalog(config = {}) {
  const models = [];
  const add = (m) => {
    if (!m.model) return;
    models.push({
      id: `${m.provider}:${m.model}`,
      provider: m.provider,
      model: m.model,
      label: m.label ?? `${m.provider} · ${m.model}`,
      minTier: m.minTier ?? 1,
      maxTier: m.maxTier ?? 4,
      local: Boolean(m.local),
      cost: m.cost ?? (m.local ? 0 : 1),
      speed: m.speed ?? 3,
      vision: Boolean(m.vision),
      tools: m.tools !== false,
      quality: m.quality ?? inferQuality(m.model, 5),
      note: m.note ?? '',
    });
  };

  // ── Ollama (this PC): free, private, no quota ────────────────────────────
  const main = config.ollamaModel || 'llama3.2';
  const small = config.ollamaModelSmall || '';
  const heavy = config.ollamaModelHeavy || '';

  if (small && small !== main) {
    add({ provider: 'ollama', model: small, label: `Ollama (local) · ${small}`, local: true, minTier: 1, maxTier: 2, speed: 5, tools: true, quality: Math.min(4, inferQuality(small, 3)) });
  }
  add({ provider: 'ollama', model: main, label: `Ollama (local) · ${main}`, local: true, minTier: small ? 2 : 1, maxTier: heavy ? 3 : 4, speed: small ? 4 : 3, tools: true, quality: inferQuality(main, 3) });
  if (heavy && heavy !== main) {
    add({ provider: 'ollama', model: heavy, label: `Ollama (local) · ${heavy}`, local: true, minTier: 3, maxTier: 4, speed: 2, tools: true, quality: inferQuality(heavy, 6) });
  }
  // A dedicated vision model (llava / qwen2.5-vl / moondream …)
  if (config.ollamaVisionModel) {
    add({
      provider: 'ollama', model: config.ollamaVisionModel,
      label: `Ollama vision · ${config.ollamaVisionModel}`,
      local: true, minTier: 1, maxTier: 4, speed: 2, vision: true, tools: false,
      quality: inferQuality(config.ollamaVisionModel, 5),
      note: 'sees images',
    });
  }

  // ── Groq free tier: very fast, generous but rate-limited ─────────────────
  if (config.groqApiKey) {
    add({
      provider: 'groq', model: config.groqModelSmall || 'llama-3.1-8b-instant',
      label: `Groq (free) · ${config.groqModelSmall || 'llama-3.1-8b-instant'}`,
      minTier: 1, maxTier: 2, speed: 6, tools: true, cost: 1, quality: 4,
    });
    add({
      provider: 'groq', model: config.groqModel || 'llama-3.3-70b-versatile',
      label: `Groq (free) · ${config.groqModel || 'llama-3.3-70b-versatile'}`,
      minTier: 3, maxTier: 4, speed: 5, tools: true, cost: 1, quality: inferQuality(config.groqModel || 'llama-3.3-70b-versatile', 8),
    });
  }

  // ── Gemini free tier: good long context + vision ─────────────────────────
  if (config.geminiApiKey) {
    add({
      provider: 'gemini', model: config.geminiModel || 'gemini-2.0-flash',
      label: `Gemini (free) · ${config.geminiModel || 'gemini-2.0-flash'}`,
      minTier: 2, maxTier: 3, speed: 5, tools: true, vision: true, cost: 1, quality: 7,
    });
    if (config.geminiModelHeavy && config.geminiModelHeavy !== config.geminiModel) {
      add({
        provider: 'gemini', model: config.geminiModelHeavy,
        label: `Gemini (free) · ${config.geminiModelHeavy}`,
        minTier: 4, maxTier: 4, speed: 2, tools: true, vision: true, cost: 1, quality: 9,
      });
    }
  }

  // ── OpenRouter free models: handy fallback, sometimes busy ───────────────
  if (config.openrouterApiKey) {
    add({
      provider: 'openrouter', model: config.openrouterModel || 'meta-llama/llama-3.3-70b-instruct:free',
      label: `OpenRouter (free) · ${config.openrouterModel || 'meta-llama/llama-3.3-70b-instruct:free'}`,
      minTier: 3, maxTier: 4, speed: 3, tools: true, cost: 1, quality: inferQuality(config.openrouterModel || 'llama-3.3-70b', 8),
    });
  }

  return models;
}

// Step/tool budgets per tier — the core of "don't waste power, don't starve big jobs".
export function budgetFor(rank, config = {}) {
  const configuredMax = Math.max(1, Math.min(Number(config.maxAgentSteps ?? 6) || 6, 12));
  const configuredTools = Math.max(8, Math.min(Number(config.agentToolLimit ?? 20) || 20, 64));
  const byRank = {
    1: { maxSteps: Math.min(2, configuredMax), toolLimit: 8 },
    2: { maxSteps: Math.min(3, configuredMax), toolLimit: Math.min(12, configuredTools) },
    3: { maxSteps: Math.min(5, configuredMax), toolLimit: configuredTools },
    4: { maxSteps: Math.min(configuredMax + 2, 12), toolLimit: Math.min(32, Math.max(configuredTools, 24)) },
  };
  return byRank[clampRank(rank)];
}

// ── the router ───────────────────────────────────────────────────────────────

export function createModelRouter({ config = {}, log = console } = {}) {
  const catalog = buildCatalog(config);
  const prefer = String(config.routerPrefer || 'local').toLowerCase(); // local | cloud | balanced
  const cooldownBaseMs = Number(config.modelCooldownMs ?? 120_000) || 120_000;
  const cooldownMaxMs = Number(config.modelCooldownMaxMs ?? 1_800_000) || 1_800_000;
  const heavyWindowMs = Number(config.heavyWindowMs ?? 3_600_000) || 3_600_000;
  const maxHeavyPerHour = Math.max(0, Number(config.maxHeavyPerHour ?? 12) || 0);

  const health = new Map();   // id → { failures, cooldownUntil, lastError, calls, ok, fail, ms, lastUsed, lastOk }
  const decisions = [];       // ring buffer for /brains
  const heavyCalls = [];      // timestamps of heavy-tier calls

  const stat = (id) => {
    if (!health.has(id)) {
      health.set(id, { failures: 0, cooldownUntil: 0, lastError: '', calls: 0, ok: 0, fail: 0, ms: 0, lastUsed: 0, lastOk: null });
    }
    return health.get(id);
  };

  function providerAllowed(model) {
    const want = String(config.aiProvider || 'auto').toLowerCase();
    if (want === 'none') return false;
    if (want === 'auto') return true;
    if (want === 'local') return model.local;
    return model.provider === want;
  }

  function isCooling(model, now = Date.now()) {
    const entry = health.get(model.id);
    if (!entry) return false;
    return entry.cooldownUntil > now;
  }

  function pruneHeavy(now = Date.now()) {
    while (heavyCalls.length && now - heavyCalls[0] > heavyWindowMs) heavyCalls.shift();
  }

  /**
   * Decide the model order for one request.
   * Returns { tier, rank, complexity, candidates, notes, maxSteps, toolLimit, budgetHit }
   */
  function plan(input = {}) {
    const text = String(input.text ?? '');
    const complexity = estimateComplexity(text, input);
    // `needsTools: true` from /agent means "give me tool-capable models", not
    // "pretend this sentence contains an action" (which would trigger nudges).
    const askedForTools = Boolean(input.needsTools);
    let rank = complexity.rank;
    const notes = [];

    // "Power budget": never let a chat flood the biggest models.
    pruneHeavy();
    let budgetHit = false;
    if (rank >= 4 && maxHeavyPerHour > 0 && heavyCalls.length >= maxHeavyPerHour) {
      rank = 3;
      budgetHit = true;
      notes.push(`heavy budget used (${heavyCalls.length}/${maxHeavyPerHour} in the last hour) → standard`);
    }
    rank = clampRank(rank);

    const needsTools = input.needsTools === false ? false : Boolean(complexity.needsTools || askedForTools);
    const needsVision = Boolean(complexity.needsVision || input.needsVision || input.image);

    const eligible = catalog.filter((m) => {
      if (!m.tools && needsTools) return false;
      if (!m.vision && needsVision) return false;
      if (!providerAllowed(m)) return false;
      return true;
    });

    const now = Date.now();
    const fresh = eligible.filter((m) => !isCooling(m, now));
    for (const m of eligible) {
      if (isCooling(m, now)) {
        const left = Math.ceil((health.get(m.id).cooldownUntil - now) / 1000);
        notes.push(`${m.label} cooling down (${left}s)`);
      }
    }

    const covers = (m) => m.minTier <= rank && rank <= m.maxTier;
    const ideal = fresh.filter(covers);
    const bigger = fresh.filter((m) => m.minTier > rank);
    const smaller = fresh.filter((m) => m.maxTier < rank);

    const pref = (m) => {
      if (prefer === 'cloud') return m.local ? 1 : 0;
      if (prefer === 'balanced') return m.local && rank <= 2 ? -1 : 0;
      return m.local ? -1 : 0; // default: local first when it can do the job
    };

    const sortIdeal = (a, b) => {
      if (rank >= 4) {
        // Heavy work: the best brain wins, wherever it runs.
        if (a.quality !== b.quality) return b.quality - a.quality;
        if (pref(a) !== pref(b)) return pref(a) - pref(b);
        return b.speed - a.speed;
      }
      if (rank === 3) {
        // Standard work: needs a competent model; local only if comparable.
        const okA = a.quality >= 5 ? 1 : 0;
        const okB = b.quality >= 5 ? 1 : 0;
        if (okA !== okB) return okB - okA;
        if (pref(a) !== pref(b)) return pref(a) - pref(b);
        if (a.cost !== b.cost) return a.cost - b.cost;
        return b.quality - a.quality || b.speed - a.speed;
      }
      // Tiny/light: fastest + free + local. That is the whole point.
      if (pref(a) !== pref(b)) return pref(a) - pref(b);
      if (a.cost !== b.cost) return a.cost - b.cost;
      return b.speed - a.speed;
    };

    const sortFor = (list, direction) => {
      if (direction === 'ideal') {
        return [...list].sort((a, b) => sortIdeal(a, b) || a.label.localeCompare(b.label));
      }
      return [...list].sort((a, b) => {
        // Escalation: the smallest model that is still bigger than the task
        // first, so a retry costs as little as possible.
        if (direction === 'up' && a.minTier !== b.minTier) return a.minTier - b.minTier;
        // Downgrade: the biggest model that is still below the task.
        if (direction === 'down' && a.maxTier !== b.maxTier) return b.maxTier - a.maxTier;
        if (pref(a) !== pref(b)) return pref(a) - pref(b);
        if (a.cost !== b.cost) return a.cost - b.cost;
        return b.quality - a.quality || b.speed - a.speed;
      });
    };

    const ordered = [
      ...sortFor(ideal, 'ideal'),
      ...sortFor(bigger, 'up'),
      ...sortFor(smaller, 'down'),
    ];

    // Never retry the same model twice in one plan.
    const seen = new Set();
    const candidates = ordered.filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));

    if (!candidates.length && catalog.length) {
      notes.push(needsVision && !catalog.some((m) => m.vision)
        ? 'no vision model configured (set OLLAMA_VISION_MODEL or GEMINI_API_KEY)'
        : 'every configured brain is cooling down — retrying once');
    }

    const budget = budgetFor(rank, config);
    return {
      tier: RANK_TIER[rank],
      rank,
      complexity,
      candidates,
      notes,
      budgetHit,
      needsTools,
      needsVision,
      maxSteps: Number(input.maxSteps ?? budget.maxSteps),
      toolLimit: Number(input.toolLimit ?? budget.toolLimit),
    };
  }

  /** Record how a call went. Failures cool the model down, successes clear it. */
  function record(modelId, { ok, ms = 0, tier, error = '' } = {}) {
    const entry = stat(modelId);
    entry.calls += 1;
    entry.lastUsed = Date.now();
    entry.lastOk = Boolean(ok);
    entry.ms += Math.max(0, Number(ms) || 0);
    if (ok) {
      entry.ok += 1;
      entry.failures = 0;
      entry.cooldownUntil = 0;
      entry.lastError = '';
    } else {
      entry.fail += 1;
      entry.failures += 1;
      entry.lastError = String(error).slice(0, 160);
      const wait = Math.min(cooldownBaseMs * 2 ** (entry.failures - 1), cooldownMaxMs);
      entry.cooldownUntil = Date.now() + wait;
      log.warn?.(`[router] ${modelId} failed (${entry.failures}×) — cooling ${Math.round(wait / 1000)}s: ${entry.lastError}`);
    }
    if (Number(tier) >= 4) {
      pruneHeavy();
      heavyCalls.push(Date.now());
    }
  }

  function noteDecision({ text, tier, model, reason = '' }) {
    decisions.unshift({
      ts: Date.now(),
      text: String(text ?? '').replace(/\s+/g, ' ').slice(0, 60),
      tier,
      model,
      reason: String(reason).slice(0, 120),
    });
    if (decisions.length > 8) decisions.pop();
  }

  function avgMs(entry) {
    return entry && entry.calls ? Math.round(entry.ms / entry.calls) : null;
  }

  /** Plain-text report for `/brains`. Short enough for WhatsApp. */
  function statusText() {
    if (!catalog.length) {
      return [
        '🧠 *Brains* — none configured',
        '',
        'Free options (pick one):',
        '• Ollama on this PC (best): `sudo dnf install ollama && sudo systemctl enable --now ollama && ollama pull llama3.2`',
        '• Groq free key → GROQ_API_KEY in .env',
        '• Gemini free key → GEMINI_API_KEY in .env',
        '',
        'Built-in commands still work with no AI at all.',
      ].join('\n');
    }
    pruneHeavy();
    const line = (m) => {
      const h = health.get(m.id);
      const cooling = h && h.cooldownUntil > Date.now();
      const icon = cooling ? '⏳' : h?.lastOk === false ? '⚠️' : h?.lastOk ? '✅' : '•';
      const tiers = m.minTier === m.maxTier ? RANK_TIER[m.minTier] : `${RANK_TIER[m.minTier]}→${RANK_TIER[m.maxTier]}`;
      const bits = [tiers];
      if (m.vision) bits.push('vision');
      if (m.local) bits.push('local');
      if (h?.calls) bits.push(`${h.ok}/${h.calls} ok · ${avgMs(h)}ms`);
      const tail = cooling ? ` · cooling ${Math.ceil((h.cooldownUntil - Date.now()) / 1000)}s` : h?.lastError && h.lastOk === false ? ` · ${h.lastError.slice(0, 50)}` : '';
      return `${icon} ${m.label} — ${bits.join(' · ')}${tail}`;
    };
    const local = catalog.filter((m) => m.local);
    const cloud = catalog.filter((m) => !m.local);
    const out = ['🧠 *Brains & routing*'];
    out.push(`Mode: ${config.aiProvider || 'auto'} · preference: ${prefer} · tiers tiny→light→standard→heavy`);
    if (local.length) out.push('', '*Local (free, private)*', ...local.map(line));
    if (cloud.length) out.push('', '*Cloud (free tiers)*', ...cloud.map(line));
    out.push('', `⚡ Power budget: ${heavyCalls.length}/${maxHeavyPerHour || '∞'} heavy calls this hour`);
    if (decisions.length) {
      out.push('', '*Recent routing*');
      for (const d of decisions.slice(0, 4)) {
        const ago = Math.max(0, Math.round((Date.now() - d.ts) / 1000));
        out.push(`• "${d.text}" → ${d.tier} · ${d.model.split(':').slice(-1)[0]} (${ago}s ago)`);
      }
    }
    out.push('', '_Say `/brains why <task>` to see how a task would be routed._');
    return out.join('\n');
  }

  /** Explain the routing for one concrete task (`/brains why …`). */
  function explainText(text) {
    const p = plan({ text });
    const lines = [
      `🧠 *Route for:* "${String(text).slice(0, 80)}"`,
      `Work size: *${p.tier}* (score ${p.complexity.score})`,
      `Why: ${p.complexity.reasons.join(', ') || 'short and simple'}`,
      `Needs: ${[p.needsTools ? 'tools' : 'chat only', p.needsVision ? 'vision' : null].filter(Boolean).join(' + ')}`,
      `Steps allowed: ${p.maxSteps} · tools offered: ${p.toolLimit}`,
      '',
      '*Order (first healthy wins):*',
      ...(p.candidates.length
        ? p.candidates.slice(0, 5).map((m, i) => `${i + 1}. ${m.label} (${RANK_TIER[m.minTier]}→${RANK_TIER[m.maxTier]})`)
        : ['none available']),
      ...(p.notes.length ? ['', `Note: ${p.notes.join(' · ')}`] : []),
      '',
      `_Heavy budget: ${heavyCalls.length}/${maxHeavyPerHour || '∞'} used this hour._`,
    ];
    return lines.join('\n');
  }

  function reset() {
    health.clear();
    decisions.length = 0;
    heavyCalls.length = 0;
  }

  function snapshot() {
    return {
      catalog: catalog.map((m) => ({ ...m, health: health.get(m.id) ?? null })),
      decisions: [...decisions],
      heavyUsed: heavyCalls.length,
      maxHeavyPerHour,
      prefer,
    };
  }

  return {
    catalog,
    plan,
    record,
    isCooling,
    noteDecision,
    statusText,
    explainText,
    snapshot,
    reset,
    budget: () => ({ heavyUsed: (pruneHeavy(), heavyCalls.length), maxHeavyPerHour }),
    enabled: catalog.length > 0,
  };
}

// One router per config object, so the health/cooldown memory survives across
// messages (a brain that just timed out is not retried on the next one).
const ROUTERS = new WeakMap();

export function routerFor(config = {}, log = console) {
  if (!config || typeof config !== 'object') return createModelRouter({ config: {}, log });
  let router = ROUTERS.get(config);
  if (!router) {
    router = createModelRouter({ config, log });
    ROUTERS.set(config, router);
  }
  return router;
}
