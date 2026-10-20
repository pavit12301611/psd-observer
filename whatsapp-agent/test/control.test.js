// Tests for the three 2.7 features that touch the whole app:
//   • /stop      — cancel running work, even stacked, mid-loop
//   • update     — one "updated!" message with what changed + how long
//   • vision     — screen control reads the screenshot, not an OCR table
//
// Offline: no desktop, no WhatsApp, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createTaskRegistry,
  isStopCommand,
  sleepWith,
  StoppedError,
  isStoppedError,
} from '../src/cancel.js';
import {
  humanSeconds,
  bulletsFromBuildLog,
  changesFor,
  buildUpdateMessage,
  announceUpdate,
  readUpdateMarker,
  clearUpdateMarker,
  brainSummary,
} from '../src/updates.js';
import { executeSteps } from '../src/autopilot.js';
import { runHands, buildHandsPrompt, resolveTarget } from '../src/hands.js';
import { createAgent } from '../src/commands.js';
import { Store } from '../src/store.js';

const silent = { info() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'observer-control-'));
}

function makeConfig(dir, overrides = {}) {
  return {
    ownerNumber: '919528923866',
    agentNumber: '918859555795',
    timezone: 'Asia/Kolkata',
    accessLevel: 'full',
    confirmTtlMs: 120_000,
    aiProvider: 'none',
    handsStepDelayMs: 200,
    dataDir: dir,
    storeFile: path.join(dir, 'store.json'),
    downloadsDir: path.join(dir, 'downloads'),
    sharedDir: path.join(dir, 'shared'),
    ...overrides,
  };
}

// ── the registry ────────────────────────────────────────────────────────────

test('cancel: begin / stopAll aborts every live task and reports it', () => {
  const registry = createTaskRegistry({ now: () => 1_000 });
  const a = registry.begin('Arena', { detail: 'arena.ai/agent' });
  const b = registry.begin('Hands');
  assert.equal(registry.size, 2);
  assert.equal(a.signal.aborted, false);

  const stopped = registry.stopAll();
  assert.equal(stopped.length, 2);
  assert.deepEqual(stopped.map((t) => t.label).sort(), ['Arena', 'Hands']);
  assert.equal(a.signal.aborted, true);
  assert.equal(b.signal.aborted, true);

  a.end();
  b.end();
  assert.equal(registry.size, 0);
  assert.deepEqual(registry.stopAll(), [], 'nothing left to stop');
});

