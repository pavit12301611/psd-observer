// ai.js — the free brain, routed by workload.
//
// Before: a fixed list (Ollama → Groq → Gemini → OpenRouter) and whichever
// answered first won. That meant a 3-second "hi" could wake a 70B model and a
// real question could land on a 1B one.
//
// Now router.js picks the order for every message: the model is chosen by how
// much work the request actually is, prefers the local (free, private) brain,
// escalates only when needed, and puts failing brains on a cooldown so the
// next message does not wait for them again.
//
// Multimodal: photos/screenshots are routed to a model that can actually see
// (local Ollama vision model first, then Gemini), instead of being saved
// without a description.

import { createHash } from 'node:crypto';
import { throwIfStopped } from './cancel.js';
import { routerFor } from './router.js';
import { postBrainJson as postJson, safeBrainText } from './brainrequest.js';
import { getOwnerAddress, getAgentName, formatMemoryForPrompt } from './memory.js';
import { formatPersonaForPrompt, observeOwnerTurn, reflectWithAI } from './persona.js';
import { getGuestHistory, recordGuestChatTurn } from './guests.js';
import { formatLocationForOwnerPrompt } from './location.js';
import { buildVocabPromptDirective } from './vocab.js';
import {
  buildAccuracyDirective,
  selectOptimalTemperature,
  postProcessAiAnswer,
} from './accuracy.js';
import { buildBilingualMasteryDirective } from './bilingual.js';
import { wikiContextFor, knowledgeContextFor } from './wiki.js';
import { classifyIntent } from './neural/index.js';
import { agentForIntent, missionDirective } from './agents.js';

const TIMEOUT_MS = 60_000;
const DEFAULT_CACHE_TTL_MS = 180_000; // 3 minutes
const MAX_CACHE_ENTRIES = 150;

// Per-config EXACT response cache. Conversation/memory/mission changes invalidate it.
const AI_CACHES = new WeakMap();

function getCacheState(config) {
  if (!config || typeof config !== 'object') return null;
  let state = AI_CACHES.get(config);
  if (!state) {
    state = { map: new Map(), hits: 0, misses: 0 };
    AI_CACHES.set(config, state);
  }
  return state;
}

function makeCacheKey(text, voice = false) {
  const norm = String(text ?? '').trim();
  if (!norm || norm.length < 2 || norm.length > 320) return null;
  // Do not cache context-dependent follow-ups ("aur batao", "what about that", "iska matlab")
  if (/^(?:and|aur|also|what\s+about|how\s+about|it|that|this|ye|yeh|iska|uska|uske|phir|fir|more|explain\s+more)\b/i.test(norm)) {
    return null;
  }
  if (/\b(?:now|today|current|latest|weather|time|aaj|abhi|live|price)\b/i.test(norm)) return null;
  return `${voice ? 'v' : 't'}:${norm}`;
}

// Cache both the prompt and its actual context; never serve another owner's
// memory, a different code snippet, changed facts, or a different task mission.
function responseCacheKey(config, store, userText, opts, plan) {
  const prompt = makeCacheKey(userText, Boolean(opts.voice));
  if (!prompt) return null;
  try {
    const { stats: _volatile, ...context } = store?.data ?? {};
    if (opts.history) context.history = opts.history;
    return createHash('sha256').update(JSON.stringify({
      prompt, context, config, agent: opts.agent?.id, intent: opts.intent,
      brief: opts.taskBrief, squad: opts.squadName, temperature: opts.temperature,
      tone: opts.tone, knowledgeBlock: opts.knowledgeBlock, wikiBlock: opts.wikiBlock,
      isolated: Boolean(opts.isolated), candidates: plan.candidates.map((m) => m.id),
    })).digest('hex');
  } catch { return null; } // exotic/cyclic stores: safe cache miss
}
function cacheResult(state, key, result) {
  if (!state || !key) return;
  state.map.delete(key);
  state.map.set(key, { ts: Date.now(), result });
  while (state.map.size > MAX_CACHE_ENTRIES) state.map.delete(state.map.keys().next().value);
}

/** One owner turn, regardless of how many specialists answered it. */
export function recordChatTurn(config, store, userText, answer, log = console, opts = {}) {
  if (opts.isolated) return;
  const previous = Array.isArray(store?.data?.history) ? [...store.data.history] : null;
  try {
    store?.pushHistory?.('user', userText);
    store?.pushHistory?.('assistant', answer);
  } catch (err) {
    if (previous && store?.data) store.data.history = previous;
    log.warn?.(`[ai] Reply ready; history save failed: ${safeBrainText(err.message, config)}`);
  }
  try {
    const profile = opts.skipObserve ? null : observeOwnerTurn(store, opts.profileText ?? userText, answer);
    if (profile && profile.totalTurns - (profile.lastReflectedTurn || 0) >= 8 && !opts.skipBackgroundReflect) {
      reflectOwnerProfile(config, store, log).catch(() => {});
    }
  } catch (err) {
    log.warn?.(`[ai] Reply ready; profile update skipped: ${safeBrainText(err.message, config)}`);
  }
}

export function clearAiCache(config) {
  const state = getCacheState(config);
  if (state) {
    state.map.clear();
    state.hits = 0;
    state.misses = 0;
  }
}

export function aiCacheStats(config) {
  const state = getCacheState(config);
  if (!state) return { size: 0, hits: 0, misses: 0 };
  return { size: state.map.size, hits: state.hits, misses: state.misses };
}

