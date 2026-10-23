#!/usr/bin/env node
// Cross-platform recursive discovery + public-source mirror. Even legacy
// modules with ROOT/data constants cannot write an installed owner's profile.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { testSummary } from './test-evidence.mjs';
import { root, workspace, testFiles, testEnvironment, runtimeFingerprint } from './test-workspace.mjs';

const args = process.argv.slice(2), coverage = args.includes('--coverage');
const options = args.filter((arg) => !['--coverage', '--contracts'].includes(arg));
const mirror = workspace();
const files = testFiles(path.join(mirror.dir, 'test')).filter((file) => !args.includes('--contracts') || path.basename(file).startsWith('deep-'));
const nodeArgs = ['--import', path.join(mirror.dir, 'scripts/test-sandbox.mjs'), '--test', '--test-reporter=tap', ...options, ...files];
const reportDir = path.join(root, 'coverage');
const commandArgs = coverage ? [path.join(root, 'node_modules/c8/bin/c8.js'), '--all', '--include=src/**/*.js', '--include=webapp/**/*.js', '--exclude=**/node_modules/**', '--reporter=json', '--reporter=json-summary', '--reporter=text-summary', '--reporter=html', `--reports-dir=${reportDir}`, '--temp-directory=' + path.join(mirror.dir, '.coverage-tmp'), process.execPath, ...nodeArgs] : nodeArgs;
console.log(`Isolated test workspace: ${files.length} recursively discovered suites · ${process.version}${coverage ? ' · full-source coverage' : ''}`);
const mode = args.includes('--contracts') ? 'contracts' : coverage ? 'coverage' : 'full';
const evidenceFile = path.join(root, `.cache/deep-audit/tests-${mode}-node${process.versions.node.split('.')[0]}.json`);
fs.rmSync(evidenceFile, { force: true });
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const inputs = ['package.json', 'package-lock.json', 'release-notes.json', 'webapp/index.html', 'src/neural/weights.json', 'test/bundle_verifier_test.py', ...files.map((file) => path.relative(mirror.dir, file)), ...['test-evidence.mjs', 'test-workspace.mjs', 'test-sandbox.mjs', 'test.mjs', 'audit-report.mjs', 'function-inventory.mjs', 'mutation-check.mjs', 'verify-bundle.py'].map((name) => `scripts/${name}`)];
const inputHashes = Object.fromEntries(inputs.map((name) => [name, hash(path.join(mirror.dir, name))]));
const startedAt = new Date().toISOString(), sourceTreeSha256 = runtimeFingerprint(mirror.dir);
let child, output = '';
try {
  child = spawn(process.execPath, commandArgs, { cwd: mirror.dir, env: testEnvironment(mirror.dir), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  child.stdout.on('data', (data) => { output += data; process.stdout.write(data); });
  child.stderr.on('data', (data) => process.stderr.write(data));
  const stop = (signal) => {
    try { if (process.platform !== 'win32') process.kill(-child.pid, signal); else child.kill(signal); } catch { /* exited */ }
  };
  const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (status, signal) => resolve(status ?? (signal === 'SIGINT' ? 130 : 1))); });
  process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm);
  if (coverage) {
    // Coverage locations must identify checked-in source, not a deleted mirror.
    for (const name of ['coverage-final.json', 'coverage-summary.json']) {
      const file = path.join(reportDir, name);
      if (!fs.existsSync(file)) continue;
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(mirror.dir).join(root));
    }
  }
  const sourceStable = sourceTreeSha256 === runtimeFingerprint() && sourceTreeSha256 === runtimeFingerprint(mirror.dir) && Object.entries(inputHashes).every(([name, digest]) => hash(path.join(root, name)) === digest && hash(path.join(mirror.dir, name)) === digest);
  const result = { node: process.version, mode, scope: mode === 'contracts' ? 'added contracts only' : 'all', testSuites: files.length, startedAt, finishedAt: new Date().toISOString(), sourceTreeSha256, sourceStable, inputHashes, ...testSummary(output, code), ...(coverage ? { coverageSummarySha256: hash(path.join(reportDir, 'coverage-summary.json')), coverageFinalSha256: hash(path.join(reportDir, 'coverage-final.json')) } : {}) };
  if (!sourceStable) result.passed = false;
  fs.writeFileSync(evidenceFile, JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.passed ? 0 : code || 1;
} finally { mirror.cleanup(); }
