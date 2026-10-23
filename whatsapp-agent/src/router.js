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

import { brainFailure } from './brainrequest.js';

export const TIERS = ['tiny', 'light', 'standard', 'heavy'];
export const TIER_RANK = { tiny: 1, light: 2, standard: 3, heavy: 4 };
export const RANK_TIER = { 1: 'tiny', 2: 'light', 3: 'standard', 4: 'heavy' };

const clampRank = (n) => Math.max(1, Math.min(4, Math.round(Number(n) || 0)));

// Cloud model IDs that can read images. We cannot probe a provider's
// capabilities without spending a request, so a conservative name check +
// explicit *_VISION_MODEL overrides keep routing honest.
const VISION_MODEL_RE = /(vision|\bvl\b|-vl|llava|pixtral|omni|gemma-4|gemma4|qwen3\.[5-9]|llama-4|gpt-4o)/i;
const looksVisionModel = (id) => VISION_MODEL_RE.test(String(id ?? ''));

const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean);

// Verbs that mean "actually do something on the PC", not "chat".
const ACTION_VERBS = [
  'open', 'close', 'launch', 'kill', 'run', 'execute', 'install', 'download', 'upload',
  'save', 'write', 'create', 'make', 'delete', 'remove', 'move', 'copy', 'rename', 'zip',
  'unzip', 'extract', 'send', 'share', 'search', 'find', 'scan', 'record', 'capture',
  'screenshot', 'type', 'click', 'tap', 'press', 'play', 'pause', 'mute', 'unmute', 'volume',
  'brightness', 'wifi', 'bluetooth', 'restart', 'reboot', 'shutdown', 'lock',
  'schedule', 'remind', 'translate', 'summarise', 'summarize', 'email', 'backup',
  'fire', 'spin', 'crank', 'dim', 'brighten', 'elevate', 'rephrase',
  // Hinglish + Slang + Shorthand
  'kholo', 'khol', 'kholdo', 'band', 'bnd', 'bhej', 'bhejo', 'bhj', 'bhjo', 'bhejdo',
  'banao', 'bana', 'likho', 'likh', 'dhundo', 'dhoondo', 'dhund', 'hata', 'hatao', 'htao',
  'chalao', 'chlao', 'chalu', 'chlu', 'bandh', 'kaato', 'lagao', 'karo', 'kro', 'krdo', 'kardo',
  'dlt', 'dlte', 'rcrd', 'btao', 'dikhado',
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
  // Mentioning GitHub/a website in a coding or research task is not an
  // instruction to blindly type the entire task into a browser search box.
  if (/\b(debug|refactor|scrape|research|implement|coding)\b|\b(fix|review|edit|write|create|build)\b[\s\S]{0,100}\b(code|script|repo|repository|api|bug)\b/i.test(t)) return false;
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
const modelList = (value) => (Array.isArray(value) ? value : String(value || '').split(','))
  .map((name) => String(name).trim()).filter(Boolean);

export function buildCatalog(config = {}) {
  const models = [];
  const add = (m) => {
    if (!m.model) return;
    const existing = models.find((entry) => entry.provider === m.provider && entry.model === m.model && entry.baseUrl === (m.baseUrl || ''));
    if (existing) {
      existing.vision ||= Boolean(m.vision);
      existing.tools ||= m.tools !== false;
      existing.minTier = Math.min(existing.minTier, m.minTier ?? 1);
      existing.maxTier = Math.max(existing.maxTier, m.maxTier ?? 4);
      existing.quality = Math.max(existing.quality, m.quality ?? inferQuality(m.model, 5));
      return;
    }
    const baseId = `${m.provider}:${m.model}`;
    const id = models.some((entry) => entry.id === baseId) ? `${baseId}@endpoint-${models.length + 1}` : baseId;
    models.push({
      id,
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
      baseUrl: m.baseUrl ?? '',
      apiKey: m.apiKey ?? '',
      note: m.note ?? '',
    });
  };

  // ── Local OpenAI-compatible server (llama.cpp / LM Studio / vLLM) ───────
  // Any Hugging Face GGUF served by llama-server lands here. Free, private,
  // and usually the fastest option because there is no network at all.
  if (config.localApiUrl) {
    const mainName = config.localModel || 'local-model';
    if (config.localApiUrlSmall && config.localModelSmall) {
      add({
        provider: 'local', model: config.localModelSmall, baseUrl: config.localApiUrlSmall, apiKey: config.localApiKey,
        label: `Local · ${config.localModelSmall}`, local: true, minTier: 1, maxTier: 2, speed: 6, tools: true,
        quality: Math.min(4, inferQuality(config.localModelSmall, 3)),
      });
    }
    add({
      provider: 'local', model: mainName, baseUrl: config.localApiUrl, apiKey: config.localApiKey,
      label: `Local · ${mainName}`, local: true,
      minTier: config.localApiUrlSmall ? 2 : 1,
      maxTier: config.localApiUrlHeavy ? 3 : 4,
      speed: config.localApiUrlSmall ? 4 : 3,
      tools: true,
      quality: inferQuality(mainName, 5),
    });
    if (config.localApiUrlHeavy && config.localModelHeavy) {
      add({
        provider: 'local', model: config.localModelHeavy, baseUrl: config.localApiUrlHeavy, apiKey: config.localApiKey,
        label: `Local · ${config.localModelHeavy}`, local: true, minTier: 3, maxTier: 4, speed: 2, tools: true,
        quality: inferQuality(config.localModelHeavy, 6),
      });
    }
  }
  // A vision endpoint is independent: LOCAL_API_URL_VISION + LOCAL_MODEL_VISION
  // is enough on its own (that is the "hands stay on this PC" setup, and it
  // must not require a separate text server).
  if (config.localApiUrlVision && config.localModelVision) {
    add({
      provider: 'local', model: config.localModelVision, baseUrl: config.localApiUrlVision, apiKey: config.localApiKey,
      label: `Local vision · ${config.localModelVision}`, local: true,
      minTier: 1, maxTier: 4, speed: 2, vision: true, tools: false,
      quality: inferQuality(config.localModelVision, 5), note: 'sees images',
    });
  }

  // ── Ollama (this PC): free, private, no quota ────────────────────────────
  const main = config.ollamaModel || 'llama3.2';
  const small = config.ollamaModelSmall || '';
  const heavy = config.ollamaModelHeavy || '';

  if (small && small !== main) {
    add({ provider: 'ollama', model: small, baseUrl: config.ollamaUrl, label: `Ollama (local) · ${small}`, local: true, minTier: 1, maxTier: 2, speed: 5, tools: true, quality: Math.min(4, inferQuality(small, 3)) });
  }
  add({ provider: 'ollama', model: main, baseUrl: config.ollamaUrl, label: `Ollama (local) · ${main}`, local: true, minTier: small ? 2 : 1, maxTier: heavy ? 3 : 4, speed: small ? 4 : 3, tools: true, quality: inferQuality(main, 3) });
  if (heavy && heavy !== main) {
    add({ provider: 'ollama', model: heavy, baseUrl: config.ollamaUrl, label: `Ollama (local) · ${heavy}`, local: true, minTier: 3, maxTier: 4, speed: 2, tools: true, quality: inferQuality(heavy, 6) });
  }
  // A dedicated vision model (llava / qwen2.5-vl / moondream …)
  if (config.ollamaVisionModel) {
    add({
      provider: 'ollama', model: config.ollamaVisionModel, baseUrl: config.ollamaUrl,
      label: `Ollama vision · ${config.ollamaVisionModel}`,
      local: true, minTier: 1, maxTier: 4, speed: 2, vision: true, tools: false,
      quality: inferQuality(config.ollamaVisionModel, 5),
      note: 'sees images',
    });
  }

  // ── Groq free tier: very fast, generous but rate-limited ─────────────────
  // Free catalogue since Aug 2026: gpt-oss-20b (small), gpt-oss-120b (big),
  // qwen3.8-27b (the only vision model). Llama 3.1/3.3 are enterprise-only.
  if (config.groqApiKey) {
    const small = config.groqModelSmall || 'openai/gpt-oss-20b';
    const big = config.groqModel || 'openai/gpt-oss-120b';
    const vision = config.groqVisionModel === undefined ? 'qwen/qwen3.8-27b' : (config.groqVisionModel || '');
    const sees = (id) => Boolean(vision) && vision === id;
    add({
      provider: 'groq', model: small, label: `Groq (free) · ${small}`,
      minTier: 1, maxTier: 2, speed: 6, tools: true, vision: sees(small), cost: 1, quality: 4,
    });
    add({
      provider: 'groq', model: big, label: `Groq (free) · ${big}`,
      minTier: 3, maxTier: 4, speed: 5, tools: true, vision: sees(big), cost: 1, quality: inferQuality(big, 9),
    });
    for (const model of modelList(config.groqModelFallbacks)) {
      add({ provider: 'groq', model, minTier: 2, maxTier: 4, speed: 5, tools: true, vision: sees(model), quality: inferQuality(model, 7) });
    }
    if (vision && vision !== small && vision !== big) {
      add({
        provider: 'groq', model: vision, label: `Groq vision · ${vision}`,
        minTier: 2, maxTier: 3, speed: 5, tools: true, vision: true, cost: 1, quality: inferQuality(vision, 9),
      });
    }
  }

  // ── Gemini free tier: good long context + vision ─────────────────────────
  if (config.geminiApiKey) {
    add({
      provider: 'gemini', model: config.geminiModel || 'gemini-3.8-flash',
      label: `Gemini (free) · ${config.geminiModel || 'gemini-3.8-flash'}`,
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

  // ── OpenRouter free models: wide menu, handy fallback, sometimes busy ────
  if (config.openrouterApiKey) {
    const main = config.openrouterModel || 'google/gemma-4-31b-it:free';
    const vision = config.openrouterVisionModel || '';
    const sees = vision ? vision === main : looksVisionModel(main);
    add({
      provider: 'openrouter', model: main, label: `OpenRouter (free) · ${main}`,
      minTier: 3, maxTier: 4, speed: 3, tools: true, vision: sees, cost: 1, quality: main === 'openrouter/free' ? 5 : inferQuality(main, 8),
    });
    // A named :free model can disappear or have no live tool endpoints.
    // The free auto-router is a last-resort fallback, never a paid model.
    const fallbacks = config.openrouterModelFallbacks === undefined ? ['openrouter/free'] : modelList(config.openrouterModelFallbacks);
    for (const model of fallbacks) {
      add({ provider: 'openrouter', model, minTier: 3, maxTier: 4, speed: 3, tools: true, vision: vision ? vision === model : looksVisionModel(model), quality: model === 'openrouter/free' ? 5 : inferQuality(model, 7) });
    }
    if (vision && vision !== main) {
      add({
        provider: 'openrouter', model: vision, label: `OpenRouter vision · ${vision}`,
        minTier: 2, maxTier: 3, speed: 3, tools: true, vision: true, cost: 1, quality: inferQuality(vision, 8),
      });
    }
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
  const cooldownBaseMs = Math.max(1, Number(config.modelCooldownMs ?? 120_000) || 120_000);
  const cooldownMaxMs = Math.max(cooldownBaseMs, Number(config.modelCooldownMaxMs ?? 1_800_000) || 1_800_000);
  const heavyWindowMs = Math.max(1, Number(config.heavyWindowMs ?? 3_600_000) || 3_600_000);
  const maxHeavyPerHour = Math.max(0, Number(config.maxHeavyPerHour ?? 12) || 0);

  const health = new Map();   // id → { failures, cooldownUntil, lastError, calls, ok, fail, ms, lastUsed, lastOk }
  const providerCooldowns = new Map(); // invalid shared credentials must not be retried for each sibling model
  const decisions = [];       // ring buffer for /brains
  const heavyCalls = [];      // timestamps of heavy-tier calls

  const stat = (id) => {
    if (!health.has(id)) {
      health.set(id, { failures: 0, cooldownUntil: 0, lastError: '', calls: 0, ok: 0, fail: 0, ms: 0, emaMs: null, lastUsed: 0, lastOk: null });
    }
    return health.get(id);
  };

  function providerAllowed(model) {
    const want = String(config.aiProvider || 'auto').toLowerCase();
    if (want === 'none') return false;
    if (want === 'auto') return true;
    if (want === 'local') return model.local;
    if (want === 'llamacpp' || want === 'llama.cpp' || want === 'llama-server') return model.provider === 'local';
    return model.provider === want;
  }

  const providerKey = (model) => `${model.provider}:${model.baseUrl || config[`${model.provider}BaseUrl`] || ''}`;
  const providerHealth = (model) => providerCooldowns.get(providerKey(model));
  const cooldownUntil = (model) => Math.max(health.get(model.id)?.cooldownUntil || 0, providerHealth(model)?.cooldownUntil || 0);

  function isCooling(model, now = Date.now()) {
    return cooldownUntil(model) > now;
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
      if (budgetHit && (m.quality >= 8 || m.minTier >= 4)) return false;
      return true;
    });

    const now = Date.now();
    const fresh = eligible.filter((m) => !isCooling(m, now));
    for (const m of eligible) {
      if (isCooling(m, now)) {
        const left = Math.ceil((cooldownUntil(m) - now) / 1000);
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

    const emaLatencyDiff = (a, b) => {
      const ha = health.get(a.id);
      const hb = health.get(b.id);
      if (ha?.emaMs != null && hb?.emaMs != null && Math.abs(ha.emaMs - hb.emaMs) >= 150) {
        return ha.emaMs - hb.emaMs;
      }
      return 0;
    };

    const sortIdeal = (a, b) => {
      if (rank >= 4) {
        // Heavy work: the best brain wins, wherever it runs.
        if (a.quality !== b.quality) return b.quality - a.quality;
        if (pref(a) !== pref(b)) return pref(a) - pref(b);
        return emaLatencyDiff(a, b) || (b.speed - a.speed);
      }
      if (rank === 3) {
        // Standard work: needs a competent model; local only if comparable.
        const okA = a.quality >= 5 ? 1 : 0;
        const okB = b.quality >= 5 ? 1 : 0;
        if (okA !== okB) return okB - okA;
        if (pref(a) !== pref(b)) return pref(a) - pref(b);
        if (a.cost !== b.cost) return a.cost - b.cost;
        return b.quality - a.quality || emaLatencyDiff(a, b) || (b.speed - a.speed);
      }
      // Tiny/light: fastest + free + local. That is the whole point.
      if (pref(a) !== pref(b)) return pref(a) - pref(b);
      if (a.cost !== b.cost) return a.cost - b.cost;
      return emaLatencyDiff(a, b) || (b.speed - a.speed);
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

    // A weak local model can nominally cover every tier. Do not let that
    // push capable standard/vision cloud fallbacks behind a tiny local brain.
    const ordered = rank >= 4 ? sortFor(fresh, 'ideal') : [
      ...sortFor(ideal, 'ideal'),
      ...sortFor(bigger, 'up'),
      ...sortFor(smaller, 'down'),
    ];

    // A tiny/light task is safe on any larger capable model. Honor an
    // explicit cloud preference across fallback tiers too, rather than
    // burning the final slot on an unconfigured local default first.
    if (rank <= 2 && prefer === 'cloud') ordered.sort((a, b) => pref(a) - pref(b));

    // Never retry the same model twice in one plan.
    const seen = new Set();
    const candidates = ordered.filter((m) => (seen.has(m.id) ? false : seen.add(m.id)));

    if (!candidates.length && catalog.length) {
      notes.push(!catalog.some(providerAllowed)
        ? 'no configured brain is allowed by AI_PROVIDER'
        : !eligible.length
          ? budgetHit ? 'heavy power budget exhausted and no lighter compatible brain is configured'
            : `no ${needsVision ? 'vision' : 'tool-capable'} model available for this provider`
          : `every eligible brain is cooling down — retry after ${Math.max(1, Math.ceil((Math.min(...eligible.map(cooldownUntil)) - now) / 1000))}s`);
    }

    // Saving model power must not also starve an inherently heavy task of
    // the steps/tools it needs to finish.
    const budget = budgetFor(complexity.rank, config);
    return {
      tier: RANK_TIER[rank],
      requestedTier: complexity.tier,
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

  // Optional observer (usage.js): told about every call so /usage can show the
  // day's quota. Never allowed to break a model call.
  let recordHook = null;
  function setRecordHook(fn) {
    recordHook = typeof fn === 'function' ? fn : null;
  }

  /** Record how a call went. Failures cool the model down, successes clear it. */
  function record(modelId, { ok, ms = 0, tier, error = '' } = {}) {
    const failure = ok ? null : brainFailure(error, config);
    try { recordHook?.(modelId, { ok: Boolean(ok), ms, tier, error: failure?.message || '' }); } catch { /* usage must never break a call */ }
    const entry = stat(modelId);
    const model = catalog.find((m) => m.id === modelId);
    entry.calls += 1;
    entry.lastUsed = Date.now();
    entry.lastOk = Boolean(ok);
    entry.ms += Math.max(0, Number(ms) || 0);
    if (ok) {
      entry.ok += 1;
      entry.failures = 0;
      entry.cooldownUntil = 0;
      entry.lastError = '';
      entry.errorKind = '';
      entry.hint = '';
      if (model) providerCooldowns.delete(providerKey(model));
      const dur = Math.max(0, Number(ms) || 0);
      if (dur > 0) {
        entry.emaMs = entry.emaMs == null ? dur : Math.round(entry.emaMs * 0.7 + dur * 0.3);
      }
    } else {
      entry.fail += 1;
      entry.failures += 1;
      entry.lastError = failure.message;
      entry.errorKind = failure.kind;
      entry.hint = failure.hint;
      entry.lastStatus = failure.status;
      const wait = Math.max(Math.min(cooldownBaseMs * 2 ** (entry.failures - 1), cooldownMaxMs), Math.min(failure.retryAfterMs, 86_400_000));
      entry.cooldownUntil = Date.now() + wait;
      if (model && failure.providerWide) providerCooldowns.set(providerKey(model), { ...entry });
      log.warn?.(`[router] ${modelId} failed (${entry.failures}×) — cooling ${Math.round(wait / 1000)}s: ${entry.lastError}`);
    }
    // Failed HTTP requests never earned a heavy-model answer. Charging every
    // fallback failure used to exhaust the hourly budget without doing work.
    if (ok && Number(tier) >= 4) {
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
    const visible = catalog.filter((m) => providerAllowed(m));
    const line = (m) => {
      const own = health.get(m.id);
      const shared = providerHealth(m);
      const h = shared?.cooldownUntil > Date.now() ? shared : own;
      const cooling = isCooling(m);
      const icon = cooling ? '⏳' : h?.lastOk === false ? '⚠️' : h?.lastOk ? '✅' : '•';
      const tiers = m.minTier === m.maxTier ? RANK_TIER[m.minTier] : `${RANK_TIER[m.minTier]}→${RANK_TIER[m.maxTier]}`;
      const bits = [tiers];
      if (m.vision) bits.push('vision');
      if (m.local) bits.push(m.provider === 'local' ? 'llama.cpp' : 'ollama');
      if (m.baseUrl) {
        try { const url = new URL(m.baseUrl); bits.push(url.port || (url.protocol === 'https:' ? '443' : '80')); } catch { /* plain name */ }
      }
      if (own?.calls) bits.push(`${own.ok}/${own.calls} ok · ${avgMs(own)}ms`);
      const tail = cooling ? ` · cooling ${Math.ceil((cooldownUntil(m) - Date.now()) / 1000)}s` : '';
      const errorLine = h?.lastOk === false && h.lastError ? `
   ${h.errorKind || 'error'}: ${h.lastError.slice(0, 100)}
   ${h.hint || ''}` : '';
      return `${icon} ${m.label} — ${bits.join(' · ')}${tail}${errorLine}`;
    };
    const local = visible.filter((m) => m.local);
    const cloud = visible.filter((m) => !m.local);
    const out = ['🧠 *Brains & routing*'];
    out.push(`Mode: ${config.aiProvider || 'auto'} · preference: ${prefer} · tiers tiny→light→standard→heavy`);
    if (local.length) out.push('', '*Local (free, private)*', ...local.map(line));
    if (cloud.length) out.push('', '*Cloud (free tiers)*', ...cloud.map(line));
    if (!visible.length) {
      out.push('', config.aiProvider === 'local' || config.aiProvider === 'llamacpp'
        ? '❌ AI_PROVIDER=local set, but no LOCAL_API_URL — run: ./scripts/observer.sh models wire <model>'
        : '❌ every brain is filtered out by AI_PROVIDER — check .env');
    }
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
    providerCooldowns.clear();
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
    setRecordHook,
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
