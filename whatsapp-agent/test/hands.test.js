// Tests for the "hands" computer-use loop (src/hands.js).
//
// Everything here is offline: no desktop, no screenshot, no model. The loop is
// driven through its injectable deps so a failing test means the *logic* is
// wrong, not that this machine has no display.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  normalizePoint,
  scalePoint,
  parseHandsAction,
  summarizeAction,
  actionSignature,
  buildHandsPrompt,
  resolveTarget,
  runHands,
  formatHandsReply,
  firstJsonObject,
} from '../src/hands.js';
import { createActions } from '../src/actions.js';
import { createModelRouter } from '../src/router.js';
import { createAgent } from '../src/commands.js';
import { Store } from '../src/store.js';

const silent = { info() {}, warn() {}, error() {} };

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'observer-hands-'));
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

// ── coordinates ─────────────────────────────────────────────────────────────

test('hands: relative coordinates accept 0-1 and 0-1000, reject pixels', () => {
  assert.deepEqual(normalizePoint(0.5, 0.25), { x: 500, y: 250 });
  assert.deepEqual(normalizePoint(500, 250), { x: 500, y: 250 });
  assert.deepEqual(normalizePoint('1000', '1000'), { x: 1000, y: 1000 });
  assert.equal(normalizePoint(1600, 900), null, 'raw pixels are not relative coordinates');
  assert.equal(normalizePoint(-1, 10), null);
  assert.equal(normalizePoint('left', 20), null);
  assert.deepEqual(scalePoint({ x: 500, y: 250 }, { width: 1920, height: 1080 }), { x: 960, y: 270 });
  assert.equal(scalePoint({ x: 500, y: 500 }, { width: 0, height: 0 }), null);
  // Never off the edge of the image, even for a model that says 1000,1000.
  const edge = scalePoint({ x: 1000, y: 1000 }, { width: 1920, height: 1080 });
  assert.deepEqual(edge, { x: 1919, y: 1079 });
});

// ── parsing ─────────────────────────────────────────────────────────────────

test('hands: JSON is found inside fenced blocks and prose', () => {
  assert.equal(firstJsonObject('```json\n{"action":"done"}\n```'), '{"action":"done"}');
  assert.equal(firstJsonObject('Sure! {"a":{"b":1}} hope that helps'), '{"a":{"b":1}}');
  assert.equal(firstJsonObject('no json here'), null);
  assert.equal(firstJsonObject('{"broken": '), null);
});

test('hands: click/type/key/scroll parse into safe actions', () => {
  const click = parseHandsAction('{"action":"click","word":42}');
  assert.equal(click.ok, true);
  assert.deepEqual(click.action, { action: 'click', word: 42 });

  const coords = parseHandsAction('```json\n{"action":"click","target":"Send","x":0.87,"y":0.94}\n```');
  assert.equal(coords.ok, true);
  assert.equal(coords.action.x, 870);
  assert.equal(coords.action.y, 940);
  assert.equal(coords.action.target, 'Send');

  const typed = parseHandsAction('{"action":"type","text":"hello","submit":true}');
  assert.equal(typed.action.text, 'hello');
  assert.equal(typed.action.submit, true);

  const key = parseHandsAction('{"action":"key","keys":"ctrl+l"}');
  assert.equal(key.action.keys, 'ctrl+l');

  const scroll = parseHandsAction('{"action":"scroll","direction":"up","amount":99}');
  assert.equal(scroll.action.direction, 'up');
  assert.equal(scroll.action.amount, 25, 'scroll amount is clamped');

  const drag = parseHandsAction('{"action":"drag","x1":10,"y1":20,"x2":800,"y2":900}');
  assert.deepEqual(drag.action, { action: 'drag', x1: 10, y1: 20, x2: 800, y2: 900 });

  const wait = parseHandsAction('{"action":"wait","ms":999999}');
  assert.equal(wait.action.ms, 10_000);
});

test('hands: nested {"action":{"type":…}} and "type" aliases both work', () => {
  assert.equal(parseHandsAction('{"action":{"type":"click","word":3}}').action.action, 'click');
  assert.equal(parseHandsAction('{"type":"key","keys":"enter"}').action.action, 'key');
});

