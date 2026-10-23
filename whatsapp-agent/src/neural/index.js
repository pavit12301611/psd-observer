// Small local routing/matching networks, NOT a generative language model.
// Checkpoints and approved examples are scoped to the configured data directory.
import fs from 'node:fs';
import path from 'node:path';
import { MLP } from './nn.js';
import { textFeatures, pairFeaturesPrepared, preparePairSide, DEFAULT_DIM, FEATURE_VERSION } from './text.js';
import { INTENT_LABELS, INTENT_EXAMPLES } from './dataset.js';
import { makeMemory, nearestIntent, sparseIndices, decideIntent, exampleKey } from './decision.js';
import { ROOT, dataDirectory, readExamples, trustedExample, atomicJSON } from './storage.js';

const brains = new Map();
const CLS_CACHE_CAP = 1500;

export function validateCheckpoint(ck) {
  if (ck?.version !== 2 || ck.featureVersion !== FEATURE_VERSION
    || JSON.stringify(ck.labels) !== JSON.stringify(INTENT_LABELS)
    || !Array.isArray(ck.intent?.sizes) || !Array.isArray(ck.match?.sizes)
    || ck.intent.sizes[0] !== DEFAULT_DIM || ck.intent.sizes.at(-1) !== INTENT_LABELS.length
    || ck.intent.out !== 'softmax' || ck.match?.sizes?.[0] !== 13
    || ck.match.sizes.at(-1) !== 1 || ck.match.out !== 'sigmoid'
    || (ck.temperature != null && (!Number.isFinite(ck.temperature) || ck.temperature < 0.25 || ck.temperature > 5))) {
    throw new Error('Incompatible neural checkpoint (features/labels/architecture)');
  }
  return {
    intent: MLP.fromJSON(ck.intent, { inference: true }),
    match: MLP.fromJSON(ck.match, { inference: true }),
  };
}

export function reloadBrain(opts = {}) {
  brains.delete(dataDirectory(opts));
  return loadBrain(opts);
}

/** A bad personal override must not shadow a healthy shipped checkpoint. */
export function loadBrain(opts = {}) {
  const dir = dataDirectory(opts);
  if (brains.has(dir)) return brains.get(dir);
  let intent = null, match = null, meta = null;
  const loadIssues = [];
  for (const file of [path.join(dir, 'neural-weights.json'), path.join(ROOT, 'src/neural/weights.json')]) {
    if (!fs.existsSync(file)) continue;
    try {
      const ck = JSON.parse(fs.readFileSync(file, 'utf8'));
      ({ intent, match } = validateCheckpoint(ck));
      meta = { file, trainedAt: ck.trainedAt, metrics: ck.meta, temperature: ck.temperature ?? 1 };
      break;
    } catch { loadIssues.push({ file: path.basename(file), reason: 'corrupt or incompatible; skipped' }); }
  }
  const all = readExamples(dir);
  const approved = all.filter(trustedExample);
  const exact = new Map(approved.map((ex) => [exampleKey(ex.t), ex.label]));
  const brain = {
    intent, match, meta, loadIssues, exact,
    memory: makeMemory([...INTENT_EXAMPLES, ...approved]),
    approvedCount: approved.length, untrustedCount: all.length - approved.length,
    classifications: new Map(),
  };
  brains.set(dir, brain);
  // In normal use there is one data directory; keep test/multi-profile usage bounded too.
  if (brains.size > 8) brains.delete(brains.keys().next().value);
  return brain;
}

export function knnClassify(text, k = 5, opts = {}) {
  const brain = loadBrain(opts), vec = textFeatures(text);
  return nearestIntent(vec, brain.memory, k, sparseIndices(vec));
}

export function classifyIntent(text, opts = {}) {
  const brain = loadBrain(opts);
  const key = exampleKey(text);
  const cache = brain.classifications;
  if (cache.has(key)) {
    const hit = cache.get(key); cache.delete(key); cache.set(key, hit); return hit;
  }
  let result;
  if (brain.exact.has(key)) {
    const label = brain.exact.get(key);
    result = { label, confidence: 1, margin: 1, uncertain: false, source: 'owner',
      scores: Object.freeze(Object.fromEntries(INTENT_LABELS.map((l) => [l, l === label ? 1 : 0]))) };
  } else {
    const vec = textFeatures(text);
    const sparse = sparseIndices(vec);
    const near = nearestIntent(vec, brain.memory, 5, sparse);
    if (brain.intent) {
      result = decideIntent(brain.intent.forward(vec, sparse), near, { temperature: brain.meta.temperature });
    } else {
      const label = near?.label ?? heuristicIntent(text);
      const confidence = near?.similarity ?? 0.3;
      result = { label, confidence, scores: null, source: near ? 'knn' : 'heuristic', margin: 0, uncertain: confidence < 0.8 };
    }
  }
  Object.freeze(result);
  cache.set(key, result);
  if (cache.size > CLS_CACHE_CAP) cache.delete(cache.keys().next().value);
  return result;
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
export function matchScorePrepared(qSide, cSide, opts = {}) {
  const brain = loadBrain(opts);
  const feats = pairFeaturesPrepared(qSide, cSide);
  if (brain.match) return brain.match.predict(feats);
  // heuristic blend when untrained
  return Math.min(1, Math.max(0, feats[0] * 0.5 + feats[1] * 0.5 + (feats[3] || feats[4] ? 0.25 : 0)));
}

/** MatchNet pairwise score in [0, 1]. */
export function matchScore(query, target, opts = {}) {
  return matchScorePrepared(preparePairSide(query), preparePairSide(target), opts);
}

/** Rank candidate items against a query. Returns [{item, score}, …] sorted. */
export function rankMatches(query, items, getText = (x) => String(x), opts = {}) {
  return items
    .map((item) => ({ item, score: matchScore(query, getText(item), opts) }))
    .sort((a, b) => b.score - a.score);
}

/** Explicit owner-approved labels ONLY; predictions are never ground truth. */
export function learnExample(text, label, opts = {}) {
  if (!INTENT_LABELS.includes(label)) return false;
  const t = String(text ?? '').trim();
  if (!t || t.length > 300) return false;
  const dir = dataDirectory(opts);
  const file = path.join(dir, 'neural-examples.json');
  try {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!Array.isArray(list)) return false;
    } catch (err) { if (err.code !== 'ENOENT') return false; }
    const key = exampleKey(t);
    list = list.filter((ex) => exampleKey(ex?.t) !== key);
    list.push({ t, label, source: 'owner', verified: true, ts: Date.now() });
    atomicJSON(file, list.slice(-2000));
    brains.delete(dir); // invalidates BOTH memory and classification cache
    return true;
  } catch { return false; }
}

export function brainInfo(opts = {}) {
  const b = loadBrain(opts);
  return {
    trained: Boolean(b.intent), trainedAt: b.meta?.trainedAt ?? null,
    checkpoint: b.meta?.file ?? null, metrics: b.meta?.metrics ?? null,
    memorySize: b.memory.length, approvedExamples: b.approvedCount, ignoredUntrusted: b.untrustedCount,
    architecture: b.intent?.sizes ?? null, featureVersion: FEATURE_VERSION,
    temperature: b.meta?.temperature ?? null, loadIssues: b.loadIssues,
  };
}

export { INTENT_LABELS };
