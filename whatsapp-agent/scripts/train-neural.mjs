#!/usr/bin/env node
// train-neural.mjs — train the neural brain (IntentNet + MatchNet) and write
// the checkpoint to src/neural/weights.json (shipped, auto-loaded at runtime).
//
//   npm run train:neural                 # full training (seconds, CPU only)
//   node scripts/train-neural.mjs --epochs 120 --out data/neural-weights.json
//   node scripts/train-neural.mjs --stats   # print dataset stats only
//
// Real conversations improve it: the agent logs corrections via learnExample()
// into data/neural-examples.json — re-run this and they fold into the weights.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trainAll, saveCheckpoint } from '../src/neural/train.js';
import { INTENT_LABELS, INTENT_EXAMPLES, MATCH_PARAPHRASES } from '../src/neural/dataset.js';
import { INTENT_HIDDEN } from '../src/neural/train.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = path.join(ROOT, 'src', 'neural', 'weights.json');

function parseArgs(argv) {
  const out = { out: DEFAULT_OUT, epochs: null, seed: 42, stats: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = path.resolve(argv[++i]);
    else if (a === '--epochs') out.epochs = Number(argv[++i]);
    else if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--stats') out.stats = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node scripts/train-neural.mjs [--epochs N] [--seed N] [--out weights.json] [--stats]');
  process.exit(0);
}

const perClass = {};
for (const ex of INTENT_EXAMPLES) perClass[ex.label] = (perClass[ex.label] ?? 0) + 1;
console.log('📊 Dataset:');
console.log(`   intents: ${INTENT_EXAMPLES.length} examples · ${INTENT_LABELS.length} classes`, JSON.stringify(perClass));
console.log(`   match pairs: ${MATCH_PARAPHRASES.length} paraphrase groups (${MATCH_PARAPHRASES.reduce((a, g) => a + g.queries.length, 0)} queries)`);
if (args.stats) process.exit(0);

console.log(`\n🧠 Training IntentNet [384→${INTENT_HIDDEN}→12] + MatchNet [13→16→1] (Adam, backprop)…`);
const started = Date.now();
const { checkpoint, metrics } = trainAll({
  seed: args.seed,
  ...(args.epochs ? { epochs: args.epochs } : {}),
});

const pct = (x) => `${(x * 100).toFixed(1)}%`;
console.log('\n📈 Results:');
console.log(`   IntentNet  train acc: ${pct(metrics.intent.train.accuracy)} (${metrics.intent.train.n})   val acc: ${pct(metrics.intent.val.accuracy)} (${metrics.intent.val.n})`);
console.log(`   Hybrid     (neural + k-NN memory) val acc: ${pct(metrics.intent.valHybrid.accuracy)}`);
console.log(`   MatchNet   train acc: ${pct(metrics.match.train.accuracy)} (${metrics.match.train.n})   val acc: ${pct(metrics.match.val.accuracy)} (${metrics.match.val.n})   val P ${pct(metrics.match.val.precision)} / R ${pct(metrics.match.val.recall)}`);
const weak = Object.entries(metrics.intent.val.perClass).filter(([, s]) => s.total && s.correct / s.total < 0.8);
if (weak.length) {
  console.log('   weak classes:', weak.map(([c, s]) => `${c} ${s.correct}/${s.total}`).join(' · '));
}

saveCheckpoint(checkpoint, args.out);
const kb = fs.statSync(args.out).size / 1024;
console.log(`\n✅ Checkpoint saved: ${args.out} (${kb.toFixed(0)} KB) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log('   Runtime loads it automatically — restart the agent (or run npm test) to use it.');