test('hands: bad or dangerous replies are rejected, never guessed', () => {
  assert.equal(parseHandsAction('{"action":"run_shell","cmd":"rm -rf ~"}').ok, false);
  assert.equal(parseHandsAction('{"action":"click"}').ok, false, 'click without a target');
  assert.equal(parseHandsAction('{"action":"type"}').ok, false, 'type without text');
  assert.equal(parseHandsAction('{"action":"click","x":1600,"y":900}').ok, false, 'pixel coords');
  assert.equal(parseHandsAction('not json').ok, false);
  assert.equal(parseHandsAction('{"action":"done","answer":"ho gaya"}').action.answer, 'ho gaya');
  assert.equal(parseHandsAction('{"action":"fail","reason":"login chahiye"}').action.reason, 'login chahiye');
});

test('hands: summaries and signatures are stable', () => {
  assert.equal(summarizeAction({ action: 'click', word: 7 }), 'click word 7');
  assert.equal(summarizeAction({ action: 'click', target: 'Send', x: 10, y: 20 }), 'click "Send"');
  assert.equal(summarizeAction({ action: 'type', text: 'hi', submit: true }), 'type "hi" + Enter');
  assert.equal(summarizeAction({ action: 'key', keys: 'ctrl+t' }), 'key ctrl+t');
  assert.equal(
    actionSignature({ action: 'click', word: 7 }),
    actionSignature({ action: 'click', word: 7, thought: 'ignored' }),
  );
  assert.notEqual(actionSignature({ action: 'click', word: 7 }), actionSignature({ action: 'click', word: 8 }));
});

// ── prompt ──────────────────────────────────────────────────────────────────

test('hands: the prompt carries the task, word ids, and the budget', () => {
  const prompt = buildHandsPrompt({
    task: 'YouTube kholo aur lofi chalao',
    step: 2,
    maxSteps: 8,
    size: { width: 1000, height: 500 },
    words: [
      { id: 0, text: 'Search', left: 10, top: 10, width: 100, height: 20 },
      { id: 1, text: 'A', left: 5, top: 5, width: 5, height: 5 },
      { id: 2, text: 'Home', left: 400, top: 200, width: 100, height: 40 },
    ],
    history: [{ step: 1, summary: 'click "Search"', detail: '🖱️ clicked', changed: true }],
    lastResult: '🖱️ clicked',
    lastChange: true,
  });
  assert.match(prompt, /TASK: YouTube kholo aur lofi chalao/);
  assert.match(prompt, /STEP: 2 of 8/);
  assert.match(prompt, /SCREEN: 1000x500/);
  assert.match(prompt, /0 \| Search \| 60,40/, 'word id + relative centre');
  assert.match(prompt, /2 \| Home \| 450,440/);
  assert.doesNotMatch(prompt, /\b1 \| A \|/, 'single-letter noise is dropped');
  assert.match(prompt, /HISTORY:/);
  assert.match(prompt, /ONE JSON/);

  const stuckPrompt = buildHandsPrompt({
    task: 'x', step: 3, maxSteps: 8, size: { width: 100, height: 100 }, words: [],
    history: [{ step: 2, summary: 'click word 1', detail: '🖱️ clicked', changed: false }],
    lastResult: '🖱️ clicked', lastChange: false,
  });
  assert.match(stuckPrompt, /screen NOT changed/);
  assert.match(stuckPrompt, /did NOT change/);
  assert.match(stuckPrompt, /OCR found no text/);
});

// ── grounding ───────────────────────────────────────────────────────────────

test('hands: a word id grounds to the exact OCR box', async () => {
  const ctx = {
    size: { width: 1000, height: 500 },
    words: [{ id: 4, text: 'Send', left: 100, top: 50, width: 80, height: 20 }],
    config: {},
    log: silent,
  };
  assert.deepEqual(await resolveTarget({ word: 4 }, ctx), { x: 140, y: 60, how: 'OCR "Send"' });
  const miss = await resolveTarget({ word: 99 }, ctx);
  assert.match(miss.error, /word id 99/);
  const scaled = await resolveTarget({ x: 500, y: 200 }, ctx);
  assert.equal(scaled.how, 'model coordinates');
  assert.deepEqual({ x: scaled.x, y: scaled.y }, { x: 500, y: 100 });
});

