#!/usr/bin/env node
// Honest local-only microbenchmark: unique queries, cached repeats and a
// FRESH PROCESS cold load are separate. None of these measure provider latency.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { classifyIntent, matchScore, loadBrain, knnClassify, brainInfo } from '../src/neural/index.js';
import { lookupKnowledge } from '../src/knowledge.js';
import { textFeatures } from '../src/neural/text.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bytes = fs.readFileSync(path.join(ROOT, 'test/fixtures/neural-holdout.json'));
const cases = JSON.parse(bytes);
function measure(fn, { unique = false, n = 3000 } = {}) {
  const queries = cases.map((x) => x.t);
  if (!unique) for (const q of queries) fn(q);
  const us = [];
  for (let i = 0; i < n; i++) {
    const q = queries[i % queries.length] + (unique ? ` probe ${i}` : '');
    const started = performance.now(); fn(q); us.push((performance.now() - started) * 1000);
  }
  us.sort((a, b) => a - b);
  return { n, p50Us: us[Math.floor(n * 0.5)], p95Us: us[Math.floor(n * 0.95)], meanUs: us.reduce((a, b) => a + b, 0) / n };
}

const childStarted = performance.now();
const cold = spawnSync(process.execPath, ['--input-type=module', '--eval', `
  import { loadBrain, classifyIntent } from './src/neural/index.js';
  const t = performance.now(); loadBrain(); const loaded = performance.now();
  classifyIntent('explain hazard pointers and memory reclamation');
  console.log(JSON.stringify({ brainLoadMs: loaded-t, firstClassifyMs: performance.now()-loaded }));
`], { cwd: ROOT, encoding: 'utf8', timeout: 15000 });
if (cold.status !== 0) throw new Error(`Cold subprocess failed: ${cold.stderr}`);
const coldLoad = { ...JSON.parse(cold.stdout), processWallMs: performance.now() - childStarted, note: 'brainLoad excludes module imports; processWall includes Node startup/imports/exit' };
loadBrain();
// Evaluate base phrases, then warm JIT with DIFFERENT unique queries before timing.
const rows = cases.map((c) => ({ ...c, pred: classifyIntent(c.t).label }));
for (let i = 0; i < 1000; i++) classifyIntent(`${cases[i % cases.length].t} warmup ${i}`);
const uniqueIntent = measure(classifyIntent, { unique: true });
const knn = measure(knnClassify, { unique: true }); // query vectors already warm, full memory scan
const cachedIntent = measure(classifyIntent, { n: 3000 });
const knowledge = measure(lookupKnowledge, { n: 1000 });
const match = measure((q) => matchScore(q, 'capital of india'), { n: 1000 });
const features = measure(textFeatures, { n: 1000 });
const perClass = {};
for (const c of rows) {
  perClass[c.label] ??= { correct: 0, total: 0 };
  perClass[c.label].total++; if (c.label === c.pred) perClass[c.label].correct++;
}
const info = brainInfo();
const result = {
  version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version,
  measuredAt: new Date().toISOString(), node: process.version, cpu: os.cpus()[0]?.model,
  accuracy: rows.filter((r) => r.label === r.pred).length / rows.length,
  probe: { n: rows.length, sha256: createHash('sha256').update(bytes).digest('hex'), perClass, rows,
    note: 'Fixed developer-created regression probe, not a certified production/general-answer accuracy score.' },
  architecture: info.architecture, uniqueIntent, knn, cachedIntent, knowledge, match, features, coldLoad,
  checkpointMetrics: info.metrics,
  notes: [
    '1000 unique warmups; 3000 unique classification queries include uncached feature work; kNN reuses those vectors but repeats indexed search.',
    'Cached paths are separately warmed and labelled. Timing varies by CPU/load/JIT.',
    'Trainer test uses train-only memory and quantized weights; runtime includes all curated memory examples.',
    'No live AI-provider, desktop-action or end-to-end WhatsApp latency measurements.',
  ],
};
console.log('Local speed (µs/op; NOT LLM/WhatsApp latency):');
for (const [name, r] of Object.entries({ uniqueIntent, knn, cachedIntent, knowledge, match, features })) {
  console.log(`  ${name.padEnd(14)} p50 ${r.p50Us.toFixed(2).padStart(8)} · p95 ${r.p95Us.toFixed(2).padStart(8)} (n=${r.n})`);
}
console.log(`Fresh-process brain load: ${coldLoad.brainLoadMs.toFixed(2)} ms; first classification: ${coldLoad.firstClassifyMs.toFixed(2)} ms.`);
console.log(`Fixed probe: ${rows.filter((r) => r.label === r.pred).length}/${rows.length} (${(result.accuracy * 100).toFixed(1)}%).`);
console.log(`Trainer held-out int8 test: ${(info.metrics.intent.testHybrid.accuracy * 100).toFixed(1)}% (n=${info.metrics.intent.test.n}).`);
const jsonIndex = process.argv.indexOf('--json');
if (jsonIndex !== -1) {
  const dest = process.argv[jsonIndex + 1]; if (!dest) throw new Error('--json needs a file path');
  fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true }); fs.writeFileSync(dest, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`JSON saved: ${dest}`);
}
