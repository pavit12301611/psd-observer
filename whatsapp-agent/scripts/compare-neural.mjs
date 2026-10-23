#!/usr/bin/env node
// Same-harness before/after comparison. Uses `git show`, never checks out or
// mutates branches. Requires a Git clone containing the chosen baseline commit.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureBytes = fs.readFileSync(path.join(ROOT, 'test/fixtures/neural-holdout.json'));
const cases = JSON.parse(fixtureBytes);

if (process.argv[2] === '--worker') {
  const { classifyIntent, knnClassify, loadBrain } = await import(pathToFileURL(process.argv[3]).href);
  const rows = cases.map((c) => ({ ...c, pred: classifyIntent(c.t).label }));
  for (let i = 0; i < 1000; i++) classifyIntent(`${cases[i % cases.length].t} warmup ${i}`);
  const measure = (fn) => {
    const us = [];
    for (let i = 0; i < 3000; i++) {
      const q = `${cases[i % cases.length].t} probe ${i}`;
      const started = performance.now(); fn(q); us.push((performance.now() - started) * 1000);
    }
    us.sort((a, b) => a - b);
    return { p50Us: us[1500], p95Us: us[2850] };
  };
  console.log(JSON.stringify({ uniqueIntent: measure(classifyIntent), knn: measure(knnClassify),
    correct: rows.filter((c) => c.label === c.pred).length, rows, architecture: loadBrain().intent.sizes }));
  process.exit(0);
}
if (process.argv.includes('--help')) {
  console.log('Usage: node scripts/compare-neural.mjs [--ref COMMIT_SHA] [--out REPORT.json]\nDefault baseline: 507d640. Needs Git history; npm run bench also works from release bundles.');
  process.exit(0);
}
const option = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`${flag} needs a value`);
  return process.argv[i + 1];
};
const ref = option('--ref', '507d640');
if (!/^[a-f0-9]{7,40}$/i.test(ref)) throw new Error('--ref must be a commit SHA');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-neural-baseline-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
try {
  const git = (args) => execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let baselineCommit;
  try { baselineCommit = git(['rev-parse', ref]).toString().trim(); }
  catch { throw new Error('Comparison needs a Git checkout containing the baseline commit; use npm run bench for the current runtime only.'); }
  const oldDir = path.join(tmp, 'src/neural'); fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  for (const name of ['index.js', 'nn.js', 'text.js', 'dataset.js', 'weights.json']) {
    fs.writeFileSync(path.join(oldDir, name), git(['show', `${ref}:whatsapp-agent/src/neural/${name}`]));
  }
  // Mirror public source/weights only: a user's private data/ override must
  // never affect a public-release comparison (or leak into its metadata).
  const currentDir = path.join(tmp, 'current/src/neural');
  fs.cpSync(path.join(ROOT, 'src/neural'), currentDir, { recursive: true });
  const trials = { before: [], after: [] };
  const runtimes = { before: path.join(oldDir, 'index.js'), after: path.join(currentDir, 'index.js') };
  for (let trial = 0; trial < 3; trial++) {
    for (const name of trial % 2 ? ['after', 'before'] : ['before', 'after']) {
      const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--worker', runtimes[name]], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
      if (child.status !== 0) throw new Error(child.stderr || 'Benchmark worker failed');
      trials[name].push(JSON.parse(child.stdout));
    }
  }
  const summary = Object.fromEntries(Object.entries(trials).map(([name, rows]) => [name, {
    architecture: rows[0].architecture, probeCorrect: rows[0].correct, probeTotal: cases.length,
    ...Object.fromEntries(['uniqueIntent', 'knn'].map((key) => [key, {
      p50Us: median(rows.map((r) => r[key].p50Us)), p95Us: median(rows.map((r) => r[key].p95Us)),
    }])),
  }]));
  const { runBatch } = await import('../src/multitask.js');
  const simulate = async (concurrency) => {
    let active = 0, peak = 0;
    const started = performance.now();
    await runBatch(Array.from({ length: 4 }, () => ({ lane: 'parallel' })), { concurrency,
      run: async () => { active++; peak = Math.max(peak, active); await delay(40); active--; return { ok: true, text: 'simulated answer' }; },
    });
    return { ms: performance.now() - started, peak };
  };
  const serial = [], parallel = [];
  for (let i = 0; i < 3; i++) { serial.push(await simulate(1)); parallel.push(await simulate(2)); }
  const { brainInfo } = await import(pathToFileURL(runtimes.after).href);
  const info = brainInfo();
  const report = {
    version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'))).version,
    measuredAt: new Date().toISOString(), baselineCommit,
    environment: { node: process.version, cpu: os.cpus()[0]?.model, platform: process.platform },
    method: { uniqueWarmups: 1000, samplesPerPathPerTrial: 3000, trialsPerRuntime: 3,
      aggregation: 'median of trial percentiles; fresh processes; runtime order interleaved; kNN reuses prepared query vectors' },
    summary,
    speedupP50: { uniqueIntent: summary.before.uniqueIntent.p50Us / summary.after.uniqueIntent.p50Us,
      knn: summary.before.knn.p50Us / summary.after.knn.p50Us },
    probe: { sha256: sha(fixtureBytes), rows: trials.after[0].rows.map((r, i) => ({ ...r, before: trials.before[0].rows[i].pred })) },
    checkpoint: { sha256: sha(fs.readFileSync(path.join(ROOT, 'src/neural/weights.json'))), metrics: info.metrics },
    timings: Object.fromEntries(Object.entries(trials).map(([name, rows]) => [name, rows.map(({ uniqueIntent, knn }) => ({ uniqueIntent, knn }))])),
    schedulerFixture: { tasks: 4, simulatedWaitMsPerTask: 40, trials: 3,
      serialMedianMs: median(serial.map((r) => r.ms)), parallel2MedianMs: median(parallel.map((r) => r.ms)), peakParallel: Math.max(...parallel.map((r) => r.peak)),
      note: 'Synthetic timer workload, NOT measured live AI-provider/WhatsApp speed.' },
    limitations: [
      'Fixed developer-created routing regression probe; not a certified production or overall-answer accuracy estimate.',
      'Held-out trainer metrics are int8 with train-only memory. Runtime includes all curated memory examples.',
      'CPU timings vary with JIT/host load. No live provider, installed-PC or desktop actions were benchmarked.',
      'Runtime personalization and external language models are not part of this comparison.',
    ],
  };
  console.log(JSON.stringify({ summary, speedupP50: report.speedupP50, schedulerFixture: report.schedulerFixture }, null, 2));
  const out = option('--out', '');
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`); }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
