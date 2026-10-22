// train.js — training pipeline for the neural brain (IntentNet + MatchNet).
//
// Deterministic: seeded splits + seeded shuffles → same data, same weights,
// every run. Exports trainAll() (used by scripts/train-neural.mjs and tests).
//
//   IntentNet  [384 → 64 → 12 softmax]  cross-entropy  — what kind of message is this
//   MatchNet   [13 → 16 → 1 sigmoid]    binary CE      — does this query match that target
//
// Runtime-learned examples (data/neural-examples.json, from `learnExample`)
// are folded in automatically so real conversations make the nets better.

import fs from 'node:fs';
import { MLP, createRNG } from './nn.js';
import { textFeatures, pairFeatures, DEFAULT_DIM } from './text.js';
import { INTENT_LABELS, INTENT_EXAMPLES, MATCH_PARAPHRASES, templateExamples } from './dataset.js';

export const INTENT_HIDDEN = 32;

/**
 * Deterministic augmentation — real WhatsApp messages carry noise ("bhai",
 * "yaar", "please", punctuation, casing). Each example spawns variants so the
 * net learns the invariances instead of memorising exact strings.
 */
export function augmentExamples(examples, seed = 42) {
  const rng = createRNG(seed);
  const suffixes = ['', ' bhai', ' yaar', ' bro', '?', ' ...', ' please'];
  const prefixes = ['', 'arre ', 'suno ', 'hey '];
  const out = [...examples];
  for (const ex of examples) {
    const n = 2 + Math.floor(rng() * 2); // 2–3 variants
    for (let k = 0; k < n; k++) {
      const pre = prefixes[Math.floor(rng() * prefixes.length)];
      const suf = suffixes[Math.floor(rng() * suffixes.length)];
      const variant = `${pre}${ex.t}${suf}`.trim();
      if (variant !== ex.t) out.push({ t: variant, label: ex.label });
    }
  }
  return out;
}
export const MATCH_HIDDEN = 16;

function loadRuntimeExamples() {
  try {
    const raw = JSON.parse(fs.readFileSync('data/neural-examples.json', 'utf8'));
    return Array.isArray(raw) ? raw.filter((x) => x?.t && x?.label) : [];
  } catch {
    return [];
  }
}

function stratifiedSplit(examples, valFrac = 0.15, seed = 42) {
  const rng = createRNG(seed);
  const byLabel = new Map();
  for (const ex of examples) {
    if (!byLabel.has(ex.label)) byLabel.set(ex.label, []);
    byLabel.get(ex.label).push(ex);
  }
  const train = [];
  const val = [];
  for (const [, list] of byLabel) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    const nVal = Math.max(1, Math.round(list.length * valFrac));
    val.push(...list.slice(0, nVal));
    train.push(...list.slice(nVal));
  }
  return { train, val };
}

/** Train the intent classifier. Returns { net, metrics }. */
export function trainIntent({ epochs = 90, lr = 0.008, seed = 42, extraExamples = [] } = {}) {
  const examples = [...INTENT_EXAMPLES, ...extraExamples, ...loadRuntimeExamples()];
  const { train, val } = stratifiedSplit(examples, 0.15, seed);
  // Train set = handwritten train fold + synthetic templates + noise variants.
  // Validation stays 100% handwritten held-out — honest generalization numbers.
  const trainAug = [
    ...augmentExamples(train, seed + 5),
    ...templateExamples(),
  ];
  const net = new MLP([DEFAULT_DIM, INTENT_HIDDEN, INTENT_LABELS.length], { seed, out: 'softmax' });

  const xs = trainAug.map((ex) => textFeatures(ex.t));
  const ys = trainAug.map((ex) => INTENT_LABELS.indexOf(ex.label));

  // Train with L2 weight decay + early stopping on the validation fold:
  // snapshot the best weights so extra epochs can never hurt.
  const valXs = val.map((ex) => textFeatures(ex.t));
  const valYs = val.map((ex) => INTENT_LABELS.indexOf(ex.label));
  let best = { acc: -1, json: null, epoch: -1 };
  net.fit(xs, ys, {
    epochs, lr, batchSize: 16, seed: seed + 1, weightDecay: 2e-4,
    onEpoch: (ep) => {
      let correct = 0;
      for (let i = 0; i < valXs.length; i++) {
        if (net.predict(valXs[i]) === valYs[i]) correct += 1;
      }
      const acc = correct / Math.max(1, valXs.length);
      if (acc > best.acc) best = { acc, json: net.toJSON({ quantize: false }), epoch: ep };
    },
  });
  if (best.json) {
    const restored = MLP.fromJSON(best.json);
    net.W = restored.W;
    net.b = restored.b;
  }

  // k-NN memory over the TRAIN fold only — evaluation must not leak val.
  const memory = train.map((ex) => ({ label: ex.label, vec: textFeatures(ex.t) }));
  const knn = (t) => {
    const v = textFeatures(t);
    let best = null;
    for (const m of memory) {
      let s = 0;
      for (let i = 0; i < v.length; i++) s += v[i] * m.vec[i];
      if (!best || s > best.sim) best = { label: m.label, sim: s };
    }
    return best;
  };

  const evaluate = (list, hybrid = false) => {
    let correct = 0;
    const perClass = {};
    for (const ex of list) {
      let pred = INTENT_LABELS[net.predict(textFeatures(ex.t))];
      if (hybrid) {
        const near = knn(ex.t);
        if (near && near.sim >= 0.8) pred = near.label;
      }
      const ok = pred === ex.label;
      if (ok) correct += 1;
      perClass[ex.label] = perClass[ex.label] || { correct: 0, total: 0 };
      perClass[ex.label].total += 1;
      if (ok) perClass[ex.label].correct += 1;
    }
    return { accuracy: correct / Math.max(1, list.length), perClass, n: list.length };
  };

  return {
    net,
    metrics: {
      train: evaluate(train),
      val: evaluate(val),
      valHybrid: evaluate(val, true),
      examples: examples.length,
    },
  };
}

