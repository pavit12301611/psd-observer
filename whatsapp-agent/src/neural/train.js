// Reproducible CPU training. Validation selects checkpoints/calibration;
// the TEST split is measured only after selection, including int8 weights.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MLP, createRNG } from './nn.js';
import { textFeatures, pairFeatures, normalizeText, DEFAULT_DIM, FEATURE_VERSION } from './text.js';
import { INTENT_LABELS, INTENT_EXAMPLES, MATCH_PARAPHRASES, templateExamples } from './dataset.js';
import { makeMemory, nearestIntent, decideIntent, calibratedScores } from './decision.js';
import { readExamples, trustedExample, dataDirectory, atomicJSON } from './storage.js';

export const INTENT_HIDDEN = 64;
export const MATCH_HIDDEN = 16;
export const leakageKey = (t) => normalizeText(t)
  .replace(/^(?:(?:hey|arre|suno|please)\s+)+/, '')
  .replace(/(?:\s+(?:bhai|yaar|bro|please))+$/, '');

export function augmentExamples(examples, seed = 42) {
  const rng = createRNG(seed);
  const suffixes = ['', ' bhai', ' yaar', ' bro', '?', ' ...', ' please'];
  const prefixes = ['', 'arre ', 'suno ', 'hey '];
  const out = [...examples];
  for (const ex of examples) {
    const n = 2 + Math.floor(rng() * 2);
    for (let k = 0; k < n; k++) {
      const variant = `${prefixes[Math.floor(rng() * prefixes.length)]}${ex.t}${suffixes[Math.floor(rng() * suffixes.length)]}`.trim();
      if (variant !== ex.t) out.push({ t: variant, label: ex.label });
    }
  }
  return out;
}

