// index.js — runtime API of the neural brain.
//
// Two trained nets (src/neural/weights.json, written by `npm run train:neural`):
//
//   classifyIntent(text) — IntentNet [384→32→12 softmax] + k-NN memory blend:
//     the net generalizes to new phrasings; the memory (exact training
//     examples) wins on near-duplicates. This hybrid is how small-data text
//     classification stays accurate in production.
//
//   matchScore(query, target) / rankMatches(query, items, getText)
//     — MatchNet [13→16→1 sigmoid] pairwise scorer for semantic matching
//     (knowledge bank, corpus paraphrases, candidate ranking).
//
//   learnExample(text, label) — the owner's real conversations are logged to
//     data/neural-examples.json; `npm run train:neural` folds them into the
//     weights (the training loop never stops).
//
// Everything degrades gracefully: without a checkpoint the net falls back to
// heuristics, so a fresh clone still works.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MLP } from './nn.js';
import { textFeatures, pairFeatures, pairFeaturesPrepared, preparePairSide, DEFAULT_DIM } from './text.js';
import { INTENT_LABELS, INTENT_EXAMPLES } from './dataset.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let CACHE = null;

function findWeights() {
  const candidates = [
    path.join(ROOT, 'data', 'neural-weights.json'),          // retrained override
    path.join(ROOT, 'src', 'neural', 'weights.json'),        // shipped checkpoint
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* keep looking */ }
  }
  return null;
}

/** Load (once) the trained checkpoint + build the k-NN memory. */
export function loadBrain() {
  if (CACHE) return CACHE;
  const file = findWeights();
  let intent = null;
  let match = null;
  let meta = null;
  if (file) {
    try {
      const ck = JSON.parse(fs.readFileSync(file, 'utf8'));
      intent = MLP.fromJSON(ck.intent);
      match = MLP.fromJSON(ck.match);
      meta = { file, trainedAt: ck.trainedAt, metrics: ck.meta };
    } catch { /* corrupted checkpoint → heuristics */ }
  }
  // k-NN memory over the handwritten + runtime training examples.
  // Float32Array: faster cosine on the hot classify path.
  const toF32 = (arr) => Float32Array.from(arr);
  const memory = INTENT_EXAMPLES.map((ex) => ({
    label: ex.label,
    vec: toF32(textFeatures(ex.t)),
  }));
  try {
    const extra = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'neural-examples.json'), 'utf8'));
    if (Array.isArray(extra)) {
      for (const ex of extra) {
        if (ex?.t && ex?.label && INTENT_LABELS.includes(ex.label)) {
          memory.push({ label: ex.label, vec: toF32(textFeatures(ex.t)) });
        }
      }
    }
  } catch { /* no runtime examples yet */ }

  CACHE = { intent, match, meta, memory };
  return CACHE;
}

const cos = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

/** k-NN over the memory: returns { label, similarity } or null. */
export function knnClassify(text, k = 5) {
  const { memory } = loadBrain();
  const v = textFeatures(text);
  // Partial top-k selection: one pass, no sort (O(n·k) not O(n log n)).
  const top = [];
  for (let i = 0; i < memory.length; i++) {
    const m = memory[i];
    const sim = cos(v, m.vec);
    if (top.length < k || sim > top[top.length - 1].sim) {
      let j = top.length - 1;
      while (j >= 0 && top[j].sim < sim) { top[j + 1] = top[j]; j -= 1; }
      top[j + 1] = { label: m.label, sim };
      if (top.length > k) top.pop();
    }
  }
  if (!top.length || top[0].sim < 0.45) return null;
  const votes = new Map();
  for (const t of top) {
    // similarity-squared weighting: the nearest neighbours dominate
    votes.set(t.label, (votes.get(t.label) ?? 0) + t.sim * t.sim);
  }
  let best = null;
  for (const [label, w] of votes) if (!best || w > best.w) best = { label, w };
  return { label: best.label, similarity: top[0].sim };
}

/**
 * Classify a message's intent. Returns { label, confidence, scores, source }
 * where source is 'neural+knn', 'knn', 'neural' or 'heuristic'.
 */
// Small result cache — WhatsApp double-sends and template questions repeat
// constantly; classification is deterministic so this is always safe.
const CLS_CACHE_CAP = 1500;
const clsCache = new Map();
function cachedClassify(key, fn) {
  if (clsCache.has(key)) {
    const v = clsCache.get(key);
    clsCache.delete(key);
    clsCache.set(key, v);
    return v;
  }
  const v = fn();
  clsCache.set(key, v);
  if (clsCache.size > CLS_CACHE_CAP) clsCache.delete(clsCache.keys().next().value);
  return v;
}

/**
 * Classify a message's intent. Returns { label, confidence, scores, source }
 * where source is 'neural+knn', 'knn', 'neural' or 'heuristic'.
 *
 * Blend rules (measured on the held-out split):
 *   • near-duplicate memory hit (cos ≥ 0.8)  → kNN label (exact memory wins)
 *   • uncertain net (conf < 0.65) + decent memory (sim ≥ 0.55) → kNN label
 *     (short/ambiguous strings like "ok bye" live in memory, not the net)
 *   • otherwise → net argmax
 */
