import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { MLP } from '../src/neural/nn.js';
import { INTENT_EXAMPLES, INTENT_LABELS, templateExamples } from '../src/neural/dataset.js';
import { FEATURE_VERSION, textFeatures, normalizeText } from '../src/neural/text.js';
import { decideIntent, nearestIntent, exampleKey } from '../src/neural/decision.js';
import { brainInfo, classifyIntent, learnExample, loadBrain, reloadBrain, validateCheckpoint, matchScore } from '../src/neural/index.js';
import { intentSplits, matchSplits, leakageKey, trainAll } from '../src/neural/train.js';
import { trainPersonalBrain } from '../src/neural/training.js';
import { lookupKnowledge } from '../src/knowledge.js';

const shipped = () => JSON.parse(fs.readFileSync(new URL('../src/neural/weights.json', import.meta.url), 'utf8'));
const temporary = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-neural-v2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

test('neural v2: non-quantized snapshots own every weight, bias and shape', () => {
  const net = new MLP([2, 5, 2], { seed: 10 });
  const json = net.toJSON({ quantize: false });
  const frozen = JSON.stringify(json);
  net.trainBatch([[0, 1]], [1], { lr: 0.1 });
  assert.equal(JSON.stringify(json), frozen, 'best-epoch snapshots cannot follow subsequent training');
  json.layers[0].W[0][0] = 100;
  json.layers[0].b[0] = 100;
  json.sizes[0] = 100;
  assert.notEqual(net.W[0][0][0], 100);
  assert.notEqual(net.b[0][0], 100);
  assert.equal(net.sizes[0], 2);
});

test('neural v2: inference-only load skips optimizer/random initialization and matches sparse/dense math', () => {
  const source = new MLP([406, 8, 3], { seed: 6 });
  const net = MLP.fromJSON(source.toJSON(), { inference: true });
  assert.equal(net.mW, undefined);
  assert.equal(net.vW, undefined);
  assert.ok(net.W[0][0] instanceof Float32Array);
  const x = textFeatures('calculate 45 times 31');
  const sparse = x.flatMap((v, i) => v ? [i] : []);
  const dense = net.forward(x, Array.from({ length: x.length }, (_, i) => i));
  assert.deepEqual(net.forward(x, sparse), dense);
  assert.throws(() => net.trainBatch([x], [1]), /Inference-only/);
  assert.deepEqual(MLP.fromJSON(net.toJSON()).sizes, source.sizes);
});

test('neural v2: corrupt dimensions, non-finite values and quantization are rejected', () => {
  for (const corrupt of [
    (j) => { j.sizes[0] = 10000000; },
    (j) => { j.layers[0].W[0].pop(); },
    (j) => { j.layers[0].b[0] = NaN; },
    (j) => { j.layers[0].scale = 0; },
    (j) => { j.layers[0].W[0][0] = 128; },
  ]) {
    const json = new MLP([2, 3, 2]).toJSON(); corrupt(json);
    assert.throws(() => MLP.fromJSON(json), /Invalid neural/);
  }
});

test('neural v2: incompatible checkpoint falls through to the healthy shipped file', (t) => {
  const dataDir = temporary(t);
  const file = path.join(dataDir, 'neural-weights.json');
  for (const value of ['{bad json', JSON.stringify({ ...shipped(), featureVersion: -1 }), JSON.stringify({ ...shipped(), labels: [...INTENT_LABELS].reverse() })]) {
    fs.writeFileSync(file, value);
    const b = reloadBrain({ dataDir });
    assert.ok(b.intent);
    assert.match(b.meta.file, /src[/\\]neural[/\\]weights\.json$/);
    assert.equal(b.loadIssues.length, 1);
  }
  assert.throws(() => validateCheckpoint({ ...shipped(), temperature: NaN }), /Incompatible/);
});

test('neural v2: scores are named probabilities and confidence never transfers across labels', () => {
  const out = INTENT_LABELS.map((_, i) => i === 0 ? 0.99 : 0.01 / 11);
  const result = decideIntent(out, { label: 'code', similarity: 0.85, support: 0.7, exact: false });
  assert.equal(result.label, 'code');
  assert.equal(result.source, 'neural+knn');
  assert.ok(result.confidence < 0.85, 'not the unrelated greeting probability 0.99');
  assert.deepEqual(Object.keys(result.scores), INTENT_LABELS);
  assert.ok(Math.abs(Object.values(result.scores).reduce((a, b) => a + b) - 1) < 1e-8);
  assert.ok(Object.isFrozen(classifyIntent('example new routing question')));
});

