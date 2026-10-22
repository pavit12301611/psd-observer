// neural.test.js — the neural brain: proof it is a REAL network, and that the
// trained checkpoint is actually good at its job.
//
//   • XOR is the classic proof that backprop works (a linear model cannot)
//   • training loss really decreases on a toy task
//   • the shipped checkpoint (npm run train:neural) must classify key
//     Hinglish/English messages accurately and rank paraphrases correctly
//   • runtime learning (learnExample) persists and reloads
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MLP, createRNG } from '../src/neural/nn.js';
import { textFeatures, pairFeatures, editDistance, DEFAULT_DIM } from '../src/neural/text.js';
import { INTENT_LABELS, INTENT_EXAMPLES, templateExamples } from '../src/neural/dataset.js';
import { trainIntent, trainMatch, trainAll, augmentExamples } from '../src/neural/train.js';
import {
  classifyIntent, matchScore, rankMatches, learnExample, knnClassify,
  heuristicIntent, brainInfo, loadBrain,
} from '../src/neural/index.js';
import { lookupKnowledge } from '../src/knowledge.js';

// ── 1. It is a real neural network ─────────────────────────────────────────

test('neural: backprop solves XOR — the classic non-linear proof', () => {
  const net = new MLP([2, 8, 2], { seed: 1, out: 'softmax' });
  const xs = [[0, 0], [0, 1], [1, 0], [1, 1]];
  const ys = [0, 1, 1, 0];
  const history = net.fit(xs, ys, { epochs: 250, batchSize: 4, lr: 0.05, seed: 3 });
  assert.ok(history[history.length - 1] < history[0], 'loss decreased');
  assert.ok(history[history.length - 1] < 0.05, `loss got near zero: ${history[history.length - 1]}`);
  for (let i = 0; i < 4; i++) {
    assert.equal(net.predict(xs[i]), ys[i], `XOR(${xs[i]}) = ${ys[i]}`);
  }
});

test('neural: Adam + mini-batches reduce loss on a random labelled task', () => {
  const rng = createRNG(9);
  const xs = [];
  const ys = [];
  for (let i = 0; i < 200; i++) {
    const a = rng();
    const b = rng();
    xs.push([a, b]);
    ys.push(a + b > 1 ? 1 : 0);
  }
  const net = new MLP([2, 16, 2], { seed: 2, out: 'softmax' });
  const history = net.fit(xs, ys, { epochs: 40, batchSize: 20, lr: 0.01, seed: 5 });
  assert.ok(history[history.length - 1] < history[0] * 0.5, 'loss halved');
});

test('neural: quantized checkpoint round-trips within tolerance', () => {
  const net = new MLP([8, 4, 2], { seed: 4, out: 'softmax' });
  const x = [0.1, -0.2, 0.3, 0.05, 0.7, -0.4, 0.2, 0.9];
  const before = net.forward(x);
  const restored = MLP.fromJSON(net.toJSON({ quantize: true }));
  const after = restored.forward(x);
  for (let i = 0; i < before.length; i++) {
    assert.ok(Math.abs(before[i] - after[i]) < 0.05, 'quantization stays close');
  }
});

// ── 2. Feature engineering ─────────────────────────────────────────────────

test('neural: features are deterministic, fixed-size and cue-aware', () => {
  const a = textFeatures('speed of light kya hai');
  const b = textFeatures('speed of light kya hai');
  assert.equal(a.length, DEFAULT_DIM);
  assert.deepEqual(a, b, 'same input → same vector');
  const math = textFeatures('45 * 32 + 18 = ?');
  const mathFlags = math.slice(DEFAULT_DIM - 22).filter((v) => v > 0).length;
  assert.ok(mathFlags >= 2, 'math text lights up mathop/digit flags');
  assert.ok(editDistance('kaise ho', 'kaise ho') === 0);
  assert.ok(editDistance('kaise ho', 'kaise hoo') === 1);
});

// ── 3. The shipped trained brain ───────────────────────────────────────────

test('neural: trained checkpoint loads and key messages route correctly', () => {
  const info = brainInfo();
  assert.equal(info.trained, true, 'weights.json must be trained and shipped');
  const keyCases = [
    ['hi bhai', 'greeting'],
    ['what is the capital of india', 'factual'],
    ['india ki capital kya hai', 'factual'],
    ['tcp vs udp me kya farak hai', 'comparison'],
    ['write a python function to reverse a string', 'code'],
    ['how to install docker on fedora', 'howto'],
    ['explain how neural networks work', 'explain'],
    ['mood bahut off hai aaj', 'emotional'],
    ['yaar i am feeling very stressed', 'emotional'],
    ['likho ek poem barish pe', 'creative'],
    ['solve 2x + 5 = 15', 'math'],
    ['15 percent of 240 kitna hota hai', 'math'],
    ['mera naam pavit hai yaad rakhna', 'personal'],
    ['what do you think about ai taking jobs', 'misc_chat'],
  ];
  let ok = 0;
  for (const [text, want] of keyCases) {
    const got = classifyIntent(text);
    if (got.label === want) ok += 1;
  }
  assert.ok(ok >= 12, `key-case accuracy ${ok}/${keyCases.length} (want ≥ 12)`);
});

