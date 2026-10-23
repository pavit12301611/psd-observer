import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { MLP } from '../src/neural/nn.js';
import { textFeatures, DEFAULT_DIM, normalizeText } from '../src/neural/text.js';
import { sparseIndices, makeMemory, nearestIntent } from '../src/neural/decision.js';

const seed = 0x503d;

test('deep/neural: analytic backprop agrees with central finite differences through sparse first layer', () => {
  const net = new MLP([70, 4, 2], { seed: 21 });
  const x = Array(70).fill(0); x[0] = .3; x[17] = -.4; x[69] = .7;
  const target = 1, output = net.forward(x);
  const gW = net.W.map((w) => w.map((r) => r.map(() => 0))), gb = net.b.map((r) => r.map(() => 0));
  net._backward(output.map((p, i) => p - Number(i === target)), gW, gb);
  const epsilon = 1e-5;
  const loss = () => -Math.log(net.forward(x)[target]);
  for (const [layer, row, col] of [[0, 0, 0], [0, 1, 17], [0, 2, 69], [0, 3, 4], [1, 0, 0], [1, 1, 3]]) {
    const old = net.W[layer][row][col];
    net.W[layer][row][col] = old + epsilon; const plus = loss();
    net.W[layer][row][col] = old - epsilon; const minus = loss(); net.W[layer][row][col] = old;
    assert.ok(Math.abs(gW[layer][row][col] - (plus - minus) / (2 * epsilon)) < 1e-7, `gradient ${layer}/${row}/${col}`);
  }
  for (let layer = 0; layer < net.b.length; layer++) for (let row = 0; row < net.b[layer].length; row++) {
    const old = net.b[layer][row]; net.b[layer][row] = old + epsilon; const plus = loss();
    net.b[layer][row] = old - epsilon; const minus = loss(); net.b[layer][row] = old;
    assert.ok(Math.abs(gb[layer][row] - (plus - minus) / (2 * epsilon)) < 1e-7, `bias gradient ${layer}/${row}`);
  }
});

test('deep/property: arbitrary Unicode yields finite deterministic normalized features (1000 cases)', () => {
  const unicode = fc.array(fc.integer({ min: 0, max: 0x10ffff }).filter((x) => x < 0xd800 || x > 0xdfff), { maxLength: 80 }).map((points) => String.fromCodePoint(...points));
  fc.assert(fc.property(unicode, (text) => {
    const vec = textFeatures(text), before = Array.from(vec);
    assert.equal(vec.length, DEFAULT_DIM); assert.ok(before.every(Number.isFinite));
    const norm = Math.sqrt(before.reduce((a, v) => a + v * v, 0));
    assert.ok(norm === 0 || Math.abs(norm - 1) < 1e-5);
    assert.deepEqual(Array.from(textFeatures(text)), before);
    assert.equal(normalizeText(normalizeText(text)), normalizeText(text));
  }), { seed, numRuns: 1000 });
});

test('deep/neural: sparse and dense inference agree without changing model or input', () => {
  const net = new MLP([70, 8, 3], { seed: 2 });
  const input = new Float32Array(70); input[2] = .5; input[25] = .4; input[69] = -.2;
  const before = JSON.stringify(net.toJSON()), x = Array.from(input);
  const sparse = net.forward(input, sparseIndices(input));
  const dense = net.forward(input, Array.from({ length: 70 }, (_, i) => i));
  assert.deepEqual(sparse, dense); assert.deepEqual(Array.from(input), x); assert.equal(JSON.stringify(net.toJSON()), before);
});

test('deep/property: indexed nearest-neighbour similarity matches an independent dense cosine oracle (300 cases)', () => {
  const examples = [{ t: 'hello friend', label: 'greeting' }, { t: 'write code for a sort function', label: 'code' }, { t: 'calculate a large integral', label: 'math' }, { t: 'a poem about the river', label: 'creative' }];
  const memory = makeMemory(examples);
  fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 100 }), fc.constantFrom(...examples.map((x) => x.t))), (text) => {
    const vec = textFeatures(text);
    const dense = memory.map((row) => ({ ...row, sim: vec.reduce((sum, v, i) => sum + v * row.vec[i], 0) })).sort((a, b) => b.sim - a.sim);
    const actual = nearestIntent(vec, memory, 1, sparseIndices(vec));
    if (dense[0].sim < .45) assert.equal(actual, null);
    else { assert.equal(actual.label, dense[0].label); assert.ok(Math.abs(actual.similarity - (dense[0].sim >= .99999 ? 1 : dense[0].sim)) < 1e-10); }
  }), { seed, numRuns: 300 });
});


test('deep/neural: supported custom dimensions remain finite and cannot collide with default cache keys', () => {
  const defaultVec = textFeatures('d384:hello');
  assert.equal(defaultVec.length, DEFAULT_DIM);
  for (const dim of [23, 64, 128, 384, 512]) {
    const vec = textFeatures('hello', dim);
    assert.equal(vec.length, dim); assert.ok(vec.every(Number.isFinite));
    assert.ok(Math.abs(Math.sqrt(vec.reduce((sum, v) => sum + v*v, 0)) - 1) < 1e-10);
  }
  assert.equal(textFeatures('d384:hello').length, DEFAULT_DIM);
  for (const dim of [0, 10, -1, 4.5, NaN, Infinity, 999999]) assert.throws(() => textFeatures('x', dim), RangeError);
});

test('deep/neural: training worker does not inherit incompatible parent CLI/V8 flags', async (t) => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { trainPersonalBrain } = await import('../src/neural/training.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-worker-flags-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const original = process.execArgv;
  try {
    process.execArgv = ['--stack-trace-limit=10', '--input-type=module'];
    // One epoch intentionally misses the quality gate: reaching that gate proves
    // the worker actually trained, rather than failing in its constructor.
    await assert.rejects(trainPersonalBrain({ dataDir, epochs: 1 }), /quality gate failed/);
    assert.equal(fs.existsSync(path.join(dataDir, 'neural-weights.json')), false);
  } finally { process.execArgv = original; }
});