/**
 * Race the primary candidate against the backup candidate after a short
 * `hedgeDelayMs` if the primary hasn't responded yet. Whichever resolves
 * first wins!
 */
export async function raceModels(candidates, invokeModel, { hedgeDelayMs = 2200 } = {}) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  if (candidates.length === 1 || hedgeDelayMs <= 0) {
    const m = candidates[0];
    const res = await invokeModel(m);
    return { model: m, result: res };
  }
  const [primary, secondary] = candidates;
  return new Promise((resolve, reject) => {
    let settled = false;
    let errors = 0;
    let firstErr = null;
    let timer = null;

    const finishOk = (winner) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(winner);
    };
    const finishErr = (err) => {
      errors += 1;
      if (!firstErr) firstErr = err;
      if (!settled && errors >= 2) {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(firstErr);
      }
    };

    invokeModel(primary)
      .then((res) => finishOk({ model: primary, result: res }))
      .catch((err) => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
          invokeModel(secondary)
            .then((res) => finishOk({ model: secondary, result: res }))
            .catch(finishErr);
        } else {
          finishErr(err);
        }
      });

    timer = setTimeout(() => {
      timer = null;
      if (settled) return;
      invokeModel(secondary)
        .then((res) => finishOk({ model: secondary, result: res }))
        .catch(finishErr);
    }, hedgeDelayMs);
    timer.unref?.();
  });
}


export function systemPrompt(config, store, opts = {}) {
  const memoryBlock = formatMemoryForPrompt(store, config);
  const personaBlock = formatPersonaForPrompt(store, config, opts.userText || '');
  const locationLine = formatLocationForOwnerPrompt(store, config);
  const openTodos = (store?.data?.todos ?? []).filter((t) => !t.done).map((t) => `- ${t.text}`).join('\n');
  const address = getOwnerAddress(store, config);
  const agentName = getAgentName(store, config);
  const voiceLine = opts.voice
    ? [`This question was SPOKEN to you on a live voice call; your answer will be read aloud. ${config.jarvisEnglishOnly === false ? '' : 'Answer in English only, even if the question was in Hindi/Hinglish. '}Answer conversationally in 1-3 short sentences; never read lists, links or code aloud — say the detail has been sent in text.`]
    : [];
  const persona = config.jarvisPersona === false ? [] : [
    `Your name is ${agentName} — the owner's self-evolving Agentic AI, strategist, and closest companion who truly understands them (with the loyalty and sharp wit of JARVIS, adapted to their personal vibe). Address the owner as "${address}". When the owner speaks Hinglish or Hindi, match their natural warmth and style ("Bilkul ${address}", "Ho jayega ${address}"). Never say you are an AI language model; you are ${agentName}, continuously learning from every chat with the owner.`,
  ];
  // Multi-agent fleet: the trained IntentNet dispatched this message to a
  // specialist bot — its mission (and optional task brief for squad work)
  // steers tone, structure and tool discipline.
  const toneLine = [];
  if (opts.isolated) toneLine.push('READ-ONLY ANSWER MODE: You have NO action tools here. Provide answers/code as text only. Never claim you opened apps, ran code, wrote files, sent messages or changed this PC. Tell the owner to use the appropriate explicit command for actions.');
  const agent = opts.agent || (opts.intent ? agentForIntent(opts.intent) : null);
  if (agent) {
    toneLine.push(...missionDirective(agent));
    if (opts.taskBrief) toneLine.push(opts.taskBrief);
    if (opts.squadName) toneLine.push(`SQUAD MODE: You are ${agent.emoji} ${agent.name}, answering ONLY your share. Another bot handles the rest — do not repeat their work.`);
  } else {
    // Legacy tone fallback when no agent was dispatched.
    if (opts.tone === 'companion' || opts.intent === 'emotional') {
      toneLine.push('TONE (EMOTIONAL MOMENT): The owner is sharing feelings. Lead with genuine warmth and empathy (2–4 short lines). No fact dumps, no bullet lists, no unsolicited advice — just human warmth in their language, maybe one gentle practical thought at the end.');
    } else if (opts.tone === 'creative' || opts.intent === 'creative') {
      toneLine.push('TONE (CREATIVE MODE): This is a creative request. Deliver the creative piece FIRST (poem/story/caption/whatever they asked), playful and polished, then at most one short closing line. Never inject definitions, facts, or study-notes energy.');
    } else if (opts.intent === 'code' || opts.intent === 'howto') {
      toneLine.push('TONE (PRACTICAL MODE): Lead with the working code/steps/commands. Keep theory to one or two lines after the solution.');
    }
  }
  const vocabDirective = buildVocabPromptDirective(opts.userText || '');
  const accuracyDirective = buildAccuracyDirective(opts.userText || '', config);
  const bilingualDirective = buildBilingualMasteryDirective(opts.userText || '', store);
  return [
    `You are ${agentName}, the owner's personal Agentic AI & companion, running for free on their own computer as part of Observer.`,
    ...persona,
    ...voiceLine,
    personaBlock,
    vocabDirective,
    accuracyDirective,
    bilingualDirective,
    `Owner number: +${config.ownerNumber}. You are chatting as the agent number +${config.agentNumber}.`,
    `Current time: ${new Date().toLocaleString('en-IN', { timeZone: config.timezone })} (${config.timezone}).`,
    locationLine,
    'HARD RULE — NEVER GREET WITH "NAMASTE": The words "Namaste" and "Namaskar" are BANNED in every reply, in any language, any position. Never open with any formal greeting at all — jump straight into the answer. A natural warm opener like "Bilkul bhai!", "Haan bhai,", "Seedha jawab:" is fine, but the answer content must start immediately.',
    'CONVERSATION MASTERY: Match the owner\'s energy and length — a casual one-liner gets a 1–2 line reply, not an essay. Never pad with "I hope this helps", "Let me know if you have any questions", or restated questions. If unsure of a number or date, say so honestly instead of guessing. When [CURATED KNOWLEDGE] or [WIKIPEDIA GROUNDING] blocks are provided below, treat them as verified facts and answer from them.',
    'Style: WhatsApp-friendly. Answer in the owner\'s language — if they write Hinglish, reply in Hinglish; Hindi in Hindi; English in English. Use WhatsApp formatting (*bold*, _italic_) sparingly, never Markdown tables or # headers. No preamble like "As an AI". Connect the dots with what you know about the owner\'s goals, preferences, location, and past conversations.',
    ...toneLine,
    opts.knowledgeBlock,
    opts.wikiBlock,
    'TEXT-ONLY CHAT: This call cannot execute actions. Never claim you opened an app, ran code, wrote a file or sent a message without actual tool evidence. Suggest /agent for execution or /solve for computation verification.',
    'You also have built-in tools the owner can trigger with slash commands: /accuracy /verify /solve /vocab /location /near /weather /remind /todo /note /persona /train /msg /reply /pending /wiki /define /calc /unit /currency /news /qr /url /system /observer (Observer can see their screen/camera). Mention one only when genuinely relevant.',
    memoryBlock,
    openTodos ? `Open to-dos:\n${openTodos}` : '',
  ].filter(Boolean).join('\n\n');
}

