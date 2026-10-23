import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { moveToTrash, restoreTrash, requestConfirm, confirmPending, cancelPending, CONFIRM_TTL_MS } from '../src/safety.js';
import { saveSnapshot, rollback, latestSnapshot, MAX_SNAPSHOTS } from '../src/rollback.js';
import { Store } from '../src/store.js';
import { atomicJSON } from '../src/neural/storage.js';

const temp = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-deep-safety-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const text = (file) => fs.readFileSync(file, 'utf8');
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };

test('deep/trash: same timestamp and basename never overwrite earlier trashed contents', (t) => {
  const dir = temp(t), trashDir = path.join(dir, 'trash');
  const a = path.join(dir, 'one/report.txt'), b = path.join(dir, 'two/report.txt');
  write(a, 'first'); write(b, 'second');
  const one = moveToTrash(a, { trashDir, now: 123 }), two = moveToTrash(b, { trashDir, now: 123 });
  assert.equal(one.ok, true); assert.equal(two.ok, true); assert.notEqual(one.dest, two.dest);
  assert.equal(text(one.dest), 'first'); assert.equal(text(two.dest), 'second');
});

test('deep/trash: restore never overwrites an existing owner file', (t) => {
  const dir = temp(t), trashDir = path.join(dir, 'trash'), file = path.join(dir, 'report.txt');
  write(file, 'old'); const moved = moveToTrash(file, { trashDir, now: 123 }); write(file, 'new');
  const reply = restoreTrash(path.basename(moved.dest), { trashDir, destDir: dir });
  assert.doesNotMatch(reply, /Restored/); assert.equal(text(file), 'new'); assert.equal(text(moved.dest), 'old');
});

test('deep/trash: traversal, absolute paths and empty names cannot move files outside trash', (t) => {
  const dir = temp(t), trashDir = path.join(dir, 'trash'), destDir = path.join(dir, 'nested/dest');
  fs.mkdirSync(trashDir); fs.mkdirSync(destDir, { recursive: true }); write(path.join(dir, 'outside.txt'), 'must remain');
  for (const name of ['../outside.txt', '..', '.', '', path.join(dir, 'outside.txt'), 'sub/../../outside.txt', 'sub\\file']) {
    const reply = restoreTrash(name, { trashDir, destDir }); assert.doesNotMatch(reply, /Restored/);
  }
  assert.equal(text(path.join(dir, 'outside.txt')), 'must remain'); assert.deepEqual(fs.readdirSync(destDir), []);
});

test('deep/trash: symlink entries are restored as links without modifying their targets', (t) => {
  const dir = temp(t), trashDir = path.join(dir, 'trash');
  const target = path.join(dir, 'outside.txt'), link = path.join(dir, 'link.txt');
  write(target, 'private'); fs.symlinkSync(target, link);
  const moved = moveToTrash(link, { trashDir, now: 123 }); assert.equal(moved.ok, true);
  assert.match(restoreTrash(path.basename(moved.dest), { trashDir, destDir: dir }), /Restored/);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true); assert.equal(text(target), 'private');
});

test('deep/trash: a trash directory inside the target is rejected without partial movement', (t) => {
  const dir = temp(t), victim = path.join(dir, 'folder'); write(path.join(victim, 'keep.txt'), 'keep');
  const result = moveToTrash(victim, { trashDir: path.join(victim, 'trash') });
  assert.equal(result.ok, false); assert.equal(text(path.join(victim, 'keep.txt')), 'keep');
});

test('deep/confirm: expired and wrong tokens do not authorize, a successful token is one-shot', () => {
  cancelPending();
  const message = requestConfirm('rm', '/tmp/fixture', { now: 100 });
  const token = message.match(/\/confirm (\w+)/)[1];
  assert.equal(confirmPending('wrong', { now: 101 }).ok, false);
  assert.equal(confirmPending(token, { now: 100 + CONFIRM_TTL_MS + 1 }).ok, false);
  assert.equal(confirmPending(token, { now: 101 }).ok, false);
  const next = requestConfirm('kill', 'fixture', { now: 100 });
  assert.equal(confirmPending(next.match(/\/confirm (\w+)/)[1], { now: 101 }).ok, true);
  assert.equal(confirmPending('yes', { now: 102 }).ok, false);
});

function project(t) {
  const dir = temp(t), root = path.join(dir, 'project'), snapRoot = path.join(dir, 'snaps');
  write(path.join(root, 'src/app.js'), 'version one'); write(path.join(root, 'src/neural/model.js'), 'nested version one');
  write(path.join(root, 'package.json'), '{"version":"1.0.0"}'); write(path.join(root, 'package-lock.json'), '{"version":"1.0.0","lockfileVersion":3}');
  return { dir, root, snapRoot };
}

