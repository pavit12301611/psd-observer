// wiki.js — Wikipedia-powered grounding & training for the chat brain.
//
// The owner asked: "AI chat ke liye properly trained nahi hai — use train
// karne ke liye Wikipedia use karo". This module is that training loop:
//
//   • wikiSummary()      — fetch any topic's summary from the Wikipedia REST API
//                          (base URL configurable so tests can mock it).
//   • wikiContextFor()   — before the AI answers a factual question, grab a
//                          verified Wikipedia summary and inject it into the
//                          system prompt as [WIKIPEDIA GROUNDING].
//   • trainFromWikipedia() — batch-learn a topic list into the store (and into
//                          data/wiki-knowledge.json via scripts/train-wiki.mjs),
//                          so the agent answers instantly, offline.
//   • wikiCommand()      — the `/wiki <topic>` chat command: built-in knowledge
//                          first, then learned cache, then live fetch (which
//                          also gets learned = training on every lookup).
//
// Everything degrades gracefully: no network → learned/built-in answers still
// work; whole path is timeout-bounded so chat never hangs.

import fs from 'node:fs';
import { throwIfStopped } from './cancel.js';
import { classifyIntent } from './neural/index.js';
import {
  lookupKnowledge,
  lookupLearnedKnowledge,
  ingestWikiEntry,
  formatKnowledgeContext,
  learnedKnowledgeCount,
} from './knowledge.js';

const DEFAULT_BASE = 'https://en.wikipedia.org';

const normalize = (s) => String(s ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** Cheap check: is this a question where facts matter (so grounding helps)? */
export function looksFactualQuery(text) {
  const s = String(text ?? '').trim();
  if (!s || s.length > 400) return false;
  if (s.startsWith('/')) return false;
  const low = s.toLowerCase();
  // code/commands are not knowledge questions
  if (/[{};]|=>|```|\/(?:open|close|run|screenshot)\b/.test(low)) return false;
  // personal/casual chit-chat is not knowledge
  if (/^(?:kya haal|kaise ho|aur batao|good (?:morning|evening|night)|hi|hello|hey|thanks|shukriya)\b/.test(low)) return false;
  return /(?:\?|\b(?:what|who|when|where|which|why|how\s+(?:much|many|far|tall|old|long)|kya|kaun|kab|kahan|kyun|kisne|kitna|kitne|kitni|matlab|meaning|explain|tell\s+me\s+about|ke\s+bare|ke\s+baare|kisne\s+banaya|kab\s+hua)\b)/i.test(low);
}

/** Clean a question down to a search query for Wikipedia. */
export function toWikiQuery(text) {
  return String(text ?? '')
    .replace(/^(?:please|plz|bhai|bro|yaar|hey|suno|arre|batao|bata|tell me about|tell me|explain|what is|what was|who is|who was|who invented|who made|when did|when was|where is|kya hai|kya tha|kaun hai|kaun tha|kab hua|kab tha|kahan hai|kisne banaya|kisne likha|matlab kya hai|meaning of)\s+/i, '')
    .replace(/[?!.।]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

async function fetchJson(url, timeoutMs, signal) {
  throwIfStopped(signal, 'Wiki grounding');
  const controller = new AbortController();
  const stop = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Wikipedia timeout')), Math.max(1000, timeoutMs));
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'observer-whatsapp-agent/3.9 (personal assistant; wiki grounding)', accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`wikipedia ${res.status}`);
    return await res.json();
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

/**
 * Fetch a Wikipedia summary for a query. Uses the search API first (so natural
 * queries work), then the REST summary. Returns { title, extract, url, query }
 * or null. `config.wikiBaseUrl` overrides the host (tests, mirrors).
 */
export async function wikiSummary(query, config = {}, opts = {}) {
  throwIfStopped(opts.signal, 'Wiki grounding');
  const base = String(config.wikiBaseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  const timeoutMs = Number(config.wikiTimeoutMs) > 0 ? Number(config.wikiTimeoutMs) : 3500;
  const q = toWikiQuery(query);
  if (!q) return null;

  let title = q;
  try {
    const search = await fetchJson(
      `${base}/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=1&format=json`,
      timeoutMs, opts.signal,
    );
    const hit = search?.query?.search?.[0]?.title;
    if (hit) title = hit;
  } catch { throwIfStopped(opts.signal, 'Wiki grounding'); /* raw title fallback */ }

  const page = await fetchJson(
    `${base}/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
    timeoutMs, opts.signal,
  );
  const extract = String(page?.extract ?? '').trim();
  if (!extract) return null;
  return {
    query,
    title: String(page.title ?? title),
    extract: extract.slice(0, 1500),
    url: page?.content_urls?.desktop?.page || `${base}/wiki/${encodeURIComponent(title)}`,
  };
}

// ── Training: learn topics from Wikipedia into the store / a JSON file ──────

/**
 * Fetch and remember a list of topics. Returns { learned, failed }.
 * Every success is stored via ingestWikiEntry (store.data.wikiKnowledge).
 */
export async function trainFromWikipedia(topics, config = {}, store = null) {
  const list = Array.isArray(topics) ? topics.filter((t) => String(t ?? '').trim()) : [];
  const out = { learned: 0, failed: [], entries: [] };
  for (const topic of list) {
    try {
      const rec = await wikiSummary(topic, config);
      if (!rec?.extract) throw new Error('empty extract');
      const saved = store ? ingestWikiEntry(store, rec) : rec;
      out.learned += 1;
      out.entries.push(saved ?? rec);
    } catch (err) {
      out.failed.push({ topic, error: String(err?.message || err) });
    }
  }
  return out;
}

/** Load a train-wiki.mjs output file (data/wiki-knowledge.json) into the store. */
export function loadTrainedWikiFile(store, filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : [];
    let n = 0;
    for (const item of items) {
      if (item?.title && item?.extract && ingestWikiEntry(store, item)) n += 1;
    }
    return n;
  } catch {
    return 0;
  }
}