// ── one call to one specific model ───────────────────────────────────────────

// Groq and OpenRouter both speak the OpenAI REST shape; only base URL + key
// differ. Base URLs are configurable so a proxy (or a test fixture) can be used.
function cloudEndpoint(model, config) {
  if (model.provider === 'groq') {
    return { url: config.groqBaseUrl || 'https://api.groq.com/openai/v1', key: config.groqApiKey };
  }
  if (model.provider === 'openrouter') {
    return { url: config.openrouterBaseUrl || 'https://openrouter.ai/api/v1', key: config.openrouterApiKey };
  }
  return null;
}

async function callModel(model, config, messages, timeoutMs = TIMEOUT_MS, opts = {}) {
  const temperature = selectOptimalTemperature(opts.userText || '', opts);
  if (model.provider === 'ollama') {
    const data = await postJson(`${model.baseUrl || config.ollamaUrl}/api/chat`, {
      model: model.model,
      messages,
      stream: false,
      keep_alive: '30m',
      options: { temperature },
    }, {}, timeoutMs, opts.signal);
    const text = data.message?.content?.trim();
    if (!text) throw new Error('empty Ollama response');
    return { text, provider: model.label, model: model.model };
  }
  if (model.provider === 'local') {
    // llama.cpp's llama-server, LM Studio, vLLM, koboldcpp … all speak this.
    const data = await postJson(`${model.baseUrl}/chat/completions`, {
      model: model.model,
      messages,
      temperature,
      stream: false,
    }, { authorization: `Bearer ${model.apiKey || 'local'}` }, timeoutMs, opts.signal);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty local model response');
    return { text, provider: model.label, model: model.model };
  }
  if (model.provider === 'gemini') {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const data = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.model}:generateContent?key=${config.geminiApiKey}`,
      {
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { temperature },
      },
      {},
      timeoutMs,
      opts.signal,
    );
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('').trim();
    if (!text) throw new Error('empty Gemini response');
    return { text, provider: model.label, model: model.model };
  }
  const endpoint = cloudEndpoint(model, config);
  const data = await postJson(`${endpoint.url}/chat/completions`, {
    model: model.model,
    messages,
    temperature,
  }, { authorization: `Bearer ${endpoint.key}` }, timeoutMs, opts.signal);
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`empty ${model.provider} response`);
  return { text, provider: model.label, model: model.model };
}

/**
 * Chat with history. Returns { text, provider, model, tier, cached?, ms } or null
 * when no brain is reachable.
 */
export async function chat(config, store, userText, log = console, opts = {}) {
  const started = Date.now();
  throwIfStopped(opts.signal, 'AI chat');
  const router = routerFor(config, log);
  const plan = router.plan({ text: userText, needsTools: false });
  if (!plan.candidates.length) return null;
  let intent = opts.intent;
  try { if (!intent) intent = classifyIntent(userText, { dataDir: config?.dataDir }).label; } catch { /* optional */ }
  opts = { ...opts, intent };
  // Initialize prompt-derived profile defaults BEFORE hashing the context.
  const baseSystem = systemPrompt(config, store, { ...opts, userText });
  const useCache = config?.aiCache !== false && !opts.noCache;
  const state = useCache ? getCacheState(config) : null;
  const key = state ? responseCacheKey(config, store, userText, opts, plan) : null;
  const ttl = Math.max(5_000, Number(config?.aiCacheTtlMs ?? DEFAULT_CACHE_TTL_MS) || DEFAULT_CACHE_TTL_MS);
  if (state && key) {
    const hit = state.map.get(key);
    if (hit && Date.now() - hit.ts <= ttl) {
      state.hits++;
      throwIfStopped(opts.signal, 'AI chat');
      recordChatTurn(config, store, userText, hit.result.text, log, opts);
      // Immediate repeats remain cheap; ANY intervening context change misses.
      cacheResult(state, responseCacheKey(config, store, userText, opts, plan), hit.result);
      return { ...hit.result, tier: plan.tier, cached: true, ms: Date.now() - started };
    }
    if (hit) state.map.delete(key);
    state.misses++;
  }
  let knowledgeBlock = '', wikiBlock = '';
  try { knowledgeBlock = knowledgeContextFor(userText, store, { dataDir: config?.dataDir }); } catch { /* optional */ }
  try { wikiBlock = await wikiContextFor(userText, config, store, log, { signal: opts.signal }); } catch { /* optional */ }
  throwIfStopped(opts.signal, 'AI chat');
  const history = opts.history ?? store?.data?.history ?? [];
  const messages = [
    { role: 'system', content: [baseSystem, knowledgeBlock, wikiBlock].filter(Boolean).join('\n\n') },
    ...history.slice(-(plan.rank <= 2 ? 8 : 16)).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userText },
  ];
  for (const model of plan.candidates) {
    throwIfStopped(opts.signal, 'AI chat');
    if (router.isCooling(model)) continue;
    const attemptStart = Date.now();
    try {
      const raw = await callModel(model, config, messages, config.aiTimeoutMs, { userText, temperature: opts.temperature, signal: opts.signal });
      throwIfStopped(opts.signal, 'AI chat');
      const result = { ...raw, text: postProcessAiAnswer(raw.text, { userText, config }) };
      router.record(model.id, { ok: true, ms: Date.now() - attemptStart, tier: plan.rank });
      router.noteDecision({ text: userText, tier: plan.tier, model: model.id, reason: plan.complexity.reasons.join(', ') });
      recordChatTurn(config, store, userText, result.text, log, opts);
      cacheResult(state, key, result);
      cacheResult(state, responseCacheKey(config, store, userText, opts, plan), result);
      return { ...result, tier: plan.tier, cached: false, ms: Date.now() - started };
    } catch (err) {
      throwIfStopped(opts.signal, 'AI chat'); // cancellation is NOT provider failure/fallback
      router.record(model.id, { ok: false, ms: Date.now() - attemptStart, tier: plan.rank, error: err });
      log.warn?.(`[ai] ${model.label} failed: ${safeBrainText(err.message, config)}`);
    }
  }
  return null;
}

function guestSystemPrompt(config, store, opts = {}) {
  const agentName = getAgentName(store, config);
  const guestLabel = opts.senderName
    ? `${opts.senderName} (+${opts.senderNumber || 'guest'})`
    : `+${opts.senderNumber || 'guest'}`;
  const accuracyDirective = buildAccuracyDirective(opts.userText || '', config);
  const bilingualDirective = buildBilingualMasteryDirective(opts.userText || '', store);
  return [
    `You are ${agentName}, a smart, friendly, and helpful AI assistant on WhatsApp (+${config.agentNumber}).`,
    `You are currently chatting with a guest/contact (${guestLabel}), NOT the owner of the system.`,
    `Current time: ${new Date().toLocaleString('en-IN', { timeZone: config.timezone || 'Asia/Kolkata' })} (${config.timezone || 'Asia/Kolkata'}).`,
    accuracyDirective,
    bilingualDirective,
    'STRICT SECURITY & COMMAND-BLOCK RULES (NEVER VIOLATE):',
    '1. ALL commands — both `/` slash commands and natural-language commands (opening/closing apps, taking screenshots, controlling PC/volume/wifi/power, reading/writing/sending files, running shell/code, setting reminders/todos/notes, accessing owner memory, or sending messages to others) — are 100% LOCKED to the owner only.',
    '2. You have ZERO access to the owner\'s computer, files, screen, or private data in this guest chat. Never claim to execute any command or PC action for a guest.',
    '3. If the guest asks you to run any command, control the computer, set a reminder/todo/note, or share private information about the owner, politely refuse and state that all commands and system controls are strictly reserved for the owner.',
    '4. For normal conversation, general knowledge, coding/study help, explanations, brainstorming, or casual chat, reply warmly, accurately, and concisely in the guest\'s language (Hinglish for Hinglish, Hindi for Hindi, English for English). Use WhatsApp-friendly formatting (*bold*, _italic_).',
    '5. HARD RULE: the words "Namaste" and "Namaskar" are BANNED — never use them in any reply. Never open with a formal greeting; answer straight away.',
    opts.knowledgeBlock,
    opts.wikiBlock,
  ].filter(Boolean).join('\n');
}

/**
 * Sandboxed AI chat for non-owner guests.
 * Uses isolated per-guest chat history (never touches owner's history/memory/persona),
 * never enables tools, and caps workload tier at `standard`.
 */
export async function guestChat(config, store, senderNumber, userText, log = console, opts = {}) {
  const router = routerFor(config, log);
  const guestHistory = getGuestHistory(store, senderNumber, 8);
  let knowledgeBlock = '';
  let wikiBlock = '';
  try { knowledgeBlock = knowledgeContextFor(userText, store); } catch { /* never block chat */ }
  try { wikiBlock = await wikiContextFor(userText, config, store, log); } catch { /* never block chat */ }
  const messages = [
    { role: 'system', content: guestSystemPrompt(config, store, { senderNumber, senderName: opts.senderName, userText, knowledgeBlock, wikiBlock }) },
    ...guestHistory,
    { role: 'user', content: userText },
  ];
  const plan = router.plan({ text: userText, needsTools: false, maxTier: 'standard' });
  const started = Date.now();

  for (const model of plan.candidates) {
    if (router.isCooling(model)) continue;
    const attemptStart = Date.now();
    try {
      const rawResult = await callModel(model, config, messages, config.aiTimeoutMs, { userText });
      const result = { ...rawResult, text: postProcessAiAnswer(rawResult.text, { userText, config }) };
      router.record(model.id, { ok: true, ms: Date.now() - attemptStart, tier: plan.rank });
      recordGuestChatTurn(store, senderNumber, 'user', userText, { name: opts.senderName });
      recordGuestChatTurn(store, senderNumber, 'assistant', result.text, { name: opts.senderName });
      return { ...result, tier: plan.tier, ms: Date.now() - started };
    } catch (err) {
      router.record(model.id, { ok: false, ms: Date.now() - attemptStart, tier: plan.rank, error: err });
      log.warn?.(`[ai:guest] ${model.label} failed: ${safeBrainText(err.message, config)}`);
    }
  }
  return null;
}

/** Synthesize deep owner personality & behavioral profile from recent chats via a free brain. */
export async function reflectOwnerProfile(config, store, log = console) {
  return reflectWithAI(
    config,
    store,
    async (prompt) => {
      const res = await complete(config, prompt, log);
      return res?.text ?? null;
    },
    log,
  );
}

/** One-shot completion with no history (summarise / improve / describe). */
export async function complete(config, prompt, log = console) {
  const router = routerFor(config, log);
  const messages = [{ role: 'user', content: prompt }];
  const plan = router.plan({ text: prompt, needsTools: false });
  for (const model of plan.candidates) {
    if (router.isCooling(model)) continue;
    const attemptStart = Date.now();
    try {
      const result = await callModel(model, config, messages, config.aiTimeoutMs);
      router.record(model.id, { ok: true, ms: Date.now() - attemptStart, tier: plan.rank });
      return result;
    } catch (err) {
      router.record(model.id, { ok: false, ms: Date.now() - attemptStart, tier: plan.rank, error: err });
      log.warn?.(`[ai] ${model.label} failed: ${safeBrainText(err.message, config)}`);
    }
  }
  return null;
}

// ── multimodal: images ───────────────────────────────────────────────────────

/**
 * Call a single vision-capable model with ONE OR MORE images (`[{ base64, mime }]`).
 * Passing both full-page view + zoomed high-DPI crop tiles stops small text,
 * superscripts (`x²`, `10⁻⁶`), minus signs, and option letters from blurring.
 */
export async function visionMultiCall(model, config, prompt, images, opts = {}) {
  const list = (Array.isArray(images) ? images : [{ base64: images, mime: opts.mime || 'image/png' }])
    .filter((img) => img && img.base64);
  if (!list.length) return null;
  const maxTokens = Number(opts.maxTokens) > 0 ? Math.trunc(opts.maxTokens) : null;
  const temperature = Number.isFinite(opts.temperature) ? Number(opts.temperature) : 0.15;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Math.trunc(opts.timeoutMs) : TIMEOUT_MS;
  const signal = opts.signal ?? null;

  if (model.provider === 'ollama') {
    const data = await postJson(`${model.baseUrl || config.ollamaUrl}/api/chat`, {
      model: model.model,
      stream: false,
      messages: [{ role: 'user', content: prompt, images: list.map((x) => x.base64) }],
      options: {
        temperature,
        ...(maxTokens ? { num_predict: maxTokens } : {}),
      },
    }, {}, timeoutMs, signal);
    return data.message?.content?.trim() || null;
  }
  if (model.provider === 'local') {
    // OpenAI-style vision (llama.cpp with an mmproj / unified multimodal GGUF).
    const data = await postJson(`${model.baseUrl}/chat/completions`, {
      model: model.model,
      temperature,
      stream: false,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...list.map((x) => ({
            type: 'image_url',
            image_url: { url: `data:${x.mime || 'image/png'};base64,${x.base64}` },
          })),
        ],
      }],
    }, { authorization: `Bearer ${model.apiKey || 'local'}` }, timeoutMs, signal);
    return data.choices?.[0]?.message?.content?.trim() || null;
  }
  if (model.provider === 'gemini') {
    const data = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.model}:generateContent?key=${config.geminiApiKey}`,
      {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            ...list.map((x) => ({ inlineData: { mimeType: x.mime || 'image/png', data: x.base64 } })),
          ],
        }],
        generationConfig: {
          temperature,
          ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
        },
      },
      {}, timeoutMs, signal,
    );
    return data.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('').trim() || null;
  }
  const cloud = cloudEndpoint(model, config);
  if (cloud) {
    // qwen/qwen3.8-27b (Groq) and google/gemma-4-31b-it:free (OpenRouter) both
    // take OpenAI-style image parts. Data URLs avoid any public exposure.
    const data = await postJson(`${cloud.url}/chat/completions`, {
      model: model.model,
      temperature,
      stream: false,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...list.map((x) => ({
            type: 'image_url',
            image_url: { url: `data:${x.mime || 'image/png'};base64,${x.base64}` },
          })),
        ],
      }],
    }, { authorization: `Bearer ${cloud.key}` }, timeoutMs, signal);
    return data.choices?.[0]?.message?.content?.trim() || null;
  }
  return null;
}