/** Train the pairwise matcher. Returns { net, metrics }. */
export function trainMatch({ epochs = 80, lr = 0.02, seed = 42 } = {}) {
  const rng = createRNG(seed + 11);
  const pairs = [];
  for (const group of MATCH_PARAPHRASES) {
    for (const q of group.queries) {
      pairs.push({ q, cand: group.target, label: 1 });
      // paraphrase-to-paraphrase positives within the group
      for (const other of group.queries) {
        if (other !== q && rng() < 0.25) pairs.push({ q, cand: other, label: 1 });
      }
      // hard negatives: other groups' targets (same-shape, wrong answer)
      for (let k = 0; k < 2; k++) {
        const otherGroup = MATCH_PARAPHRASES[Math.floor(rng() * MATCH_PARAPHRASES.length)];
        if (otherGroup.target !== group.target) {
          pairs.push({ q, cand: otherGroup.target, label: 0 });
        }
      }
    }
  }
  // OOD negatives: casual/emotional short talk paired with knowledge targets —
  // without these the sigmoid net gets confidently wrong on greetings
  // ("hello how are you" vs "b r ambedkar" scored 0.98 before this fix).
  const casual = INTENT_EXAMPLES.filter((x) => ['greeting', 'gratitude', 'emotional', 'misc_chat', 'creative'].includes(x.label));
  for (let i = 0; i < 90; i++) {
    const c = casual[Math.floor(rng() * casual.length)];
    const g = MATCH_PARAPHRASES[Math.floor(rng() * MATCH_PARAPHRASES.length)];
    pairs.push({ q: c.t, cand: g.target, label: 0 });
    pairs.push({ q: c.t, cand: g.queries[Math.floor(rng() * g.queries.length)], label: 0 });
  }

  // deterministic shuffle + split
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  const nVal = Math.max(8, Math.round(pairs.length * 0.15));
  const val = pairs.slice(0, nVal);
  const train = pairs.slice(nVal);

  const net = new MLP([13, MATCH_HIDDEN, 1], { seed, out: 'sigmoid' });
  net.fit(train.map((p) => pairFeatures(p.q, p.cand)), train.map((p) => p.label), {
    epochs, lr, batchSize: 32, seed: seed + 2,
  });

  const evaluate = (list) => {
    let correct = 0;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const p of list) {
      const score = net.predict(pairFeatures(p.q, p.cand));
      const pred = score >= 0.5 ? 1 : 0;
      if (pred === p.label) correct += 1;
      if (pred === 1 && p.label === 1) tp += 1;
      if (pred === 1 && p.label === 0) fp += 1;
      if (pred === 0 && p.label === 1) fn += 1;
    }
    return {
      accuracy: correct / Math.max(1, list.length),
      precision: tp / Math.max(1, tp + fp),
      recall: tp / Math.max(1, tp + fn),
      n: list.length,
    };
  };

  return {
    net,
    metrics: { train: evaluate(train), val: evaluate(val), pairs: pairs.length },
  };
}

/** Train everything and return the checkpoint object (not yet written). */
export function trainAll(opts = {}) {
  const intent = trainIntent(opts);
  const match = trainMatch(opts);
  return {
    checkpoint: {
      version: 1,
      trainedAt: new Date().toISOString(),
      intent: intent.net.toJSON(),
      match: match.net.toJSON(),
      meta: {
        intent: intent.metrics,
        match: match.metrics,
      },
    },
    metrics: { intent: intent.metrics, match: match.metrics },
    nets: { intent: intent.net, match: match.net },
  };
}

export function saveCheckpoint(checkpoint, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(checkpoint));
  return filePath;
}

export function loadCheckpoint(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}