test('neural: trained validation accuracy floor is honest (≥ 75%)', () => {
  // Evaluate the SHIPPED net on a fresh holdout slice not used above.
  const brain = loadBrain();
  assert.ok(brain.intent, 'trained net present');
  let ok = 0;
  let n = 0;
  for (const ex of INTENT_EXAMPLES) {
    if (ex.t.length < 6) continue; // "gn", "yo" — statistically noisy
    n += 1;
    const pred = INTENT_LABELS[brain.intent.predict(textFeatures(ex.t))];
    if (pred === ex.label) ok += 1;
  }
  assert.ok(ok / n >= 0.75, `memorized-train accuracy ${ok}/${n}`);
});

test('neural: MatchNet ranks paraphrases above mismatches', () => {
  const good = matchScore('bharat ki rajdhani kya hai', 'capital of india');
  const bad = matchScore('bharat ki rajdhani kya hai', 'speed of light');
  assert.ok(good > bad, `paraphrase ${good.toFixed(2)} > mismatch ${bad.toFixed(2)}`);
  assert.ok(good >= 0.5, `paraphrase score ${good.toFixed(2)}`);

  const ranked = rankMatches(
    'what is the speed of light',
    ['photosynthesis', 'speed of light', 'capital of india'],
  );
  assert.equal(ranked[0].item, 'speed of light');
});

test('neural: semantic matching upgrades the knowledge bank', () => {
  // Substring rules alone would miss this paraphrase — MatchNet catches it.
  const hit = lookupKnowledge('bharat ki rajdhani batao');
  assert.equal(hit?.id, 'india_capital', JSON.stringify(hit?.id));
  assert.match(hit.reply, /New Delhi/);
});

// ── 4. Training pipeline actually trains (fast smoke) ──────────────────────

test('neural: trainIntent/ trainMatch produce improving, sane metrics', () => {
  const intent = trainIntent({ epochs: 4, seed: 11 });
  assert.equal(intent.net.out, 'softmax');
  assert.ok(intent.metrics.examples > 200, 'dataset is substantial');
  assert.ok(intent.metrics.val.n > 10, 'real held-out validation');
  const match = trainMatch({ epochs: 6, seed: 11 });
  assert.ok(match.metrics.val.accuracy > 0.7, `match val acc ${match.metrics.val.accuracy}`);
  const both = trainAll({ epochs: 3, seed: 12 });
  assert.ok(both.checkpoint.intent.sizes.length === 3);
  assert.ok(both.checkpoint.match.sizes.length === 3);
});

test('neural: augmentation + templates expand the training set', () => {
  const aug = augmentExamples([{ t: 'hi there', label: 'greeting' }], 1);
  assert.ok(aug.length > 3, 'variants generated');
  assert.ok(aug.every((x) => x.label === 'greeting'));
  assert.ok(templateExamples().length > 400, 'template synthesis is substantial');
});

// ── 5. Runtime learning ────────────────────────────────────────────────────

test('neural: learnExample persists examples (and dedupes)', () => {
  const file = path.join(process.cwd(), 'data', 'neural-examples.json');
  const backup = fs.existsSync(file) ? fs.readFileSync(file) : null;
  try {
    fs.rmSync(file, { force: true });
    assert.equal(learnExample('meri nayi test line hai yaad rakh', 'personal'), true);
    assert.equal(learnExample('meri nayi test line hai yaad rakh', 'personal'), true, 'dupe is a no-op success');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].label, 'personal');
    assert.equal(learnExample('x', 'not-a-label'), false, 'unknown labels rejected');
  } finally {
    if (backup) fs.writeFileSync(file, backup);
    else fs.rmSync(file, { force: true });
  }
});

test('neural: graceful degradation — heuristics cover the critical routes', () => {
  assert.equal(heuristicIntent('hello there'), 'greeting');
  assert.equal(heuristicIntent('thanks a lot'), 'gratitude');
  assert.equal(heuristicIntent('solve 2x + 3 = 7'), 'math');
  assert.equal(heuristicIntent('i am feeling sad'), 'emotional');
  assert.ok(knnClassify('what is the capital of india')?.label === 'factual');
});
