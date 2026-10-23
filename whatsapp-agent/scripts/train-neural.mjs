#!/usr/bin/env node
// Release training is public-corpus only. Personal examples require --runtime
// and must be written to a PRIVATE override, never the shipped checkpoint.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { trainAll, saveCheckpoint, INTENT_HIDDEN, MATCH_HIDDEN } from '../src/neural/train.js';
import { INTENT_LABELS, INTENT_EXAMPLES, MATCH_PARAPHRASES } from '../src/neural/dataset.js';
import { DEFAULT_DIM } from '../src/neural/text.js';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = path.join(ROOT, 'src/neural/weights.json');
const args = { out: SHIPPED, seed: 42, epochs: 90 };
try {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--epochs') args.epochs = Number(argv[++i]);
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--runtime') args.dataDir = path.resolve(argv[++i]);
    else if (a === '--stats') args.stats = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  if (!Number.isInteger(args.epochs) || args.epochs < 1 || args.epochs > 500) throw new Error('--epochs must be 1..500');
  if (!Number.isSafeInteger(args.seed) || args.seed < 0 || args.seed > 0xffffffff) throw new Error('--seed must be a uint32');
  if (args.dataDir && args.out === SHIPPED) throw new Error('Personal training needs --out data/neural-weights.json (not the shipped/public checkpoint)');
} catch (err) { console.error(err.message); process.exit(1); }
if (args.help) {
  console.log('Usage: node scripts/train-neural.mjs [--epochs 1..500] [--seed N] [--out FILE] [--runtime DATA_DIR] [--stats]');
  process.exit(0);
}
console.log(`Dataset: ${INTENT_EXAMPLES.length} examples / ${INTENT_LABELS.length} intents; ${MATCH_PARAPHRASES.length} paraphrase groups.`);
console.log(args.dataDir ? 'Personal training: explicitly approved labels only; legacy predictions ignored.' : 'Public-corpus training: no runtime conversations included.');
if (args.stats) process.exit(0);
console.log(`Training IntentNet [${DEFAULT_DIM}→${INTENT_HIDDEN}→12] + MatchNet [13→${MATCH_HIDDEN}→1] on CPU…`);
const started = Date.now();
const { checkpoint, metrics } = trainAll({ ...args, includeRuntime: Boolean(args.dataDir) });
const pct = (x) => `${(100 * x).toFixed(1)}%`;
console.log(`Intent (int8): validation ${pct(metrics.intent.valHybrid.accuracy)}, TEST ${pct(metrics.intent.testHybrid.accuracy)} (n=${metrics.intent.test.n}, macro-F1=${metrics.intent.testHybrid.macroF1.toFixed(3)})`);
console.log(`Match (int8, unseen groups): validation ${pct(metrics.match.val.accuracy)}, TEST ${pct(metrics.match.test.accuracy)} (n=${metrics.match.test.n})`);
console.log(`Best intent epoch ${metrics.intent.bestEpoch}/${metrics.intent.trainedEpochs}; calibrated temperature ${checkpoint.temperature}.`);
saveCheckpoint(checkpoint, args.out);
console.log(`Saved ${args.out} (${Math.round(fs.statSync(args.out).size / 1024)} KiB) in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