test('cancel: run() always unregisters, even when the task throws', async () => {
  const registry = createTaskRegistry();
  await assert.rejects(
    registry.run('Boom', async () => { throw new Error('kaboom'); }),
    /kaboom/,
  );
  assert.equal(registry.size, 0);

  const value = await registry.run('Ok', async (signal) => {
    assert.equal(signal.aborted, false);
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(registry.size, 0);
});

test('cancel: stop(id) targets one task only', () => {
  const registry = createTaskRegistry();
  const first = registry.begin('First');
  const second = registry.begin('Second');
  const stopped = registry.stop(first.id);
  assert.equal(stopped.label, 'First');
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.equal(registry.stop(999), null);
});

test('cancel: sleepWith rejects immediately when stopped', async () => {
  const registry = createTaskRegistry();
  const task = registry.begin('Sleepy');
  const started = Date.now();
  const sleep = sleepWith(10_000, task.signal, 'Sleepy');
  setTimeout(() => registry.stopAll(), 30);
  await assert.rejects(sleep, (err) => isStoppedError(err));
  assert.ok(Date.now() - started < 2_000, 'did not wait the full 10s');
  assert.equal(new StoppedError('X').code, 'ESTOPPED');
});

test('cancel: isStopCommand accepts the stop words and nothing else', () => {
  for (const text of ['/stop', '/STOP', '/stop all', '/ruko', '/cancel', '/abort', ' /stop ']) {
    assert.equal(isStopCommand(text), true, text);
  }
  for (const text of ['stop', 'please stop the music', '/stopper', '/status']) {
    assert.equal(isStopCommand(text), false, text);
  }
});

// ── /stop in the agent ──────────────────────────────────────────────────────

test('/stop: says nothing is running when there is nothing', async () => {
  const dir = tempDir();
  try {
    const registry = createTaskRegistry();
    const agent = createAgent({
      config: makeConfig(dir),
      store: new Store(path.join(dir, 'store.json')),
      log: silent,
      taskRegistry: registry,
    });
    const reply = await agent.handle('/stop', {});
    assert.match(String(reply), /koi task nahi chal raha/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/stop: aborts a live task and names it with the elapsed time', async () => {
  const dir = tempDir();
  try {
    const registry = createTaskRegistry();
    const agent = createAgent({
      config: makeConfig(dir),
      store: new Store(path.join(dir, 'store.json')),
      log: silent,
      taskRegistry: registry,
    });
    const task = registry.begin('Arena', { detail: 'arena.ai/agent pe hi bro' });
    const reply = String(await agent.handle('/stop', {}));
    assert.match(reply, /Roka gaya/);
    assert.match(reply, /Arena/);
    assert.match(reply, /arena\.ai\/agent/);
    assert.equal(task.signal.aborted, true);
    task.end();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/stop: works twice in a row (no 4s dedup window blocking it)', async () => {
  const dir = tempDir();
  try {
    const registry = createTaskRegistry();
    const agent = createAgent({
      config: makeConfig(dir),
      store: new Store(path.join(dir, 'store.json')),
      log: silent,
      taskRegistry: registry,
    });
    assert.match(String(await agent.handle('/stop', {})), /koi task nahi/i);
    assert.match(String(await agent.handle('/stop', {})), /koi task nahi/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/stop in a stacked message wins and skips the other lines', async () => {
  const dir = tempDir();
  try {
    const registry = createTaskRegistry();
    const agent = createAgent({
      config: makeConfig(dir),
      store: new Store(path.join(dir, 'store.json')),
      log: silent,
      taskRegistry: registry,
    });
    const reply = String(await agent.handle('/arena hi bro\n/stop', {}));
    assert.match(reply, /koi task nahi|Roka gaya/);
    assert.match(reply, /Stack me \/stop tha/);
    assert.doesNotMatch(reply, /opens|https:\/\/arena/i, 'the arena task never started');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/stop: a stopped command sends nothing (only /stop replies)', async () => {
  const dir = tempDir();
  try {
    const registry = createTaskRegistry();
    const agent = createAgent({
      config: makeConfig(dir),
      store: new Store(path.join(dir, 'store.json')),
      log: silent,
      taskRegistry: registry,
    });
    // Make the download hang until /stop aborts it — exactly what a 900 MB
    // file does in real life. (Patching the registry entry keeps this offline
    // and deterministic; the real download_url honours ctx.signal too.)
    const entry = agent.actions.registry.find((e) => e.name === 'download_url');
    const original = entry.run;
    entry.run = (args, ctx) => new Promise((resolve, reject) => {
      if (!ctx?.signal) return reject(new Error('no signal passed to the action'));
      ctx.signal.addEventListener('abort', () => reject(new Error('aborted by /stop')), { once: true });
    });
    try {
      const running = agent.handle('/download https://example.com/big.iso', {});
      await new Promise((r) => setTimeout(r, 20));
      const stopReply = String(await agent.handle('/stop', {}));
      assert.match(stopReply, /Roka gaya/);
      assert.match(stopReply, /Download/);
      const reply = await running;
      assert.equal(reply, null, 'the cancelled command stays silent');
    } finally {
      entry.run = original;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── cancellation inside the loops ──────────────────────────────────────────

test('autopilot: an aborted run stops before touching the desktop', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeSteps(
    [{ op: 'open', target: 'https://chatgpt.com' }, { op: 'type', text: 'hi' }],
    { config: {}, log: silent, label: 'Arena', signal: controller.signal },
  );
  assert.equal(result.ok, false);
  assert.equal(result.stopped, true);
  assert.match(result.text, /\/stop se roka gaya/);
  assert.equal(result.steps.length, 0, 'nothing ran');
});

test('hands: /stop mid-loop keeps the steps done so far and stops', async () => {
  const controller = new AbortController();
  const shot = {
    image: Buffer.from('png'),
    size: { width: 1000, height: 600 },
    words: [],
    signature: { cols: 40, rows: 24, samples: Array.from({ length: 960 }, (_, i) => i % 250) },
  };
  const result = await runHands('kuch karo', {
    config: makeConfig(tempDir(), { handsStepDelayMs: 200 }),
    log: silent,
    signal: controller.signal,
    onStep: () => controller.abort(),
    deps: {
      observe: async () => shot,
      think: async () => ({ text: '{"action":"click","x":100,"y":200}', model: 'FakeVision', local: true }),
      act: async () => ({ detail: '🖱️ clicked' }),
    },
  });
  assert.equal(result.stopped, true);
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 1, 'stopped after the step that was already running');
  assert.match(result.text, /\/stop se roka gaya/);
  assert.match(result.text, /Aage kuch nahi kiya/);
});

// ── vision-first prompt + grounding ────────────────────────────────────────

test('hands: the prompt asks the model to read the screenshot (vision, not OCR)', () => {
  const prompt = buildHandsPrompt({
    task: 'YouTube kholo',
    step: 1,
    maxSteps: 8,
    size: { width: 1920, height: 1080 },
    words: [],
    history: [],
    visionFirst: true,
  });
  assert.match(prompt, /Look at the screenshot yourself/);
  assert.doesNotMatch(prompt, /TEXT LIST \(id/);
  assert.match(prompt, /TEXT LIST: \(OCR found no text/);
  assert.match(prompt, /0=left\/top, 500=middle, 1000=right\/bottom/);
});

test('hands: a named target with coordinates never needs OCR', async () => {
  const hit = await resolveTarget(
    { action: 'click', target: 'Search', x: 500, y: 100 },
    { size: { width: 1000, height: 500 }, words: [], config: {}, log: silent },
  );
  assert.deepEqual({ x: hit.x, y: hit.y }, { x: 500, y: 50 });
  assert.equal(hit.how, 'vision (Search)');
});

// ── update announcement ────────────────────────────────────────────────────

test('updates: humanSeconds formats short and long durations', () => {
  assert.equal(humanSeconds(8), '8s');
  assert.equal(humanSeconds(42), '42s');
  assert.equal(humanSeconds(102), '1m 42s');
  assert.equal(humanSeconds(120), '2m');
  assert.equal(humanSeconds(3_900), '1h 5m');
});

test('updates: release notes exist for the current version', () => {
  const changes = changesFor('2.7.0');
  assert.ok(changes.length >= 3, '2.7.0 has bullets');
  assert.ok(changes.some((c) => /\/stop/.test(c)), 'mentions /stop');
});

test('updates: falls back to BUILD-LOG when there is no note entry', () => {
  const bullets = bulletsFromBuildLog('2.6.0');
  assert.ok(bullets.length > 0, 'read the 2.6.0 section');
  assert.ok(bullets.join(' ').toLowerCase().includes('hand'), 'section content came through');
  assert.deepEqual(bulletsFromBuildLog('0.0.0-nope'), []);
});

test('updates: the message says from → to, time taken and what changed', () => {
  const text = buildUpdateMessage({
    from: '2.6.0',
    to: '2.7.0',
    seconds: 102,
    changes: ['/stop — chalta hua kaam rukta hai', 'screen vision'],
    brains: { text: '🧠 Brains: 5 (2 local, 2 vision)' },
  });
  assert.match(text, /2\.6\.0 → 2\.7\.0 · 1m 42s/);
  assert.match(text, /\/stop — chalta hua kaam rukta hai/);
  assert.match(text, /Brains: 5/);
});

test('updates: first run is silent, a version change sends exactly once', async () => {
  const dir = tempDir();
  try {
    const store = new Store(path.join(dir, 'store.json'));
    const sent = [];
    const send = async (text) => { sent.push(text); };

    const first = await announceUpdate({ config: { dataDir: dir }, store, log: silent, send, version: '2.6.0', notes: {} });
    assert.equal(first.sent, false);
    assert.equal(first.reason, 'first run');
    assert.equal(store.data.lastVersion, '2.6.0');

    // observer.sh writes this before restarting the agent.
    fs.writeFileSync(path.join(dir, 'last-update.json'), JSON.stringify({
      from: '2.6.0', to: '2.7.0', seconds: 42, at: new Date().toISOString(), via: 'observer.sh',
    }));

    const second = await announceUpdate({
      config: { dataDir: dir }, store, log: silent, send, version: '2.7.0',
      marker: readUpdateMarker(dir),
    });
    assert.equal(second.sent, true);
    assert.equal(second.reason, 'version');
    assert.equal(sent.length, 1);
    assert.match(sent[0], /2\.6\.0 → 2\.7\.0 · 42s/);
    assert.match(sent[0], /\/stop/);
    assert.equal(fs.existsSync(path.join(dir, 'last-update.json')), false, 'marker consumed');

    const third = await announceUpdate({ config: { dataDir: dir }, store, log: silent, send, version: '2.7.0' });
    assert.equal(third.sent, false);
    assert.equal(sent.length, 1, 'no repeat on reconnect');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updates: a changed brain list is announced too (AI updated)', async () => {
  const dir = tempDir();
  try {
    const store = new Store(path.join(dir, 'store.json'));
    store.data.lastVersion = '2.7.0';
    store.data.lastBrainIds = ['ollama:llama3.2'];
    store.save();
    const sent = [];
    const result = await announceUpdate({
      config: { dataDir: dir }, store, log: silent, version: '2.7.0',
      send: async (text) => { sent.push(text); },
      brains: { ids: ['ollama:llama3.2', 'gemini:gemini-3.8-flash'] },
    });
    assert.equal(result.sent, true);
    assert.equal(result.reason, 'brains');
    assert.match(sent[0], /Brains:/);
    assert.match(sent[0], /\+1 naya/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updates: a missing marker still sends (manual update), without a time', async () => {
  const dir = tempDir();
  try {
    const store = new Store(path.join(dir, 'store.json'));
    store.data.lastVersion = '2.5.4';
    store.save();
    const sent = [];
    const result = await announceUpdate({
      config: { dataDir: dir }, store, log: silent, version: '2.7.0',
      send: async (text) => { sent.push(text); }, notes: {},
    });
    assert.equal(result.sent, true);
    assert.match(sent[0], /2\.5\.4 → 2\.7\.0/);
    assert.doesNotMatch(sent[0], /· \d+s\b/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updates: clearUpdateMarker never throws on a missing file', () => {
  assert.doesNotThrow(() => clearUpdateMarker(tempDir()));
  assert.doesNotThrow(() => clearUpdateMarker(null));
});

test('updates: brainSummary counts local and vision models', () => {
  const summary = brainSummary([
    { id: 'ollama:llama3.2', local: true, vision: false },
    { id: 'gemini:flash', local: false, vision: true },
  ]);
  assert.deepEqual(summary.ids, ['ollama:llama3.2', 'gemini:flash']);
  assert.match(summary.text, /2 \(1 local, 1 vision\)/);
});