test('neural v2: weighted top-k reports the similarity of its actual winning label', () => {
  const near = nearestIntent([1, 0], [
    { label: 'greeting', vec: [0.99, 0] }, { label: 'code', vec: [0.98, 0] },
    { label: 'code', vec: [0.97, 0] }, { label: 'code', vec: [0.96, 0] },
  ], 4);
  assert.equal(near.label, 'code');
  assert.equal(near.similarity, 0.98);
  assert.ok(near.support < 1 && near.support > 0.5);
});

test('neural v2: owner corrections replace labels, invalidate result cache and remain profile-scoped', (t) => {
  const dataDir = temporary(t), otherDir = temporary(t);
  const text = 'my custom meridian phrase';
  classifyIntent(text, { dataDir }); // cache an old prediction
  assert.equal(learnExample(text, 'code', { dataDir }), true);
  assert.equal(classifyIntent(text, { dataDir }).label, 'code');
  assert.equal(learnExample(text, 'personal', { dataDir }), true);
  assert.equal(classifyIntent(`  ${text.toUpperCase()}  `, { dataDir }).label, 'personal');
  assert.equal(learnExample(text, 'creative', { dataDir: otherDir }), true);
  assert.equal(classifyIntent(text, { dataDir: otherDir }).label, 'creative');
  assert.equal(classifyIntent(text, { dataDir }).label, 'personal');
  const rows = JSON.parse(fs.readFileSync(path.join(dataDir, 'neural-examples.json')));
  assert.equal(rows.length, 1);
  assert.deepEqual({ source: rows[0].source, verified: rows[0].verified }, { source: 'owner', verified: true });
});

