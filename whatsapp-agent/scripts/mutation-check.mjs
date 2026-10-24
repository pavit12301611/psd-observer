#!/usr/bin/env node
// Selected fault reintroduction, NOT a whole-program mutation score. Never edit
// the checkout: every candidate runs against its own disposable source mirror.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { testSummary } from './test-evidence.mjs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { root, workspace, testFiles, testEnvironment, runtimeFingerprint } from './test-workspace.mjs';

export const mutations = [
  { id: 'cross-app-cache-read', file: '../webapp/sw.js', before: 'const hit = await cache.match(event.request);', after: 'const hit = await caches.match(event.request);', expected: 'deep/webapp: public shell only reads' },
  { id: 'parent-worker-flags', file: 'neural/training.js', before: 'execArgv: []', after: "execArgv: process.execArgv.filter((arg) => !arg.startsWith('--input-type'))", expected: 'deep/neural: training worker does not inherit' },
  { id: 'lru-update-recency', file: 'fastcache.js', before: '  set(key, value) {\n    this.map.delete(key);', after: '  set(key, value) {', expected: 'deep/cache: updating' },
  { id: 'memo-key-collision', file: 'fastcache.js', before: 'Object.is(arg, -0) ? negativeZero : arg', after: 'String(arg)', expected: 'deep/cache: memoized keys' },
  { id: 'tiny-prompt-overflow', file: 'agentprotocol.js', before: '  if (max <= marker.length) return text.slice(0, max);', after: '', expected: 'deep/property: truncation' },
  { id: 'owner-suffix-bypass', file: 'allowlist.js', before: 'normalizeNumber(c) === owner', after: 'normalizeNumber(c).endsWith(owner)', expected: 'deep/property: owner equivalence' },
  { id: 'parallel-pc-lane', file: 'multitask.js', before: "if (SERIAL.has(cmd)) return { kind: 'command', lane: 'serial'", after: "if (SERIAL.has(cmd)) return { kind: 'command', lane: 'parallel'", expected: 'deep/batch: command allowlist' },
  { id: 'erase-completed-on-stop', file: 'multitask.js', before: '      entry.value = value; returned = true;', after: "      throwIfStopped(signal, 'Batch');\n      entry.value = value; returned = true;", expected: 'deep/batch: cancellation cannot erase' },
  { id: 'private-store-world-readable', file: 'persistence.js', before: "fs.openSync(temp, 'wx', 0o600)", after: "fs.openSync(temp, 'wx', 0o644)", expected: 'deep/store: persisted owner' },
  { id: 'trash-restore-clobber', file: 'safety.js', before: '    moveWithoutClobber(src, dest);\n    return `♻️', after: '    fs.renameSync(src, dest);\n    return `♻️', expected: 'deep/trash: restore never overwrites' },
  { id: 'trash-traversal', file: 'safety.js', before: "  if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' || /[/\\\\\\0]/.test(name))", after: '  if (false)', expected: 'deep/trash: traversal' },
  { id: 'shallow-snapshot', file: 'rollback.js', before: 'for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dest, name));', after: 'for (const name of fs.readdirSync(src)) if (fs.lstatSync(path.join(src, name)).isFile()) copyTree(path.join(src, name), path.join(dest, name));', expected: 'deep/rollback: real nested source' },
  { id: 'late-guard-frame', file: 'guard.js', before: "    if (guard !== state) return 'off';", after: '', expected: 'deep/guard: old capture' },
  { id: 'late-live-frame', file: 'livemirror.js', before: '      if (live !== state) return;', after: '', expected: 'deep/mirror: off during' },
  { id: 'empty-token-auth', file: 'server.js', before: "    if (typeof config.bridgeToken !== 'string' || !config.bridgeToken.trim()) return null;", after: '', expected: 'deep/bridge: missing or blank' },
  { id: 'non-object-http-body', file: 'server.js', before: "        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('JSON object required');", after: '', expected: 'deep/bridge: body must be' },
  { id: 'feature-cache-key-alias', file: 'neural/text.js', before: '  const key = `${dim}:${String(text ?? \'\')}`;', after: "  const key = dim === DEFAULT_DIM ? String(text ?? '') : `d${dim}:${text ?? ''}`;", expected: 'deep/neural: supported custom dimensions' },
  { id: 'panic-retains-memory', file: 'safety.js', before: 'store.reset(); memoryCleared = true;', after: 'memoryCleared = true;', expected: 'deep/panic: pending save' },
];

function execute(mirror) {
  const files = testFiles(path.join(mirror.dir, 'test')).filter((file) => path.basename(file).startsWith('deep-'));
  const result = spawnSync(process.execPath, ['--import', path.join(mirror.dir, 'scripts/test-sandbox.mjs'), '--test', '--test-reporter=tap', '--test-concurrency=3', ...files], {
    cwd: mirror.dir, env: testEnvironment(mirror.dir), encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024, detached: process.platform !== 'win32',
  });
  if (result.error && process.platform !== 'win32') { try { process.kill(-result.pid, 'SIGKILL'); } catch { /* exited */ } }
  return { result, output: (result.stdout ?? '') + (result.stderr ?? '') };
}
export function runMutationChecks() {
const report = { sourceTreeSha256: runtimeFingerprint(), schemaVersion: 1, generatedAt: new Date().toISOString(), scope: `${mutations.length} selected fault reintroductions; NOT exhaustive whole-program mutation coverage`, definitionsSha256: createHash('sha256').update(JSON.stringify(mutations)).digest('hex'), runtime: process.version, results: [] };
const control = workspace('mutation-control');
try {
  const { result, output } = execute(control);
  report.control = testSummary(output, result.status);
  if (!report.control.passed || result.error) throw new Error(`Unmutated control failed; no mutation score is valid:\n${output.slice(-10000)}`);
} finally { control.cleanup(); }
for (const mutation of mutations) {
  const mirror = workspace('mutation');
  try {
    const file = path.join(mirror.dir, 'src', mutation.file), source = fs.readFileSync(file, 'utf8');
    if (source.split(mutation.before).length !== 2) throw new Error(`${mutation.id}: expected exactly one mutation site`);
    fs.writeFileSync(file, source.replace(mutation.before, mutation.after));
    const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (syntax.status !== 0) throw new Error(`${mutation.id}: invalid syntax, NOT a killed mutation`);
    const { result, output } = execute(mirror);
    const failures = output.split('\n').filter((line) => /^not ok /.test(line));
    const intended = failures.filter((line) => line.includes(mutation.expected));
    const status = result.error ? 'inconclusive' : result.status === 0 ? 'survived' : intended.length ? 'killed' : 'inconclusive';
    report.results.push({ id: mutation.id, file: path.posix.normalize(`src/${mutation.file}`), status, detectedBy: intended.map((line) => line.replace(/^not ok \d+ - /, '')), failureCount: failures.length });
    console.log(`${status.toUpperCase()} ${mutation.id}${intended.length ? ` → ${intended[0]}` : ''}`);
  } finally { mirror.cleanup(); }
}
report.killed = report.results.filter((r) => r.status === 'killed').length;
report.total = report.results.length;
const out = path.join(root, '.cache/deep-audit/mutations.json');
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(`Selected mutation checks: ${report.killed}/${report.total} detected (control passed).`);
if (report.killed !== report.total) process.exitCode = 1;

}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runMutationChecks();