export function classifyIntent(text) {
  return cachedClassify(String(text ?? ''), () => {
    const brain = loadBrain();
    const knn = knnClassify(text);

    if (brain.intent) {
      const out = brain.intent.forward(textFeatures(text));
      let bestIdx = 0;
      for (let i = 1; i < out.length; i++) if (out[i] > out[bestIdx]) bestIdx = i;
      const neural = { label: INTENT_LABELS[bestIdx], confidence: out[bestIdx] };

      if (knn && knn.similarity >= 0.8) {
        return {
          label: knn.label,
          confidence: Math.max(knn.similarity, neural.confidence),
          scores: out,
          source: 'neural+knn',
        };
      }
      if (knn && neural.confidence < 0.65 && knn.similarity >= 0.55) {
        return {
          label: knn.label,
          confidence: Math.max(knn.similarity, neural.confidence),
          scores: out,
          source: 'neural+knn',
        };
      }
      return { label: neural.label, confidence: neural.confidence, scores: out, source: 'neural' };
    }

    if (knn) return { label: knn.label, confidence: knn.similarity, scores: null, source: 'knn' };
    return { label: heuristicIntent(text), confidence: 0.3, scores: null, source: 'heuristic' };
  });
}

/** Last-resort rule guess when neither checkpoint nor memory is available. */
export function heuristicIntent(text) {
  const s = String(text ?? '').toLowerCase();
  if (/^(?:hi|hello|hey|yo|good (?:morning|evening|afternoon|night))\b/.test(s)) return 'greeting';
  if (/\b(thanks|thank you|shukriya|dhanyavaad)\b/.test(s)) return 'gratitude';
  if (/\b(vs\.?|versus|difference between|compare|farak|better hai)\b/.test(s)) return 'comparison';
  if (/\b(solve|calculate|kitna hota|percent|integral|equation|gcd|factorial)\b/.test(s)) return 'math';
  if (/\b(code|script|function|debug|regex|query likho)\b/.test(s)) return 'code';
  if (/\b(how to|kaise (?:kar|install|ban)|tarika)\b/.test(s)) return 'howto';
  if (/\b(mood|feeling|sad|stress|lonely|tension|dar lag)\b/.test(s)) return 'emotional';
  if (/\b(poem|story|caption|shayari|quote|naam suggest)\b/.test(s)) return 'creative';
  if (/\b(mera naam|yaad rakh|remember my|my favourite|what is my name|who am i)\b/.test(s)) return 'personal';
  if (/\b(explain|samjhao|kaise kaam|why does|how does)\b/.test(s)) return 'explain';
  if (/\b(what|who|when|where|kya|kaun|kab|kahan|kisne)\b/.test(s)) return 'factual';
  return 'misc_chat';
}

/** MatchNet pairwise score in [0, 1] from prepared sides (hot path). */
export function matchScorePrepared(qSide, cSide) {
  const brain = loadBrain();
  const feats = pairFeaturesPrepared(qSide, cSide);
  if (brain.match) return brain.match.predict(feats);
  // heuristic blend when untrained
  return Math.min(1, Math.max(0, feats[0] * 0.5 + feats[1] * 0.5 + (feats[3] || feats[4] ? 0.25 : 0)));
}

/** MatchNet pairwise score in [0, 1]. */
export function matchScore(query, target) {
  return matchScorePrepared(preparePairSide(query), preparePairSide(target));
}

/** Rank candidate items against a query. Returns [{item, score}, …] sorted. */
export function rankMatches(query, items, getText = (x) => String(x)) {
  return items
    .map((item) => ({ item, score: matchScore(query, getText(item)) }))
    .sort((a, b) => b.score - a.score);
}

/** Log a real training example (owner correction or auto-labeled turn). */
export function learnExample(text, label) {
  if (!INTENT_LABELS.includes(label)) return false;
  const t = String(text ?? '').trim();
  if (!t || t.length > 300) return false;
  const file = path.join(ROOT, 'data', 'neural-examples.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let list = [];
    try { list = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* fresh */ }
    if (!Array.isArray(list)) list = [];
    if (list.some((x) => x.t === t && x.label === label)) return true;
    list.push({ t, label, ts: Date.now() });
    while (list.length > 2000) list.shift();
    fs.writeFileSync(file, JSON.stringify(list));
    CACHE = null; // rebuild memory next call
    return true;
  } catch {
    return false;
  }
}

export function brainInfo() {
  const brain = loadBrain();
  return {
    trained: Boolean(brain.intent),
    trainedAt: brain.meta?.trainedAt ?? null,
    checkpoint: brain.meta?.file ?? null,
    metrics: brain.meta?.metrics ?? null,
    memorySize: brain.memory.length,
  };
}

export { INTENT_LABELS };