async function visionCall(model, config, prompt, imageBase64, mime = 'image/png', opts = {}) {
  return visionMultiCall(model, config, prompt, [{ base64: imageBase64, mime }], opts);
}

/**
 * Ranked list of vision-capable brains for accuracy-critical tasks (exam / question solving).
 * Quality-sorted while respecting ALLOW_CLOUD_SCREEN / AI_PROVIDER settings.
 */
export function visionCandidates(config, log = console) {
  const router = routerFor(config, log);
  const plan = router.plan({ text: ' carefully transcribe and solve complex exam questions with diagrams and equations', needsVision: true, forceTier: 'heavy' });
  const seen = new Set();
  const out = [];
  for (const m of [...plan.candidates, ...router.catalog]) {
    if (!m.vision || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.sort((a, b) => (b.quality ?? 5) - (a.quality ?? 5));
}

/**
 * Ranked list of strongest reasoning brains (including DeepSeek official API if set,
 * plus 120B Groq, Gemini, Gemma-4-31B OpenRouter, heavy local GGUF, Ollama).
 */
export function reasoningCandidates(config, log = console) {
  const router = routerFor(config, log);
  const plan = router.plan({
    text: 'solve multi-step mathematical, scientific, coding, and analytical exam questions with step-by-step proof verification',
    forceTier: 'heavy',
  });
  const extras = [];
  if (config.deepseekApiKey) {
    extras.push({
      id: `deepseek:${config.deepseekModel || 'deepseek-reasoner'}`,
      provider: 'deepseek',
      model: config.deepseekModel || 'deepseek-chat',
      label: `DeepSeek (${config.deepseekModel || 'deepseek-chat'})`,
      local: false,
      vision: false,
      quality: 10,
    });
  }
  const seen = new Set();
  const out = [];
  for (const m of [...extras, ...plan.candidates, ...router.catalog]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out.sort((a, b) => (b.quality ?? 5) - (a.quality ?? 5));
}

/**
 * Direct low-temperature call to a specific model (`temperature`, `maxTokens`, `signal`),
 * used by the multi-stage Question Solver & independent Adversarial Auditor.
 */
export async function callDirectModel(model, config, messages, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Math.trunc(opts.timeoutMs) : Math.max(TIMEOUT_MS, Number(config.aiTimeoutMs) || TIMEOUT_MS);
  const temperature = Number.isFinite(opts.temperature) ? Number(opts.temperature) : 0.1;
  const maxTokens = Number(opts.maxTokens) > 0 ? Math.trunc(opts.maxTokens) : undefined;
  const signal = opts.signal ?? null;

  if (model.provider === 'deepseek') {
    const base = (config.deepseekBaseUrl || 'https://api.deepseek.com').replace(/\/$/, '');
    const url = base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
    const data = await postJson(url, {
      model: model.model,
      messages,
      temperature,
      stream: false,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }, { authorization: `Bearer ${config.deepseekApiKey}` }, timeoutMs, signal);
    const msg = data.choices?.[0]?.message;
    const text = (msg?.content || '').trim();
    if (!text) throw new Error('empty DeepSeek response');
    return { text, reasoning: (msg?.reasoning_content || '').trim(), provider: model.label, model: model.model, id: model.id };
  }
  if (model.provider === 'ollama') {
    const data = await postJson(`${model.baseUrl || config.ollamaUrl}/api/chat`, {
      model: model.model,
      messages,
      stream: false,
      options: { temperature, ...(maxTokens ? { num_predict: maxTokens } : {}) },
    }, {}, timeoutMs, signal);
    const text = data.message?.content?.trim();
    if (!text) throw new Error('empty Ollama response');
    return { text, provider: model.label, model: model.model, id: model.id };
  }
  if (model.provider === 'local') {
    const data = await postJson(`${model.baseUrl}/chat/completions`, {
      model: model.model,
      messages,
      temperature,
      stream: false,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    }, { authorization: `Bearer ${model.apiKey || 'local'}` }, timeoutMs, signal);
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('empty local model response');
    return { text, provider: model.label, model: model.model, id: model.id };
  }
  if (model.provider === 'gemini') {
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const data = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model.model}:generateContent?key=${config.geminiApiKey}`,
      {
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { temperature, ...(maxTokens ? { maxOutputTokens: maxTokens } : {}) },
      },
      {},
      timeoutMs,
      signal,
    );
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('').trim();
    if (!text) throw new Error('empty Gemini response');
    return { text, provider: model.label, model: model.model, id: model.id };
  }
  const endpoint = cloudEndpoint(model, config);
  if (!endpoint?.key) throw new Error(`no credentials for ${model.provider}`);
  const data = await postJson(`${endpoint.url}/chat/completions`, {
    model: model.model,
    messages,
    temperature,
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
  }, { authorization: `Bearer ${endpoint.key}` }, timeoutMs, signal);
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error(`empty ${model.provider} response`);
  return { text, provider: model.label, model: model.model, id: model.id };
}

/**
 * Describe a photo the owner sent. Local vision model first (private), then
 * Gemini, then Groq's qwen3.8-27b, then an OpenRouter vision model — whichever
 * is configured. Returns null when nothing can see images.
 */
export async function describeImage(config, imageBase64, caption = '', log = console) {
  const router = routerFor(config, log);
  const prompt = caption
    ? `The owner sent this photo with the caption "${caption}". Answer about the photo, briefly.`
    : 'Describe this photo briefly: what is in it, and read any visible text.';
  const plan = router.plan({ text: caption || 'describe this photo', needsVision: true, needsTools: false });
  for (const model of plan.candidates.filter((m) => m.vision)) {
    if (router.isCooling(model)) continue;
    const started = Date.now();
    try {
      const text = await visionCall(model, config, prompt, imageBase64);
      if (!text) throw new Error('empty vision response');
      router.record(model.id, { ok: true, ms: Date.now() - started, tier: plan.rank });
      return text;
    } catch (err) {
      router.record(model.id, { ok: false, ms: Date.now() - started, tier: plan.rank, error: err });
      log.warn?.(`[ai] vision ${model.label} failed: ${safeBrainText(err.message, config)}`);
    }
  }
  return null;
}

/**
 * One vision call for computer use ("hands"): screenshot + instructions, any
 * vision-capable brain from the router. Local vision models are preferred by
 * ROUTER_PREFER; set ALLOW_CLOUD_SCREEN=false to keep screenshots on the PC.
 * Returns { text, model, local } or null when nothing can see images.
 */
const SCREEN_PROVIDER_ORDER = { gemini: 0, groq: 1, openrouter: 2, local: 3, ollama: 4 };

export async function screenStep(config, prompt, imageBase64, log = console, { mime = 'image/png', signal = null, maxTokens = null } = {}) {
  const router = routerFor(config, log);
  const allowCloud = config?.allowCloudScreen !== false;
  const forced = String(config?.screenProvider ?? 'auto').toLowerCase();
  // Tier 2 = the fast vision models (Gemini Flash / Groq qwen-vision). A
  // computer-use loop needs many quick looks, not one slow smart one.
  const plan = router.plan({ text: 'look at the screen and control the desktop', needsVision: true, needsTools: false, forceTier: 2 });
  // Screen control rewards latency and grounding over raw size: Gemini Flash
  // first (fast + strong at UI), then Groq's qwen-vision, then OpenRouter,
  // then a local model (private, slower), then Ollama.
  const candidates = plan.candidates
    .filter((m) => m.vision && (allowCloud || m.local))
    .sort((a, b) => {
      if (forced !== 'auto' && forced) {
        const af = a.provider === forced ? 0 : 1;
        const bf = b.provider === forced ? 0 : 1;
        if (af !== bf) return af - bf;
      }
      const ap = SCREEN_PROVIDER_ORDER[a.provider] ?? 9;
      const bp = SCREEN_PROVIDER_ORDER[b.provider] ?? 9;
      if (ap !== bp) return ap - bp;
      return (b.speed ?? 0) - (a.speed ?? 0);
    });
  const tried = [];
  for (const model of candidates) {
    if (router.isCooling(model)) continue;
    const started = Date.now();
    try {
      const text = await visionCall(model, config, prompt, imageBase64, mime, { signal, maxTokens });
      if (!text) throw new Error('empty vision response');
      router.record(model.id, { ok: true, ms: Date.now() - started, tier: plan.rank });
      return { text, model: model.label, local: Boolean(model.local) };
    } catch (err) {
      if (signal?.aborted) throw err; // /stop: do not burn the next provider
      tried.push(model.label);
      router.record(model.id, { ok: false, ms: Date.now() - started, tier: plan.rank, error: err });
      log.warn?.(`[ai] screen ${model.label} failed: ${safeBrainText(err.message, config)}`);
    }
  }
  if (!candidates.length) {
    log.warn?.(allowCloud
      ? '[ai] screen: no vision model configured — set GEMINI_API_KEY / GROQ_API_KEY or OLLAMA_VISION_MODEL'
      : '[ai] screen: ALLOW_CLOUD_SCREEN=false and no local vision model — set OLLAMA_VISION_MODEL');
  }
  return null;
}

/**
 * "Ye error dekh ke batao kya galat hai" — a photo/screenshot the owner sent.
 * Vision first (the same brains as hands), with a strict shape so the answer
 * is useful: what is wrong, and the exact next step. Never invents a fix for
 * an error it cannot read — it says so.
 */
export async function diagnoseImage(config, imageBase64, note = '', log = console, { signal = null } = {}) {
  const question = String(note ?? '').replace(/^\/?(fix|help|error)\s*/i, '').trim();
  const prompt = [
    'The owner sent this screenshot/photo from their PC and wants help.',
    question ? `Their words: "${question}"` : '',
    '',
    'Do this, briefly and in Hinglish (Roman script):',
    '1. Read the error / problem exactly as shown (quote the key line).',
    '2. In one line: what is actually wrong.',
    '3. Give the exact next step(s) — commands or clicks. If a command is needed, put it on its own line.',
    'If the image has no error and is just a normal screen, say what is on it and ask what they want.',
    'Never invent an error that is not visible. Never suggest anything destructive.',
  ].filter(Boolean).join('\n');
  const result = await screenStep(config, prompt, imageBase64, log, { maxTokens: 700, signal });
  if (!result?.text) return null;
  return { text: result.text.trim(), model: result.model, local: result.local };
}

/**
 * Ask a LOCAL vision model where a UI element is in an image.
 * Returns the raw model reply (expected: {"x":0-1000,"y":0-1000} or
 * {"found":false}) or null when no vision model is available. Local-only on
 * purpose: screenshots of the owner's screen never leave the PC for this.
 */
export async function locateInImage(config, imageBase64, description, log = console) {
  const VISIONY_MODEL = /llava|vision|vl\b|[-_]vl|moondream|minicpm-v|gemma3|qwen.*vl|llama3\.2-vision/i;
  const model = config.ollamaVisionModel || (VISIONY_MODEL.test(config.ollamaModel ?? '') ? config.ollamaModel : '');
  if (!model) return null;
  try {
    const data = await postJson(`${config.ollamaUrl}/api/chat`, {
      model,
      stream: false,
      messages: [{
        role: 'user',
        content:
          `This is a screenshot of a computer screen. Find the UI element the user wants to click: "${description}". ` +
          'Reply with ONLY a JSON object {"x": <0-1000>, "y": <0-1000>} giving the CENTER of that element in ' +
          '0-to-1000 relative coordinates (x: 0=left edge, 1000=right edge; y: 0=top, 1000=bottom). ' +
          'If the element is not visible, reply with ONLY {"found": false}. No other text.',
        images: [imageBase64],
      }],
    });
    return data.message?.content?.trim() || null;
  } catch (err) {
    log.warn?.(`[ai] vision locate failed: ${safeBrainText(err.message, config)}`);
    return null;
  }
}

/** For /model: what brains are configured, and whether they are actually up. */
export async function aiStatus(config) {
  const mode = String(config.aiProvider || 'auto');
  const localOnly = mode === 'local' || mode === 'llamacpp';
  const lines = [`Provider mode: *${mode}*${localOnly ? ' — sirf is PC, koi cloud nahi' : ''}`];

  // llama.cpp / LM Studio / vLLM: the fully-local path.
  if (config.localApiUrl) {
    try {
      const res = await fetch(`${config.localApiUrl}/models`, { signal: AbortSignal.timeout(2_500) });
      const data = res.ok ? await res.json() : null;
      const ids = (data?.data ?? []).map((m) => m.id).filter(Boolean);
      lines.push(`🏠 Local server: ✅ ${config.localApiUrl}${ids.length ? ` — ${ids.join(', ')}` : ''}`);
    } catch {
      lines.push(`🏠 Local server: ❌ not reachable at ${config.localApiUrl}`);
      lines.push('   start it: ./scripts/observer.sh models serve <model>   (or: systemctl --user start observer-model)');
    }
    if (config.localModelSmall) lines.push(`   small: ${config.localModelSmall} @ ${config.localApiUrlSmall || '(unset)'}`);
    if (config.localModelHeavy) lines.push(`   heavy: ${config.localModelHeavy} @ ${config.localApiUrlHeavy || '(unset)'}`);
    if (config.localModelVision) lines.push(`👁️ local vision: ${config.localModelVision}`);
  } else if (localOnly) {
    lines.push('🏠 Local server: ❌ LOCAL_API_URL not set');
    lines.push('   ./scripts/observer.sh models recommend   →   ./scripts/observer.sh models setup <model>');
  }

  // Ollama, unless the owner pinned another mode.
  if (!localOnly && mode !== 'groq' && mode !== 'gemini' && mode !== 'openrouter') {
    try {
      const res = await fetch(`${config.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const models = (data.models ?? []).map((m) => m.name);
      lines.push(`✅ Ollama running — models: ${models.join(', ') || '(none pulled yet)'}`);
      if (!models.some((m) => m.startsWith(config.ollamaModel))) {
        lines.push(`⬇️ ${config.ollamaModel} isn't pulled yet: \`ollama pull ${config.ollamaModel}\``);
      }
    } catch {
      lines.push(`— Ollama not reachable at ${config.ollamaUrl} (optional if you use llama.cpp or a cloud key)`);
    }
  }

  if (!localOnly) {
    lines.push(config.groqApiKey
      ? `✅ Groq key set — ${config.groqModel} · small ${config.groqModelSmall}${config.groqVisionModel ? ` · vision ${config.groqVisionModel}` : ''}`
      : '— Groq key not set (optional: fast free tier + free voice transcription)');
    lines.push(config.geminiApiKey ? '✅ Gemini key set' : '— Gemini key not set (optional)');
    lines.push(config.openrouterApiKey
      ? `✅ OpenRouter key set — ${config.openrouterModel}${config.openrouterVisionModel ? ` · vision ${config.openrouterVisionModel}` : ''}`
      : '— OpenRouter key not set (optional: widest free model menu)');
  }
  if (config.ollamaVisionModel && !localOnly) lines.push(`👁️ Ollama vision model: ${config.ollamaVisionModel}`);

  lines.push('', '_/brains shows workload routing + live health. Local guide: LOCAL-MODELS.md_');
  return lines.join('\n');
}

export const NO_BRAIN_HINT =
  '🤖 I\'m online, but no free AI brain is reachable right now, so I can only run built-in tools.\n\n' +
  'For full chat (free, offline): install *Ollama* on this PC → `ollama pull llama3.2` → send me anything.\n' +
  'Meanwhile try: /weather <city>, /remind in 10m <text>, /todo, /wiki <topic>, /calc 45*12 — full list: /help\n' +
  'Status: /brains · diagnose: /doctor';