// ── the loop ────────────────────────────────────────────────────────────────

function fakeShot(sig = 1) {
  return {
    image: Buffer.from('fake-png'),
    size: { width: 1000, height: 500 },
    words: [{ id: 0, text: 'Search', left: 10, top: 10, width: 60, height: 20 }],
    // Same shape imaging.imageSignature() returns, so change detection is real.
    signature: { cols: 40, rows: 24, samples: Array.from({ length: 40 * 24 }, (_, i) => ((i + sig) % 250)) },
  };
}

test('hands: screenshot → action → done produces an honest success line', async () => {
  const acts = [];
  let step = 0;
  const result = await runHands('YouTube kholo aur lofi chalao', {
    config: makeConfig(tempDir()),
    log: silent,
    deps: {
      observe: async () => { step += 1; return fakeShot(step); },
      think: async (prompt) => {
        if (/STEP: 1 of/.test(prompt)) return { text: '{"action":"click","word":0}', model: 'TestVision', local: false };
        return { text: '{"action":"done","answer":"Lofi chal raha hai"}', model: 'TestVision', local: false };
      },
      act: async (action) => { acts.push(action.action); return { detail: '🖱️ clicked 40,20' }; },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(acts, ['click']);
  assert.match(result.text, /🖐️ \*Hands\* — 1 step/);
  assert.match(result.text, /✅ Lofi chal raha hai/);
  assert.match(result.text, /screen cloud model ko gayi/);
  assert.equal(result.image.length > 0, true);
});

test('hands: an invalid reply is retried once, then reported', async () => {
  let calls = 0;
  const ok = await runHands('do it', {
    config: makeConfig(tempDir()),
    log: silent,
    deps: {
      observe: async () => fakeShot(1),
      think: async () => {
        calls += 1;
        return calls === 1 ? { text: 'I would click the search box' } : { text: '{"action":"done","answer":"ok"}' };
      },
      act: async () => ({ detail: 'noop' }),
    },
  });
  assert.equal(ok.ok, true);
  // 1) garbage → retried once with the parse error, 2) "done" with no action
  // → questioned once, 3) same "done" accepted but labelled honestly.
  assert.equal(calls, 3);
  assert.match(String(ok.answer), /koi action nahi kiya/);

  const bad = await runHands('do it', {
    config: makeConfig(tempDir()),
    log: silent,
    deps: {
      observe: async () => fakeShot(1),
      think: async () => ({ text: 'still not json' }),
      act: async () => ({ detail: 'noop' }),
    },
  });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /valid action nahi diya/);
  assert.match(bad.text, /ruk gaya/);
});

test('hands: an early "done" without any action is questioned, not trusted', async () => {
  let n = 0;
  const acts = [];
  const result = await runHands('YouTube kholo', {
    config: makeConfig(tempDir()),
    log: silent,
    deps: {
      observe: async () => fakeShot(1),
      think: async () => {
        n += 1;
        if (n === 1) return { text: '{"action":"done","answer":"khul gaya"}' };
        if (n === 2) return { text: '{"action":"click","word":0}' };
        return { text: '{"action":"done","answer":"YouTube khul gaya"}' };
      },
      act: async (a) => { acts.push(a.action); return { detail: '🖱️ clicked' }; },
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(acts, ['click'], 'the nudge produced a real action');
  assert.match(result.text, /✅ YouTube khul gaya/);
  assert.doesNotMatch(result.text, /koi action nahi kiya/);
});

test('hands: a model "fail" stops with its own reason, not a fake success', async () => {
  const result = await runHands('login karo', {
    config: makeConfig(tempDir()),
    log: silent,
    deps: {
      observe: async () => fakeShot(1),
      think: async () => ({ text: '{"action":"fail","reason":"password nahi pata"}' }),
      act: async () => ({ detail: 'noop' }),
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /password nahi pata/);
  assert.doesNotMatch(result.text, /✅ Ho gaya/);
});

test('hands: repeating a no-op action three times is called out as stuck', async () => {
  let i = 0;
  const result = await runHands('scroll karo', {
    config: makeConfig(tempDir()),
    log: silent,
    deps: {
      observe: async () => { i += 1; return fakeShot(1); }, // identical every time
      think: async () => ({ text: '{"action":"click","word":0}' }),
      act: async () => ({ detail: '🖱️ clicked' }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 3);
  assert.match(result.reason, /stuck/);
});

test('hands: the step budget is enforced even with a cooperative model', async () => {
  const result = await runHands('never done', {
    config: makeConfig(tempDir(), { handsMaxSteps: 2 }),
    log: silent,
    deps: {
      observe: async () => fakeShot(Math.random() * 1000),
      think: async () => ({ text: '{"action":"wait","ms":100}' }),
      act: async () => ({ detail: '⏳ waited' }),
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 2);
  assert.match(result.reason, /2 steps/);
});

test('hands: a screenshot failure is a real failure with the fix text', async () => {
  const result = await runHands('kuch karo', {
    config: makeConfig(tempDir()),
    log: silent,
    deps: {
      observe: async () => { throw new Error('Wayland: portal did not answer'); },
      think: async () => ({ text: '{"action":"done"}' }),
      act: async () => ({ detail: 'noop' }),
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /screenshot nahi mila: Wayland/);
});

test('hands: the reply never claims success when the run failed', () => {
  const text = formatHandsReply({
    ok: false,
    reason: 'button nahi mila',
    steps: [{ step: 1, ok: false, summary: 'click "Send"', detail: '❌ target nahi mila' }],
    seconds: 12,
    model: 'TestVision',
    cloud: false,
    usage: { maxSteps: 8, visionCalls: 1 },
  });
  assert.match(text, /ruk gaya/);
  assert.match(text, /button nahi mila/);
  assert.doesNotMatch(text, /✅ Ho gaya/);
  assert.match(text, /sab local/);
});

// ── wiring ──────────────────────────────────────────────────────────────────

test('hands: a local vision endpoint works without a separate text server', () => {
  // Regression: LOCAL_API_URL_VISION was only registered inside the
  // LOCAL_API_URL block, so the "hands stay on this PC" setup silently had no
  // vision model and /use failed with "koi vision model jawab nahi de raha".
  const router = createModelRouter({
    config: { localApiUrlVision: 'http://127.0.0.1:9/v1', localModelVision: 'fake-vl', routerPrefer: 'local' },
    log: silent,
  });
  const plan = router.plan({ text: 'look at the screen', needsVision: true, needsTools: false, forceTier: 2 });
  const vision = plan.candidates.filter((m) => m.vision);
  assert.ok(vision.some((m) => m.model === 'fake-vl'), 'local vision model is in the catalog');
  assert.equal(vision.find((m) => m.model === 'fake-vl').local, true);
});

test('hands: computer_use is a real tool the brain can call', () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir);
    const actions = createActions({ config, store: new Store(path.join(dir, 'store.json')), log: silent });
    const tool = actions.toolSchemas().find((t) => t.name === 'computer_use');
    assert.ok(tool, 'computer_use is exposed to the model');
    assert.equal(tool.parameters.required.includes('task'), true);
    assert.match(tool.description, /look at the screenshot/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hands: /agent --use routes straight into the hands loop', async () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir, { aiProvider: 'none' });
    const agent = createAgent({ config, store: new Store(path.join(dir, 'store.json')), log: silent });
    const reply = await agent.handle('/agent --use youtube kholo', {});
    const text = typeof reply === 'string' ? reply : reply?.text ?? '';
    assert.match(text, /Hands/, 'the hands loop ran, not the brain');
    assert.doesNotMatch(text, /Kaam nahi ho paaya/, 'no brain fallback message');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hands: /use shows usage, and is refused in read-only mode', async () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir, { aiProvider: 'none' });
    const agent = createAgent({ config, store: new Store(path.join(dir, 'store.json')), log: silent });
    const usage = await agent.handle('/use', {});
    assert.match(String(usage), /Usage:\* `\/use <task>`/);

    const safeDir = tempDir();
    const safeConfig = makeConfig(safeDir, { accessLevel: 'safe' });
    const safe = createAgent({ config: safeConfig, store: new Store(path.join(safeDir, 'store.json')), log: silent });
    const reply = await safe.handle('/use youtube kholo', {});
    assert.match(String(reply), /ACCESS_LEVEL=standard ya full/);
    fs.rmSync(safeDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
