import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, workspace, testEnvironment, testFiles } from '../scripts/test-workspace.mjs';

function fakeProject(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-test-harness-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['src', 'test/nested', 'scripts', 'node_modules', 'data', 'auth_info']) fs.mkdirSync(path.join(dir, name), { recursive: true });
  for (const [name, text] of Object.entries({ 'package.json': '{"type":"module"}', 'src/one.js': 'export const one=1;', 'test/a.test.js': '', 'test/nested/b.test.js': '', 'test/helper.js': '', '.env': 'PRIVATE=fixture', '.env.example': 'PRIVATE=', 'data/state.json': '{"private":"fixture"}', 'auth_info/creds.json': '{"private":"fixture"}' })) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

test('deep/harness: recursive discovery includes new suites but not helper JS', (t) => {
  const dir = fakeProject(t);
  assert.deepEqual(testFiles(path.join(dir, 'test')).map((file) => path.relative(dir, file)), ['test/a.test.js', path.join('test', 'nested', 'b.test.js')]);
});

test('deep/harness: mirrors copy only public inputs, never installed owner data, auth or .env', (t) => {
  const sourceRoot = fakeProject(t), mirror = workspace('harness-check', { sourceRoot }); t.after(mirror.cleanup);
  for (const name of ['src/one.js', 'test/nested/b.test.js', '.env.example']) assert.equal(fs.existsSync(path.join(mirror.dir, name)), true);
  for (const name of ['data/state.json', 'auth_info/creds.json', '.env']) assert.equal(fs.existsSync(path.join(mirror.dir, name)), false);
});

test('deep/harness: source symlinks cannot escape the public mirror', (t) => {
  const sourceRoot = fakeProject(t);
  fs.symlinkSync(path.join(sourceRoot, 'data/state.json'), path.join(sourceRoot, 'src/private-link.js'));
  assert.throws(() => workspace('harness-symlink', { sourceRoot }), /symlink/);
});

test('deep/harness: child environment drops live credentials, desktop access and NODE_OPTIONS', (t) => {
  const names = ['OPENAI_API_KEY', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'NODE_OPTIONS'];
  const before = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  for (const key of names) process.env[key] = 'fixture-do-not-inherit';
  t.after(() => { for (const key of names) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; });
  const env = testEnvironment('/fixture');
  for (const key of names) assert.equal(env[key], undefined);
  assert.equal(env.HOME, path.join('/fixture', 'home')); assert.equal(env.TMPDIR, path.join('/fixture', 'tmp'));
});

test('deep/harness: accidental external fetches fail before a network connection', (t) => {
  const fixture = fakeProject(t);
  const result = spawnSync(process.execPath, ['--import', path.join(root, 'scripts/test-sandbox.mjs'), '--input-type=module', '-e', `
    try { await fetch('https://provider.invalid/never-connect'); process.exitCode=9; }
    catch(e) { console.log(e.message); }
  `], { cwd: root, env: testEnvironment(fixture), encoding: 'utf8', timeout: 2000 });
  assert.equal(result.status, 0); assert.match(result.stdout, /blocks external fetch/);
});

test('deep/harness: execution evidence rejects absent, failing and interrupted summaries', async () => {
  const { testSummary } = await import('../scripts/test-evidence.mjs');
  const tap = '# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 12.5\n';
  assert.equal(testSummary(tap, 0).passed, true);
  assert.equal(testSummary(tap, 1).passed, false);
  assert.equal(testSummary('', 0).passed, false);
  assert.equal(testSummary(tap.replace('# fail 0', '# fail 1'), 0).passed, false);
  assert.equal(testSummary(tap.replace('# cancelled 0', '# cancelled 1'), 0).passed, false);
});

test('deep/harness: runtime fingerprint covers backend and browser code, not absolute checkout location', async () => {
  const { runtimeFingerprint } = await import('../scripts/test-workspace.mjs');
  const make = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-fingerprint-')); for (const name of ['src', 'webapp']) fs.mkdirSync(path.join(dir, name)); fs.writeFileSync(path.join(dir, 'src/a.js'), 'const a = 1;'); fs.writeFileSync(path.join(dir, 'webapp/b.js'), 'const b = 2;'); return dir; };
  const a = make(), b = make();
  try {
    assert.equal(runtimeFingerprint(a), runtimeFingerprint(b));
    fs.writeFileSync(path.join(b, 'webapp/b.js'), 'const b = 3;'); assert.notEqual(runtimeFingerprint(a), runtimeFingerprint(b));
  } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
});