function shuffled(list, seed) {
  const out = [...list], rng = createRNG(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function intentSplits(examples, seed = 42) {
  const unique = new Map();
  for (const ex of examples) {
    if (typeof ex?.t === 'string' && ex.t.trim() && INTENT_LABELS.includes(ex.label)) unique.set(leakageKey(ex.t), ex);
  }
  const train = [], val = [], test = [];
  for (let i = 0; i < INTENT_LABELS.length; i++) {
    const list = shuffled([...unique.values()].filter((ex) => ex.label === INTENT_LABELS[i]), seed + i);
    const n = list.length >= 3 ? Math.max(1, Math.round(list.length * 0.15)) : 0;
    val.push(...list.slice(0, n)); test.push(...list.slice(n, n * 2)); train.push(...list.slice(n * 2));
  }
  return { train, val, test };
}

function classificationMetrics(list, predict) {
  const perClass = Object.fromEntries(INTENT_LABELS.map((l) => [l, { correct: 0, total: 0, predicted: 0 }]));
  let correct = 0;
  for (const ex of list) {
    const pred = predict(ex.t);
    perClass[ex.label].total++;
    perClass[pred].predicted++;
    if (pred === ex.label) { correct++; perClass[ex.label].correct++; }
  }
  const present = Object.values(perClass).filter((p) => p.total > 0);
  const macroF1 = present.reduce((sum, p) => sum + 2 * p.correct / Math.max(1, p.total + p.predicted), 0) / Math.max(1, present.length);
  return { accuracy: correct / Math.max(1, list.length), macroF1, perClass, n: list.length };
}

function netLabel(net, t) { return INTENT_LABELS[net.predict(textFeatures(t))]; }
function nll(net, list, temperature = 1) {
  return list.reduce((sum, ex) => sum - Math.log(Math.max(1e-12,
    calibratedScores(net.forward(textFeatures(ex.t)), temperature)[INTENT_LABELS.indexOf(ex.label)])), 0) / Math.max(1, list.length);
}

export function trainIntent({ epochs = 90, lr = 0.006, seed = 42, extraExamples = [], includeRuntime = false, dataDir } = {}) {
  const approved = includeRuntime ? readExamples(dataDirectory({ dataDir })).filter(trustedExample) : [];
  const examples = [...INTENT_EXAMPLES, ...extraExamples, ...approved];
  const split = intentSplits(examples, seed);
  const protectedKeys = new Set([...split.val, ...split.test].map((ex) => leakageKey(ex.t)));
  const trainAug = [...augmentExamples(split.train, seed + 5), ...templateExamples()]
    .filter((ex) => !protectedKeys.has(leakageKey(ex.t)));
  const net = new MLP([DEFAULT_DIM, INTENT_HIDDEN, INTENT_LABELS.length], { seed, out: 'softmax' });
  const xs = trainAug.map((ex) => textFeatures(ex.t));
  const ys = trainAug.map((ex) => INTENT_LABELS.indexOf(ex.label));
  let best = { acc: -1, loss: Infinity, json: null, epoch: -1 };
  let trainedEpochs = 0;
  net.fit(xs, ys, {
    epochs, lr, batchSize: 32, seed: seed + 1, weightDecay: 2e-4,
    onEpoch: (ep) => {
      trainedEpochs = ep + 1;
      const acc = classificationMetrics(split.val, (t) => netLabel(net, t)).accuracy;
      const loss = nll(net, split.val);
      if (acc > best.acc || (acc === best.acc && loss < best.loss)) {
        best = { acc, loss, json: net.toJSON({ quantize: false }), epoch: ep };
      }
      return ep - best.epoch < 18; // actual early stopping, never uses test labels
    },
  });
  const restored = MLP.fromJSON(best.json ?? net.toJSON({ quantize: false }));
  // All reported deployment metrics use the actual int8 round-trip, not just float weights.
  const deployed = MLP.fromJSON(restored.toJSON(), { inference: true });
  let temperature = 1, loss = Infinity;
  for (const t of [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]) {
    const value = nll(deployed, split.val, t);
    if (value < loss) { temperature = t; loss = value; }
  }
  const memory = makeMemory(split.train);
  const hybrid = (t) => decideIntent(deployed.forward(textFeatures(t)), nearestIntent(textFeatures(t), memory), { temperature }).label;
  return {
    net: restored, temperature, splits: split,
    metrics: {
      train: classificationMetrics(split.train, (t) => netLabel(deployed, t)),
      val: classificationMetrics(split.val, (t) => netLabel(deployed, t)),
      valHybrid: classificationMetrics(split.val, hybrid),
      test: classificationMetrics(split.test, (t) => netLabel(deployed, t)),
      testHybrid: classificationMetrics(split.test, hybrid),
      examples: [...split.train, ...split.val, ...split.test].length,
      augmentedExamples: trainAug.length, approvedRuntimeExamples: approved.length,
      bestEpoch: best.epoch + 1, trainedEpochs, temperature, validationNll: loss,
      evaluation: 'deduplicated stratified 70/15/15; train-only memory; int8; test not used for selection',
    },
  };
}

export function matchSplits(seed = 42) {
  const groups = shuffled(MATCH_PARAPHRASES, seed + 11);
  const n = Math.max(1, Math.round(groups.length * 0.15));
  return { train: groups.slice(n * 2), val: groups.slice(0, n), test: groups.slice(n, n * 2) };
}

function makePairs(groups, seed) {
  const pairs = [], rng = createRNG(seed);
  for (const group of groups) {
    pairs.push({ q: group.target, cand: group.target, label: 1 });
    for (const q of group.queries) {
      pairs.push({ q, cand: group.target, label: 1 });
      for (const other of group.queries) if (q !== other && rng() < 0.25) pairs.push({ q, cand: other, label: 1 });
      const others = groups.filter((g) => g !== group);
      // A random wrong topic is too easy. Also teach the closest WRONG topic
      // (same word/shape, different entity) rather than relying on length cues.
      const hard = others.map((g) => ({ g, overlap: pairFeatures(q, g.target)[0] })).sort((a, b) => b.overlap - a.overlap)[0]?.g;
      if (hard) pairs.push({ q, cand: hard.target, label: 0 });
      if (others.length) pairs.push({ q, cand: others[Math.floor(rng() * others.length)].target, label: 0 });
    }
  }
  for (const g of groups) for (const other of groups) {
    if (g !== other && pairFeatures(g.target, other.target)[0] > 0) pairs.push({ q: g.target, cand: other.target, label: 0 });
  }
  const casual = INTENT_EXAMPLES.filter((x) => ['greeting', 'gratitude', 'emotional', 'misc_chat', 'creative'].includes(x.label));
  for (let i = 0; i < groups.length * 3; i++) {
    const q = casual[Math.floor(rng() * casual.length)].t;
    const g = groups[Math.floor(rng() * groups.length)];
    pairs.push({ q, cand: g.target, label: 0 });
    pairs.push({ q, cand: g.queries[Math.floor(rng() * g.queries.length)], label: 0 });
  }
  return shuffled([...new Map(pairs.map((p) => [`${p.q}\0${p.cand}`, p])).values()], seed);
}
function matchMetrics(net, list) {
  let correct = 0, tp = 0, fp = 0, fn = 0, loss = 0;
  for (const p of list) {
    const score = net.predict(pairFeatures(p.q, p.cand)), pred = Number(score >= 0.5);
    if (pred === p.label) correct++;
    if (pred === 1 && p.label === 1) tp++;
    if (pred === 1 && p.label === 0) fp++;
    if (pred === 0 && p.label === 1) fn++;
    loss -= p.label ? Math.log(Math.max(1e-12, score)) : Math.log(Math.max(1e-12, 1 - score));
  }
  return { accuracy: correct / Math.max(1, list.length), precision: tp / Math.max(1, tp + fp), recall: tp / Math.max(1, tp + fn), loss: loss / Math.max(1, list.length), n: list.length };
}
export function trainMatch({ epochs = 80, lr = 0.02, seed = 42 } = {}) {
  const groups = matchSplits(seed);
  const train = makePairs(groups.train, seed + 21), val = makePairs(groups.val, seed + 22), test = makePairs(groups.test, seed + 23);
  const net = new MLP([13, MATCH_HIDDEN, 1], { seed, out: 'sigmoid' });
  const xs = train.map((p) => pairFeatures(p.q, p.cand)), ys = train.map((p) => p.label);
  let best = { acc: -1, loss: Infinity, json: null, epoch: -1 };
  net.fit(xs, ys, { epochs, lr, batchSize: 32, seed: seed + 2,
    onEpoch: (ep) => {
      const v = matchMetrics(net, val);
      if (v.accuracy > best.acc || (v.accuracy === best.acc && v.loss < best.loss)) {
        best = { acc: v.accuracy, loss: v.loss, json: net.toJSON({ quantize: false }), epoch: ep };
      }
      return ep - best.epoch < 18;
    },
  });
  const restored = MLP.fromJSON(best.json ?? net.toJSON({ quantize: false }));
  const deployed = MLP.fromJSON(restored.toJSON(), { inference: true });
  return { net: restored, splits: groups, metrics: {
    train: matchMetrics(deployed, train), val: matchMetrics(deployed, val), test: matchMetrics(deployed, test),
    pairs: train.length + val.length + test.length, groups: Object.fromEntries(Object.entries(groups).map(([k, g]) => [k, g.length])),
    bestEpoch: best.epoch + 1, evaluation: 'disjoint paraphrase/target groups; test untouched; int8',
  } };
}

export function trainAll(opts = {}) {
  const intent = trainIntent(opts), match = trainMatch(opts);
  const metrics = { intent: intent.metrics, match: match.metrics };
  return {
    checkpoint: {
      version: 2, featureVersion: FEATURE_VERSION, labels: INTENT_LABELS,
      trainedAt: new Date().toISOString(), seed: opts.seed ?? 42,
      corpusSha256: createHash('sha256').update(JSON.stringify({ INTENT_EXAMPLES, MATCH_PARAPHRASES, templates: templateExamples() })).digest('hex'),
      temperature: intent.temperature, intent: intent.net.toJSON(), match: match.net.toJSON(), meta: metrics,
    },
    metrics, nets: { intent: intent.net, match: match.net },
  };
}

export function saveCheckpoint(checkpoint, filePath) { return atomicJSON(filePath, checkpoint); }
export function loadCheckpoint(filePath) {
  // Maintained for the command-line/checkpoint inspection API.
  try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return null; }
}