// ── Prompt grounding ────────────────────────────────────────────────────────

/**
 * Build a [WIKIPEDIA GROUNDING] block for the AI system prompt.
 * Order: learned cache (0 ms) → live fetch (timeout-bounded, result is learned).
 * Returns '' when nothing is available or the question is not factual.
 */
export async function wikiContextFor(userText, config = {}, store = null, log = console, opts = {}) {
  throwIfStopped(opts.signal, 'Wiki grounding');
  if (config.wikiGrounding === false) return '';

  // Learned answers first (0 ms, offline) — the match itself is the filter, so
  // bare topics ("photosynthesis") work even without question words.
  const learned = lookupLearnedKnowledge(toWikiQuery(userText), store) || lookupLearnedKnowledge(userText, store);
  if (learned) {
    return [
      '[WIKIPEDIA GROUNDING — previously learned (use these exact facts)]:',
      `• ${learned.title}: ${learned.extract}`,
    ].join('\n');
  }
  // For live fetches the question must look factual (heuristic OR trained
  // IntentNet says factual/comparison/explain OR it hits the curated bank) —
  // casual/emotional/creative chat never triggers a network call.
  let factualIntent = false;
  try {
    const label = classifyIntent(userText, { dataDir: config?.dataDir }).label;
    factualIntent = label === 'factual' || label === 'comparison' || label === 'explain';
  } catch { /* heuristics below still gate */ }
  if (!factualIntent && !looksFactualQuery(userText) && !lookupKnowledge(userText, store, { dataDir: config?.dataDir })) return '';
  if (config.wikiGrounding === 'offline') return '';

  try {
    const rec = await wikiSummary(userText, config, opts);
    throwIfStopped(opts.signal, 'Wiki grounding');
    if (!rec) return '';
    if (store) ingestWikiEntry(store, rec); // the training loop: every fetch is remembered
    return [
      '[WIKIPEDIA GROUNDING — fetched just now (use these exact facts; say if something is time-sensitive)]:',
      `• ${rec.title}: ${rec.extract}`,
    ].join('\n');
  } catch (err) {
    throwIfStopped(opts.signal, 'Wiki grounding');
    log?.info?.(`[wiki] grounding skipped: ${err?.message || err}`);
    return '';
  }
}

/** Prompt block from the curated built-in bank (instant, offline). */
export function knowledgeContextFor(userText, store = null, opts = {}) {
  const hit = lookupKnowledge(userText, store, opts);
  return hit ? formatKnowledgeContext(hit) : '';
}

// ── /wiki command ───────────────────────────────────────────────────────────

/**
 * `/wiki <topic>`: built-in knowledge → learned cache → live fetch (+learn).
 * Every path returns a WhatsApp-friendly reply; never throws.
 */
export async function wikiCommand(query, config = {}, store = null) {
  const q = String(query ?? '').trim();
  if (!q) return '📚 Usage: /wiki <topic>';

  const builtin = lookupKnowledge(q, store, { dataDir: config?.dataDir });
  if (builtin) {
    return `📚 *${q}*\n\n${builtin.reply}\n\n_(instant knowledge — trained from Wikipedia; /wiki ${q} fetch karo live update ke liye)_`;
  }

  const learned = lookupLearnedKnowledge(q, store);
  if (learned) {
    return `📚 *${learned.title}*\n\n${learned.extract}\n\n${learned.url}\n\n_(from my Wikipedia training)_`;
  }

  try {
    const rec = await wikiSummary(q, config);
    if (!rec) return `❌ Wikipedia pe "${q}" nahi mila — thoda aur specific try karo.`;
    if (store) ingestWikiEntry(store, rec);
    return `📚 *${rec.title}*\n\n${rec.extract}\n\n${rec.url}\n\n_(from Wikipedia — ab se yaad bhi rakh liya ✓)_`;
  } catch (err) {
    if (learnedKnowledgeCount(store)) {
      return `⚠️ Wikipedia abhi reachable nahi hai (${String(err?.message || err).slice(0, 60)}) — aur is topic ke liye koi trained answer mere paas nahi hai.`;
    }
    return `⚠️ Wikipedia abhi reachable nahi hai (${String(err?.message || err).slice(0, 60)}) — internet check karke dobara try karo.`;
  }
}

/** No-brain fallback for factual questions (used by commands.js askAI). */
export async function wikiFallback(text, config = {}, store = null, opts = {}) {
  throwIfStopped(opts.signal, 'Wiki fallback');
  const builtin = lookupKnowledge(text, store, { dataDir: config?.dataDir });
  if (builtin) return `${builtin.reply}\n\n_(instant knowledge — trained from Wikipedia)_`;
  if (config.wikiGrounding === false || config.wikiGrounding === 'offline') return null;
  try {
    const rec = await wikiSummary(text, config, opts);
    throwIfStopped(opts.signal, 'Wiki fallback');
    if (!rec) return null;
    if (store) ingestWikiEntry(store, rec);
    return `📚 *${rec.title}*\n\n${rec.extract}\n\n${rec.url}\n\n_(from Wikipedia — local AI is off, see /model)_`;
  } catch {
    throwIfStopped(opts.signal, 'Wiki fallback');
    return null;
  }
}