test('neural v2: old automatic predictions are NOT trusted; malformed data is not overwritten', (t) => {
  const dataDir = temporary(t), file = path.join(dataDir, 'neural-examples.json');
  fs.writeFileSync(file, JSON.stringify([{ t: 'legacy sample', label: 'math', ts: Date.now() }, { t: 'unverified sample', label: 'code', source: 'owner', verified: false }]));
  const info = brainInfo({ dataDir });
  assert.equal(info.approvedExamples, 0);
  assert.equal(info.ignoredUntrusted, 2);
  assert.equal(loadBrain({ dataDir }).exact.size, 0);
  fs.writeFileSync(file, '{broken data');
  assert.equal(learnExample('new phrase', 'math', { dataDir }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken data');
});

test('neural v2: stratified folds and paraphrase groups are actually disjoint', () => {
  const split = intentSplits([...INTENT_EXAMPLES, { t: 'HEY hi please', label: 'greeting' }]);
  const seen = new Set();
  for (const list of Object.values(split)) for (const ex of list) {
    const key = leakageKey(ex.t);
    assert.ok(!seen.has(key), `duplicate/leak: ${key}`); seen.add(key);
  }
  const groups = matchSplits();
  const targets = Object.values(groups).flat().map((g) => g.target);
  assert.equal(targets.length, new Set(targets).size);
  assert.ok(groups.test.length >= 5);
  assert.deepEqual(intentSplits(INTENT_EXAMPLES), intentSplits(INTENT_EXAMPLES), 'seeded splits');
});

test('neural v2: shipped metrics describe int8 held-out tests, not training fit', () => {
  const ck = shipped();
  assert.equal(ck.version, 2);
  assert.equal(ck.featureVersion, FEATURE_VERSION);
  assert.deepEqual(ck.intent.sizes, [406, 64, 12]);
  assert.equal(ck.meta.intent.approvedRuntimeExamples, 0, 'release excludes private texts');
  assert.ok(ck.meta.intent.test.n >= 60);
  assert.ok(ck.meta.intent.testHybrid.accuracy >= 0.8);
  assert.ok(ck.meta.match.test.accuracy >= 0.8);
  assert.ok(ck.meta.intent.bestEpoch <= ck.meta.intent.trainedEpochs);
  assert.match(ck.meta.intent.evaluation, /train-only memory; int8/);
});

test('neural v2: frozen 72-case probe stays separate from curated/template data', () => {
  const cases = JSON.parse(fs.readFileSync(new URL('./fixtures/neural-holdout.json', import.meta.url)));
  const used = new Set([...INTENT_EXAMPLES, ...templateExamples()].map((e) => exampleKey(e.t)));
  let correct = 0;
  for (const row of cases) {
    assert.ok(!used.has(exampleKey(row.t)), `probe leaked into training: ${row.t}`);
    if (classifyIntent(row.t).label === row.label) correct++;
  }
  assert.equal(cases.length, 72);
  assert.ok(correct / cases.length >= 0.9, `fixed probe: ${correct}/${cases.length}`);
});

test('neural v2: Hindi marks survive normalization and route through learned features', () => {
  assert.ok(normalizeText('पढ़ाई में सुधार').includes('पढ़ाई'));
  assert.equal(classifyIntent('नमस्ते मित्र').label, 'greeting');
  assert.equal(classifyIntent('धन्यवाद दोस्त').label, 'gratitude');
  assert.equal(classifyIntent('गणना 45 + 26').label, 'math');
});

test('neural v2: unrelated function words are not evidence for fact grounding', () => {
  assert.ok(matchScore('capital of india', 'speed of light') < 0.5);
  assert.ok(matchScore('hello how are you', 'b r ambedkar') < 0.5);
  assert.equal(lookupKnowledge('theory of relativity'), null);
  assert.equal(lookupKnowledge('capital'), null, 'an ambiguous fragment is not a country');
  assert.equal(lookupKnowledge('hello how are you'), null);
  assert.equal(lookupKnowledge('bharat ki rajdhani batao')?.id, 'india_capital');
  const plain = lookupKnowledge('speed of light', { data: {} });
  const hinglish = lookupKnowledge('speed of light', { data: { preferredLanguageMode: 'hinglish' } });
  assert.equal(plain.lang, 'english');
  assert.equal(hinglish.lang, 'hinglish', 'cache cannot cross language preferences');
});

test('neural v2: training is reproducible and ignores runtime data by default', () => {
  const one = trainAll({ epochs: 3, seed: 77 });
  const two = trainAll({ epochs: 3, seed: 77 });
  assert.deepEqual(one.checkpoint.intent, two.checkpoint.intent);
  assert.deepEqual(one.checkpoint.match, two.checkpoint.match);
  assert.deepEqual(one.metrics, two.metrics);
  assert.equal(one.metrics.intent.approvedRuntimeExamples, 0);
});

test('neural v2: worker training is real, keeps event loop responsive, and installs atomically', async (t) => {
  const dataDir = temporary(t);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  t.after(() => clearInterval(timer));
  const result = await trainPersonalBrain({ dataDir });
  assert.ok(ticks > 2, 'main thread serviced timers while backprop ran');
  assert.ok(fs.existsSync(result.file));
  assert.ok(brainInfo({ dataDir }).checkpoint.startsWith(dataDir));
  assert.ok(result.metrics.intent.testHybrid.accuracy >= 0.7);
  assert.ok(fs.readdirSync(dataDir).every((p) => !p.endsWith('.tmp')));
});

test('neural v2: /stop or quality failure cannot replace the previous checkpoint', async (t) => {
  const dataDir = temporary(t), file = path.join(dataDir, 'neural-weights.json');
  const original = JSON.stringify(shipped()); fs.writeFileSync(file, original);
  const controller = new AbortController();
  const pending = trainPersonalBrain({ dataDir, epochs: 500, signal: controller.signal });
  await delay(20); controller.abort();
  await assert.rejects(pending, { code: 'ESTOPPED' });
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  await assert.rejects(trainPersonalBrain({ dataDir, epochs: 1 }), /quality gate/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('neural v2: inverted-index similarities/votes agree with a full dense cosine scan', () => {
  const memory = loadBrain().memory;
  for (const text of ['contrast two unusual systems', 'a hopeful fictional adventure please', 'why does a capacitor store charge']) {
    const v = textFeatures(text);
    const top = memory.map((m) => ({ label: m.label, sim: v.reduce((sum, value, i) => sum + value * m.vec[i], 0) }))
      .sort((a, b) => b.sim - a.sim).slice(0, 5);
    const actual = nearestIntent(v, memory);
    if (top[0].sim < 0.45) { assert.equal(actual, null); continue; }
    const votes = new Map();
    for (const m of top) votes.set(m.label, (votes.get(m.label) ?? 0) + m.sim ** 2);
    const label = [...votes].sort((a, b) => b[1] - a[1])[0][0];
    assert.equal(actual.label, label);
    assert.ok(Math.abs(actual.similarity - top.find((m) => m.label === label).sim) < 1e-12);
  }
});