test('deep/rollback: real nested source and package lock round-trip; stale new source is removed', (t) => {
  const f = project(t); assert.equal(saveSnapshot({ ...f, now: 100 }).ok, true);
  write(path.join(f.root, 'src/neural/model.js'), 'broken'); write(path.join(f.root, 'src/new-only.js'), 'stale');
  write(path.join(f.root, 'package-lock.json'), '{"version":"2.0.0"}');
  assert.match(rollback(f), /Rolled back/);
  assert.equal(text(path.join(f.root, 'src/neural/model.js')), 'nested version one');
  assert.equal(fs.existsSync(path.join(f.root, 'src/new-only.js')), false);
  assert.equal(JSON.parse(text(path.join(f.root, 'package-lock.json'))).version, '1.0.0');
});

test('deep/rollback: incomplete snapshots are never selected and failed creation cannot prune a good backup', (t) => {
  const f = project(t); const first = saveSnapshot({ ...f, now: 100 }); assert.equal(first.ok, true);
  write(path.join(f.snapRoot, '9999999999999-incomplete/src/app.js'), 'bad');
  assert.equal(latestSnapshot(f.snapRoot), first.dest);
  fs.unlinkSync(path.join(f.root, 'package.json'));
  assert.equal(saveSnapshot({ ...f, now: 999 }).ok, false);
  assert.equal(latestSnapshot(f.snapRoot), first.dest);
});

test('deep/rollback: a symlink in source is rejected and cannot escape a snapshot', (t) => {
  const f = project(t); write(path.join(f.dir, 'private.txt'), 'private');
  fs.symlinkSync(path.join(f.dir, 'private.txt'), path.join(f.root, 'src/private-link'));
  assert.equal(saveSnapshot({ ...f, now: 100 }).ok, false);
  assert.equal(latestSnapshot(f.snapRoot), null);
  assert.equal(text(path.join(f.dir, 'private.txt')), 'private');
});

test('deep/rollback: labels stay inside the backup directory and pruning retains newest complete snapshots', (t) => {
  const f = project(t);
  for (let i = 0; i < MAX_SNAPSHOTS + 2; i++) {
    const saved = saveSnapshot({ ...f, now: 100 + i, label: '../../unsafe label' });
    assert.equal(saved.ok, true); assert.equal(path.dirname(saved.dest), f.snapRoot);
  }
  assert.equal(fs.readdirSync(f.snapRoot).filter((x) => !x.startsWith('.')).length, MAX_SNAPSHOTS);
});

test('deep/rollback: malformed package or an external snapshot fails before modifying live code', (t) => {
  const f = project(t); const saved = saveSnapshot({ ...f, now: 100 }); assert.equal(saved.ok, true);
  write(path.join(f.root, 'src/app.js'), 'current');
  write(path.join(saved.dest, 'package.json'), 'invalid JSON');
  assert.doesNotMatch(rollback({ ...f, snapshot: saved.dest }), /Rolled back/);
  assert.equal(text(path.join(f.root, 'src/app.js')), 'current');
  const other = path.join(f.dir, 'other'); write(path.join(other, 'src/app.js'), 'outside'); write(path.join(other, 'package.json'), '{}');
  assert.doesNotMatch(rollback({ ...f, snapshot: other }), /Rolled back/);
  assert.equal(text(path.join(f.root, 'src/app.js')), 'current');
});

test('deep/store: damaged JSON field shapes are normalized, unrelated owner fields survive', (t) => {
  const dir = temp(t), file = path.join(dir, 'state.json');
  write(file, JSON.stringify({ notes: null, todos: {}, reminders: 'bad', history: false, downloads: 7, callSchedules: {}, facts: [], factValues: [], stats: { received: 'wrong' }, offlineMessage: 'keep me' }));
  const store = new Store(file);
  for (const key of ['notes', 'todos', 'reminders', 'history', 'downloads', 'callSchedules']) assert.deepEqual(store.data[key], []);
  assert.deepEqual(store.data.facts, {}); assert.deepEqual(store.data.factValues, {});
  assert.equal(store.data.stats.received, 0); assert.equal(store.data.offlineMessage, 'keep me');
  store.addNote('works after load'); store.saveNow();
  assert.equal(new Store(file).data.notes[0].text, 'works after load');
});

test('deep/store: persisted owner conversations are private to their OS user', (t) => {
  const oldMask = process.umask(0o022); t.after(() => process.umask(oldMask));
  const file = path.join(temp(t), 'data/state.json'), store = new Store(file);
  store.pushHistory('user', 'private fixture'); store.saveNow();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0);
});

