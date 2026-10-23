import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as guard from '../src/guard.js';
import * as mirror from '../src/livemirror.js';
import { runBatch, batchSummary } from '../src/multitask.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const frame = Buffer.from('fixture only');
const turn = () => new Promise((r) => setImmediate(r));

test('deep/guard: off during a pending camera capture prevents a later alert', async (t) => {
  t.after(() => guard.stopGuard());
  guard.startGuard({ capture: async () => frame, statFn: () => ({ mean: 100 }), send: async () => {}, intervalMs: 60_000 });
  await turn(); const gate = deferred(), sent = [];
  const pending = guard.guardTick({ capture: () => gate.promise, statFn: () => ({ mean: 250 }), send: async (x) => sent.push(x) });
  guard.stopGuard(); gate.resolve(frame);
  assert.equal(await pending, 'off'); assert.equal(sent.length, 0);
});

test('deep/guard: old capture cannot alter the replacement session baseline or send its image', async (t) => {
  t.after(() => guard.stopGuard());
  guard.startGuard({ capture: async () => frame, statFn: () => ({ mean: 100 }), send: async () => {}, intervalMs: 60_000 });
  await turn(); const gate = deferred(), sent = [];
  const old = guard.guardTick({ capture: () => gate.promise, statFn: () => ({ mean: 250 }), send: async (x) => sent.push(x) });
  guard.stopGuard();
  guard.startGuard({ capture: async () => frame, statFn: () => ({ mean: 20 }), send: async () => {}, intervalMs: 60_000 });
  await turn(); gate.resolve(frame); await old;
  const next = await guard.guardTick({ capture: async () => frame, statFn: () => ({ mean: 20 }), send: async (x) => sent.push(x) });
  assert.equal(next, 'quiet'); assert.equal(sent.length, 0);
});

test('deep/guard: overlapping ticks have one capture in flight and failed sends do not claim delivered alerts', async (t) => {
  t.after(() => guard.stopGuard());
  guard.startGuard({ capture: async () => frame, statFn: () => ({ mean: 100 }), send: async () => {}, intervalMs: 60_000 });
  await turn(); const gate = deferred(); let captures = 0;
  const opts = { capture: () => { captures++; return gate.promise; }, statFn: () => ({ mean: 250 }), send: async () => { throw new Error('offline'); } };
  const one = guard.guardTick(opts), two = guard.guardTick(opts);
  gate.resolve(frame); await Promise.all([one, two]);
  assert.equal(captures, 1); assert.match(guard.guardStatus(), /alerts 0/);
});

test('deep/mirror: off during the first capture must not send a late screenshot or claim ON', async (t) => {
  t.after(() => mirror.stopLive()); const gate = deferred(), sent = [];
  const pending = mirror.startLive({ capture: () => gate.promise, send: async (x) => sent.push(x), maxFrames: 10 });
  mirror.stopLive(); gate.resolve(frame); const reply = await pending;
  assert.equal(sent.length, 0); assert.match(mirror.liveStatus(), /OFF/); assert.doesNotMatch(reply, /mirror ON/);
});

test('deep/mirror: old budget completion cannot stop a new stream', async (t) => {
  t.after(() => mirror.stopLive()); const gate = deferred(), sent = [];
  const old = mirror.startLive({ capture: () => gate.promise, send: async (x) => sent.push(x), maxFrames: 1 });
  mirror.stopLive();
  await mirror.startLive({ capture: async () => frame, send: async (x) => sent.push(x), maxFrames: 5 });
  gate.resolve(frame); await old;
  assert.match(mirror.liveStatus(), /ON/); assert.equal(sent.length, 1);
});

test('deep/mirror: exhausting a one-frame budget reports OFF, not a fictional running stream', async () => {
  mirror.stopLive(); let sent = 0;
  const reply = await mirror.startLive({ capture: async () => frame, send: async () => { sent++; }, maxFrames: 1 });
  assert.equal(sent, 1); assert.match(mirror.liveStatus(), /OFF/); assert.doesNotMatch(reply, /mirror ON/);
});

test('deep/batch: cancellation cannot erase a verified action that finishes despite best-effort abort', async () => {
  const started = deferred(), complete = deferred(), controller = new AbortController();
  const pending = runBatch([{ lane: 'serial', cmd: 'open' }, { lane: 'serial', cmd: 'note' }], { signal: controller.signal,
    run: async () => { started.resolve(); await complete.promise; return { ok: true, text: 'Opened verified fixture' }; } });
  await started.promise; controller.abort(); complete.resolve(); const result = await pending;
  assert.equal(result.stopped, true); assert.equal(result.entries[0].status, 'completed');
  assert.equal(result.entries[1].status, 'skipped'); assert.match(batchSummary(result), /Opened verified fixture/);
});

test('deep/batch: status-reporting errors cannot prevent execution or corrupt verified results', async () => {
  let calls = 0;
  const result = await runBatch([{ lane: 'serial', cmd: 'time' }], { run: async () => { calls++; return { ok: true, text: 'done' }; }, onUpdate() { throw new Error('display offline'); } });
  assert.equal(calls, 1); assert.equal(result.entries[0].status, 'completed');
});

test('deep/batch: invalid lanes fail promptly before any side effect (isolated hang regression)', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { runBatch } from './src/multitask.js';
    let calls=0;
    try { await runBatch([{lane:'invalid',cmd:'x'}], {run:async()=>{calls++;}}); process.exitCode=9; }
    catch { if(calls) process.exitCode=8; else console.log('rejected before work'); }
  `], { cwd: root, encoding: 'utf8', timeout: 2000 });
  assert.equal(child.error, undefined, 'invalid scheduler lane must not spin forever');
  assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /rejected before work/);
});

test('deep/batch: failing pause hook preserves completed work and fails closed before the next task', async () => {
  let calls = 0;
  const result = await runBatch([{ lane: 'serial', cmd: 'open' }, { lane: 'serial', cmd: 'note' }], {
    run: async () => { calls++; return { ok: true, text: 'Verified completed fixture' }; },
    shouldPause() { throw new Error('confirmation service unavailable'); },
  });
  assert.equal(calls, 1); assert.equal(result.halted, 'failure');
  assert.equal(result.entries[0].status, 'completed'); assert.equal(result.entries[1].status, 'skipped');
  assert.match(batchSummary(result), /Verified completed fixture/); assert.match(batchSummary(result), /confirmation service unavailable/);
});

test('deep/mirror: overlapping timer callbacks never start concurrent captures', async (t) => {
  const original = globalThis.setInterval; let tick;
  globalThis.setInterval = (callback) => { tick = callback; return { unref() {} }; };
  t.after(() => { globalThis.setInterval = original; mirror.stopLive(); });
  const gate = deferred(); let captures = 0, sends = 0;
  const pending = mirror.startLive({ capture: () => { captures++; return gate.promise; }, send: async () => { sends++; }, maxFrames: 5 });
  const two = tick(), three = tick(), observed = captures;
  gate.resolve(frame); await Promise.all([pending, two, three]);
  assert.equal(observed, 1); assert.equal(sends, 1);
});
