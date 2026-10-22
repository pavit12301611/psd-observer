// scripts/bench.mjs — speed + accuracy benchmark for the neural brain.
// Run: npm run bench   (also used by tests to keep the fast-path fast)
import { classifyIntent, matchScore, loadBrain, knnClassify } from '../src/neural/index.js';
import { lookupKnowledge } from '../src/knowledge.js';
import { INTENT_LABELS, INTENT_EXAMPLES } from '../src/neural/dataset.js';
import { textFeatures } from '../src/neural/text.js';

const QUERIES = [
  'hi bhai kaise ho',
  'what is the capital of india',
  'bharat ki rajdhani batao',
  'explain how neural networks work',
  'write a python function to reverse a string',
  'solve 2x + 5 = 15',
  'mood bahut off hai aaj',
  'likho ek poem barish pe',
  'tcp vs udp me kya farak hai',
  'how to install docker on fedora',
];

function bench(name, fn, iters) {
  fn(); // warm-up
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn(QUERIES[i % QUERIES.length]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { name, opsPerSec: Math.round((iters / ms) * 1000), usPerOp: (ms * 1000) / iters };
}

const results = [];
results.push(bench('classifyIntent', (q) => classifyIntent(q), 3000));
results.push(bench('matchScore', (q) => matchScore(q, 'capital of india'), 3000));
results.push(bench('lookupKnowledge', (q) => lookupKnowledge(q), 3000));
results.push(bench('knnClassify', (q) => knnClassify(q), 3000));
results.push(bench('textFeatures', (q) => textFeatures(q), 3000));

console.log('⚡ Speed (higher ops/sec = faster):');
for (const r of results) {
  console.log(`   ${r.name.padEnd(16)} ${String(r.opsPerSec).padStart(8)} ops/s   ${r.usPerOp.toFixed(1).padStart(7)} µs/op`);
}

// Cold start: fresh brain load + first classify
const t0 = process.hrtime.bigint();
const brain = loadBrain();
const loadMs = Number(process.hrtime.bigint() - t0) / 1e6;
console.log(`   cold loadBrain      ${loadMs.toFixed(1)} ms (once at startup)`);
console.log(`   kNN memory        ${String(brain.memory.length).padStart(6)} examples`);

// Accuracy snapshot on the full handwritten dataset (train fit — the honest
// held-out number lives in npm run train:neural).
let ok = 0;
let n = 0;
const perClass = {};
for (const ex of INTENT_EXAMPLES) {
  if (ex.t.length < 6) continue;
  n += 1;
  const pred = classifyIntent(ex.t).label;
  if (pred === ex.label) ok += 1;
  perClass[ex.label] ??= { ok: 0, n: 0 };
  perClass[ex.label].n += 1;
  if (pred === ex.label) perClass[ex.label].ok += 1;
}
console.log(`\n🎯 Accuracy snapshot (all ${n} handwritten incl. train): ${(ok / n * 100).toFixed(1)}%`);
const weak = Object.entries(perClass)
  .map(([label, s]) => `${label} ${(s.ok / s.n * 100).toFixed(0)}%`)
  .sort()
  .join(' · ');
console.log(`   per class: ${weak}`);
console.log('\nRun `npm run train:neural` for the honest held-out validation numbers.');