test('deep/persistence: failed serialization never replaces a valid file or leaves temp files', (t) => {
  const file = path.join(temp(t), 'state.json'); atomicJSON(file, { keep: true });
  const circular = {}; circular.self = circular;
  assert.throws(() => atomicJSON(file, circular));
  assert.deepEqual(JSON.parse(text(file)), { keep: true });
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});

test('deep/store: due reminders and calls are delivered exactly once at boundary time', (t) => {
  const store = new Store(path.join(temp(t), 'state.json'));
  const a = store.addReminder('a', 100), b = store.addReminder('b', 101);
  assert.deepEqual(store.popDueReminders(100).map((x) => x.id), [a.id]);
  assert.deepEqual(store.popDueReminders(100), []); assert.equal(store.data.reminders[0].id, b.id);
  store.addCallSchedule('call', 100);
  assert.equal(store.popDueCallSchedules(100).length, 1); assert.equal(store.popDueCallSchedules(100).length, 0);
  store.saveNow();
});

test('deep/panic: pending save cannot resurrect wiped owner history or facts', async (t) => {
  const dir = temp(t), file = path.join(dir, 'state.json'), store = new Store(file);
  store.pushHistory('user', 'private must disappear'); store.data.facts.secret = 'private must disappear';
  store.saveNow(); store.save();
  const { runPanic } = await import('../src/safety.js');
  const result = runPanic({ dataDir: dir, store });
  await new Promise((r) => setTimeout(r, 190));
  assert.equal(result.memoryCleared, true);
  assert.deepEqual(store.data.history, []); assert.deepEqual(store.data.facts, {});
  if (fs.existsSync(file)) assert.doesNotMatch(text(file), /private must disappear/);
});

test('deep/persistence: a partial failed write leaves the old state and cleans its owned temporary', (t) => {
  const file = path.join(temp(t), 'state.json'); atomicJSON(file, { keep: true });
  const original = fs.writeFileSync;
  fs.writeFileSync = (target, data, ...rest) => {
    if (typeof target === 'number') { original(target, String(data).slice(0, 3)); throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' }); }
    return original(target, data, ...rest);
  };
  try { assert.throws(() => atomicJSON(file, { replace: true }), /disk full/); }
  finally { fs.writeFileSync = original; }
  assert.deepEqual(JSON.parse(text(file)), { keep: true }); assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json']);
});

test('deep/rollback: mid-install rename failure restores all previous live source and package bytes', (t) => {
  const f = project(t), saved = saveSnapshot({ ...f, now: 100 }); assert.equal(saved.ok, true);
  write(path.join(f.root, 'src/app.js'), 'current version'); write(path.join(f.root, 'package.json'), '{"version":"2.0.0"}');
  write(path.join(f.root, 'package-lock.json'), '{"version":"2.0.0"}');
  const original = fs.renameSync; let injected = false;
  fs.renameSync = (from, to) => {
    if (!injected && from.endsWith(path.join('new', 'package.json'))) { injected = true; throw new Error('injected install failure'); }
    return original(from, to);
  };
  let reply;
  try { reply = rollback({ ...f, snapshot: saved.dest }); } finally { fs.renameSync = original; }
  assert.match(reply, /Rollback fail/); assert.equal(injected, true);
  assert.equal(text(path.join(f.root, 'src/app.js')), 'current version');
  assert.equal(JSON.parse(text(path.join(f.root, 'package.json'))).version, '2.0.0');
  assert.equal(JSON.parse(text(path.join(f.root, 'package-lock.json'))).version, '2.0.0');
  assert.equal(fs.readdirSync(f.root).some((x) => x.startsWith('.rollback-')), false);
});

test('deep/rollback: integrity failures reject altered source before replacing live files', (t) => {
  const f = project(t), saved = saveSnapshot({ ...f, now: 100 });
  write(path.join(saved.dest, 'src/app.js'), 'tampered'); write(path.join(f.root, 'src/app.js'), 'current');
  assert.match(rollback({ ...f, snapshot: saved.dest }), /integrity/);
  assert.equal(text(path.join(f.root, 'src/app.js')), 'current');
});

test('deep/confirm: exact TTL boundary and backward clocks expire safely, including status', () => {
  const msg = requestConfirm('rm', 'fixture', { now: 100 });
  assert.equal(confirmPending(msg.match(/\/confirm (\w+)/)[1], { now: 100 + CONFIRM_TTL_MS }).ok, false);
  const next = requestConfirm('rm', 'fixture', { now: 100 });
  assert.equal(confirmPending(next.match(/\/confirm (\w+)/)[1], { now: 99 }).ok, false);
});
