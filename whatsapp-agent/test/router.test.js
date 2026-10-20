// Tests for 2.1: workload routing (which free model for which job), the
// verified autopilot, and the promise that /agent never claims success when
// nothing actually happened.
//
// Everything is offline: no WhatsApp, no Ollama, no network, no desktop.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import {
  estimateComplexity,
  createModelRouter,
  budgetFor,
  inferQuality,
  looksLikeWebTask,
} from '../src/router.js';
import {
  parseAutoSteps,
  parseSingleStep,
  parseNaturalLanguage,
  buildWebSteps,
  extractPrompt,
  resolveWebUrl,
  executeSteps,
  openVerdict,
} from '../src/autopilot.js';
import { siteFor, autoFocusFor, isComposerLabel, describeSite } from '../src/sites.js';
import { imageSignature, imageSimilarity, screenChanged } from '../src/imaging.js';
import http from 'node:http';

import { createAgent } from '../src/commands.js';
import { createAgentLoop } from '../src/agentloop.js';
import { Store } from '../src/store.js';

const silent = { info() {}, warn() {}, error() {} };

function makeConfig(dir, overrides = {}) {
  return {
    ownerNumber: '919528923866',
    agentNumber: '918859555795',
    timezone: 'Asia/Kolkata',
    dataDir: dir,
    sharedDir: path.join(dir, 'shared'),
    downloadsDir: path.join(dir, 'downloads'),
    qrPngFile: path.join(dir, 'qr.png'),
    accessLevel: 'full',
    allowPcControl: true,
    allowShell: false,
    shellPin: '',
    shellTimeoutMs: 5_000,
    confirmTtlMs: 120_000,
    filesExtraRoots: [],
    aiProvider: 'none',
    ...overrides,
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.homedir(), 'wa-router-test-'));
}

// ── workload classification ─────────────────────────────────────────────────

test('router: a one-liner is tiny, a multi-step job is not', () => {
  assert.equal(estimateComplexity('hi').tier, 'tiny');
  assert.equal(estimateComplexity('chrome kholo').tier, 'tiny');
  assert.equal(estimateComplexity('what is 2+2').tier, 'tiny');
  assert.equal(estimateComplexity('explain how transformers work in detail').tier, 'standard');
  assert.equal(
    estimateComplexity('write a python script to scrape a website and save it to csv then email it').tier,
    'heavy',
  );
  assert.ok(estimateComplexity('hi').reasons.length > 0, 'explains itself');
});

test('router: taking a screenshot does not need a vision model', () => {
  assert.equal(estimateComplexity('screenshot bhej do').needsVision, false);
  // …but describing a photo does, and only when the caller says so.
  assert.equal(estimateComplexity('describe this photo', { needsVision: true }).needsVision, true);
  const router = createModelRouter({
    config: { ollamaModel: 'llama3.2', geminiApiKey: 'k' },
    log: silent,
  });
  const plan = router.plan({ text: 'screenshot bhej do', needsTools: true, needsVision: false });
  assert.ok(plan.candidates.some((m) => !m.vision), 'non-vision brains stay eligible');
});

test('router: budget follows the task size', () => {
  assert.deepEqual(budgetFor(1, { maxAgentSteps: 6, agentToolLimit: 20 }), { maxSteps: 2, toolLimit: 8 });
  assert.deepEqual(budgetFor(2, { maxAgentSteps: 6, agentToolLimit: 20 }), { maxSteps: 3, toolLimit: 12 });
  assert.deepEqual(budgetFor(3, { maxAgentSteps: 6, agentToolLimit: 20 }), { maxSteps: 5, toolLimit: 20 });
  assert.equal(budgetFor(4, { maxAgentSteps: 6 }).maxSteps, 8);
});

test('router: local model inference from the model name', () => {
  assert.equal(inferQuality('llama3.2:1b'), 2);
  assert.equal(inferQuality('llama3.2'), 5); // no size in the name → fallback
  assert.equal(inferQuality('qwen2.5:14b'), 6);
  assert.equal(inferQuality('llama-3.3-70b-versatile'), 8);
});

// ── model choice by workload ────────────────────────────────────────────────

test('router: tiny jobs go to the local fast brain, not the 70B one', () => {
  const router = createModelRouter({
    config: { ollamaModel: 'llama3.2', groqApiKey: 'k', aiProvider: 'auto' },
    log: silent,
  });
  const plan = router.plan({ text: 'hi', needsTools: false });
  assert.equal(plan.tier, 'tiny');
  assert.equal(plan.candidates[0].provider, 'ollama');
  assert.ok(plan.candidates.length > 1, 'still has fallbacks');
});

test('router: standard work uses a capable model — local only if it is strong', () => {
  const job = 'mera download folder saaf karo, phir screenshot bhej';
  const weakLocal = createModelRouter({
    config: { ollamaModel: 'llama3.2', groqApiKey: 'k', aiProvider: 'auto' },
    log: silent,
  });
  assert.equal(weakLocal.plan({ text: job, needsTools: true }).candidates[0].provider, 'groq');

  const strongLocal = createModelRouter({
    config: { ollamaModel: 'qwen2.5:14b', groqApiKey: 'k', aiProvider: 'auto' },
    log: silent,
  });
  assert.equal(strongLocal.plan({ text: job, needsTools: true }).candidates[0].provider, 'ollama');
});

test('router: a failing brain cools down, then comes back after a success', () => {
  const router = createModelRouter({
    config: { ollamaModel: 'llama3.2', groqApiKey: 'k', aiProvider: 'auto', modelCooldownMs: 60_000 },
    log: silent,
  });
  const first = router.plan({ text: 'hi' }).candidates[0];
  router.record(first.id, { ok: false, error: 'connection refused' });
  const afterFail = router.plan({ text: 'hi' });
  assert.ok(!afterFail.candidates.some((m) => m.id === first.id), 'failed brain is skipped');
  assert.ok(afterFail.notes.some((n) => /cooling/.test(n)), 'and says why');

  router.record(first.id, { ok: true });
  assert.ok(router.plan({ text: 'hi' }).candidates.some((m) => m.id === first.id), 'back after success');
});

test('router: heavy calls obey the hourly power budget', () => {
  const router = createModelRouter({
    config: { ollamaModel: 'big-70b', maxHeavyPerHour: 1, heavyWindowMs: 60_000 },
    log: silent,
  });
  const job = 'write a python script to scrape a site then email the csv report';
  const first = router.plan({ text: job });
  assert.equal(first.rank, 4);
  router.record(first.candidates[0].id, { ok: true, tier: 4 });

  const second = router.plan({ text: job });
  assert.equal(second.rank, 3, 'downgraded instead of burning another heavy call');
  assert.ok(second.notes.some((n) => /heavy budget/.test(n)));
});

test('router: AI_PROVIDER=none produces no candidates (offline commands still work)', () => {
  const router = createModelRouter({ config: { aiProvider: 'none', ollamaModel: 'llama3.2' }, log: silent });
  assert.equal(router.plan({ text: 'hi' }).candidates.length, 0);
  assert.equal(router.statusText().includes('Brains'), true);
});

test('router: status text and explain are WhatsApp-ready', () => {
  const router = createModelRouter({
    config: { ollamaModel: 'llama3.2', groqApiKey: 'k', aiProvider: 'auto' },
    log: silent,
  });
  router.noteDecision({ text: 'hi', tier: 'tiny', model: 'ollama:llama3.2' });
  const status = router.statusText();
  assert.match(status, /Brains & routing/);
  assert.match(status, /Power budget/);
  assert.match(status, /Recent routing/);
  const explain = router.explainText('write a python script then email it');
  assert.match(explain, /Work size/);
  assert.match(explain, /Order/);
});

// ── web-task detection + step building ──────────────────────────────────────

test('router: only real "do it on a website" tasks become browser tasks', () => {
  assert.equal(looksLikeWebTask('chatgpt pe rust vs go pooch'), true);
  assert.equal(looksLikeWebTask('chrome kholo aur github pe psd-observer search karo'), true);
  assert.equal(looksLikeWebTask('download folder saaf karo'), false);
  assert.equal(looksLikeWebTask('screenshot bhej do'), false);
});

test('autopilot: pipe steps parse into real operations', () => {
  assert.deepEqual(parseSingleStep('tap battle'), { op: 'tap', label: 'battle' });
  assert.deepEqual(parseSingleStep('click 800 400'), { op: 'click', x: 800, y: 400 });
  assert.deepEqual(parseSingleStep('key ctrl+l'), { op: 'key', combo: 'ctrl+l' });
  assert.deepEqual(parseSingleStep('wait 2'), { op: 'wait', ms: 2000 });
  const steps = parseAutoSteps('open chrome | tap Search | type hello | key enter | screenshot');
  assert.equal(steps.length, 5);
  assert.deepEqual(steps[0], { op: 'open', target: 'chrome' });
  assert.deepEqual(steps[4], { op: 'screenshot' });
});

test('autopilot: natural language splits on then / and / phir', () => {
  const steps = parseNaturalLanguage('open chrome and search for today weather then screenshot');
  assert.equal(steps[0].op, 'open');
  assert.ok(steps.some((s) => s.op === 'type'));
  assert.ok(steps.some((s) => s.op === 'key'));
  assert.equal(steps.at(-1).op, 'screenshot');
});

test('autopilot: prompt extraction keeps the question, drops the plumbing', () => {
  assert.equal(extractPrompt('chatgpt pe rust vs go pooch'), 'rust vs go');
  assert.equal(extractPrompt('google pe aaj ka weather search karo'), 'aaj ka weather');
  assert.equal(extractPrompt('open chatgpt and ask how to use ai'), 'how to use ai');
  assert.equal(resolveWebUrl('chatgpt'), 'https://chatgpt.com');
  assert.equal(resolveWebUrl('nonsense-app'), null);
});

test('autopilot: web task opens the site, then types and reads the answer', () => {
  const steps = buildWebSteps('chatgpt pe rust vs go pooch');
  assert.equal(steps[0].op, 'open');
  assert.equal(steps[0].target, 'https://chatgpt.com');
  const typed = steps.find((s) => s.op === 'type');
  assert.ok(typed, 'types the question');
  assert.match(typed.text, /rust vs go/);
  assert.ok(steps.some((s) => s.op === 'look'), 'reads the answer back');
});

test('autopilot: search sites use a search URL instead of fragile UI typing', () => {
  const steps = buildWebSteps('google pe aaj ka weather search karo');
  assert.match(steps[0].target, /^https:\/\/www\.google\.com\/search\?q=/);
  assert.ok(!steps.some((s) => s.op === 'type'), 'no blind typing needed');
  assert.ok(steps.some((s) => s.op === 'look'));
});

test('sites: chat sites say the composer is already focused', () => {
  assert.equal(autoFocusFor('https://arena.ai/agent'), true);
  assert.equal(autoFocusFor('https://www.arena.ai/agent'), true);
  assert.equal(autoFocusFor('https://chatgpt.com/'), true);
  assert.equal(autoFocusFor('https://example.com'), false);
  assert.equal(siteFor('arena.ai').name, 'Arena');
  assert.match(describeSite('https://arena.ai/agent'), /already focused/i);
  // A "Send" button is never the composer; a "Message" box is.
  assert.equal(isComposerLabel('Message'), true);
  assert.equal(isComposerLabel('Ask anything'), true);
  assert.equal(isComposerLabel('Send'), false);
  assert.equal(isComposerLabel('New chat'), false);
});

test('autopilot: chat site types straight into the focused box (no click, one Enter)', () => {
  const steps = buildWebSteps('arena.ai/agent pe likho hi bro');
  assert.equal(steps[0].op, 'open');
  assert.equal(steps[0].target, 'https://arena.ai/agent');
  assert.ok(!steps.some((s) => s.op === 'tap' || s.op === 'click'), 'no blind clicking');
  const typed = steps.find((s) => s.op === 'type');
  assert.equal(typed.text, 'hi bro');
  assert.equal(typed.submit, true);
  assert.equal(steps.filter((s) => s.op === 'key').length, 0, 'Enter is pressed once, by type.submit');
  assert.ok(steps.some((s) => s.op === 'look'));
});

test('autopilot: a domain mention does not eat the start of the prompt', () => {
  // Regression: "arena.ai/agent pe likho hi bro" used to type ".ai/agent likho hi bro".
  assert.equal(extractPrompt('arena.ai/agent pe likho hi bro'), 'hi bro');
  assert.equal(extractPrompt('claude.ai pe likho: explain kubernetes'), 'explain kubernetes');
  assert.equal(extractPrompt('arena.ai/agent pe hello likho aur bhejo'), 'hello');
  assert.equal(extractPrompt('gemini pe batao quantum computing kya hai'), 'quantum computing kya hai');
});

test('autopilot: an unverifiable open is not reported as a failed page load', () => {
  const win = { ok: false, known: false };

  // Wayland: no window titles, no usable screenshot, but the browser is alive
  // and xdg-open just handed it the URL. That is not a failure.
  const blocked = openVerdict({ windowResult: win, screen: { ok: false, known: false }, browserBefore: true, browserNow: true });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.unverified, true);
  assert.match(blocked.note, /verify possible nahi/i);

  // Browser was not running before and is now → it launched.
  const launched = openVerdict({ windowResult: win, screen: { ok: false, known: false }, browserBefore: false, browserNow: true });
  assert.equal(launched.ok, true);
  assert.equal(launched.unverified, true);

  // The screen changed → the page is up.
  const changed = openVerdict({ windowResult: win, screen: { ok: true, known: true }, browserBefore: true, browserNow: true });
  assert.equal(changed.ok, true);
  assert.equal(changed.unverified, true);

  // A confirmed window still wins outright.
  const titled = openVerdict({ windowResult: { ok: true, title: 'Arena — Firefox' }, screen: null, browserBefore: true, browserNow: true });
  assert.deepEqual(titled, { ok: true, known: true, title: 'Arena — Firefox', waitedMs: 0 });
});

test('autopilot: real evidence of failure still fails the open step', () => {
  const win = { ok: false, known: true };

  // No browser process at all — nothing opened.
  const dead = openVerdict({ windowResult: win, screen: { ok: false, known: true }, browserBefore: false, browserNow: false });
  assert.equal(dead.ok, false);
  assert.equal(dead.known, true);

  // Browser already open, screen readable and unchanged: typing now would land
  // in whatever that window shows, so the step must stop.
  const unchanged = openVerdict({ windowResult: win, screen: { ok: false, known: true }, browserBefore: true, browserNow: true });
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.unchanged, true);
});

// ── verification never lies ─────────────────────────────────────────────────

test('imaging: identical screens are similar, changed screens are not', () => {
  const png = (rgb) => makePng(32, rgb);
  const a = imageSignature(png([10, 10, 10]));
  const b = imageSignature(png([10, 10, 10]));
  const c = imageSignature(png([240, 240, 240]));
  assert.ok(a && b && c);
  assert.equal(imageSimilarity(a, b), 1);
  assert.ok(imageSimilarity(a, c) < 0.2);
  assert.equal(screenChanged(a, b).changed, false);
  assert.equal(screenChanged(a, c).changed, true);
});

test('autopilot: a failed open reports failure, not "done" + screenshot', async () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir);
    const result = await executeSteps(
      [{ op: 'open', target: 'https://chatgpt.com' }],
      { config, log: silent, label: 'Agent' },
    );
    assert.equal(result.ok, false);
    assert.match(result.text, /ruk gaya/i);
    assert.match(result.text, /step 1\/1/);
    assert.doesNotMatch(result.text, /steps, \d+s/, 'no success wording');
    assert.equal(result.steps[0].ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('autopilot: a failed step stops the run (never types into the next one)', async () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir);
    const result = await executeSteps([
      { op: 'open', target: 'https://chatgpt.com' },
      { op: 'type', text: 'should never be typed' },
      { op: 'screenshot' },
    ], { config, log: silent, label: 'Agent' });
    assert.equal(result.ok, false);
    assert.equal(result.failedAt, 1);
    assert.equal(result.steps.length, 1, 'stopped at the failed step');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── /agent itself ───────────────────────────────────────────────────────────

test('/agent: no brain → says nothing was done (no fake success, no screenshot)', async () => {
  const dir = tempDir();
  const store = new Store(path.join(dir, 'store.json'));
  const config = makeConfig(dir, { aiProvider: 'none' });
  const agent = createAgent({ config, store, log: silent });
  try {
    const reply = await agent.handle('/agent download folder saaf karo aur screenshot bhejo', {});
    const text = typeof reply === 'string' ? reply : reply?.text ?? '';
    assert.match(text, /kuch nahi kar sakta|Kaam nahi ho paaya/i);
    assert.equal(typeof reply, 'string', 'no screenshot attached to a failure');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/agent: a dead brain → honest failure, not "done"', async () => {
  const dir = tempDir();
  const store = new Store(path.join(dir, 'store.json'));
  const config = makeConfig(dir, {
    aiProvider: 'ollama',
    ollamaUrl: 'http://127.0.0.1:9', // nothing listens here → instant refusal
    ollamaModel: 'llama3.2',
    agentTools: true,
    maxAgentSteps: 2,
  });
  const agent = createAgent({ config, store, log: silent });
  try {
    const reply = await agent.handle('/agent ~/notes.txt padh ke summary bhejo', {});
    const text = typeof reply === 'string' ? reply : reply?.text ?? '';
    assert.match(text, /Kaam nahi ho paaya|kuch bhi nahi kiya/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/agent --plan shows the route without running anything', async () => {
  const dir = tempDir();
  const store = new Store(path.join(dir, 'store.json'));
  const config = makeConfig(dir, { aiProvider: 'none' });
  const agent = createAgent({ config, store, log: silent });
  try {
    const reply = await agent.handle('/agent --plan write a python script then email it', {});
    const text = typeof reply === 'string' ? reply : reply?.text ?? '';
    assert.match(text, /Plan preview/);
    assert.match(text, /Work size/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/brains works even with no brain configured', async () => {
  const dir = tempDir();
  const store = new Store(path.join(dir, 'store.json'));
  const config = makeConfig(dir, { aiProvider: 'none' });
  const agent = createAgent({ config, store, log: silent });
  try {
    const reply = await agent.handle('/brains', {});
    assert.match(String(reply), /Brains/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── "claims done without doing anything" guard ──────────────────────────────

test('agentloop: a model that says "ho gaya" without a tool gets corrected', async () => {
  // First reply: pure text claiming success, no tool call. The loop must not
  // accept it — it nudges once, and only then does the model call the tool.
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      const hasToolResult = (body.messages ?? []).some((m) => m.role === 'tool');
      if (requests.length === 1) {
        return res.end(JSON.stringify({ message: { role: 'assistant', content: 'Ho gaya bhai ✅' } }));
      }
      if (!hasToolResult) {
        return res.end(JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'open_app', arguments: '{"app":"chrome"}' } }],
          },
        }));
      }
      return res.end(JSON.stringify({ message: { role: 'assistant', content: 'Chrome khul gaya ✅' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = tempDir();
  const calls = [];
  try {
    const config = makeConfig(dir, {
      aiProvider: 'ollama',
      ollamaUrl: `http://127.0.0.1:${port}`,
      ollamaModel: 'llama3.2',
      agentTools: true,
      maxAgentSteps: 2,
      aiTimeoutMs: 10_000,
    });
    const loop = createAgentLoop({
      config,
      store: new Store(path.join(dir, 's.json')),
      actions: {
        level: () => 'full',
        toolSchemas: () => [{ name: 'open_app', description: 'open an app', parameters: { type: 'object', properties: { app: { type: 'string' } } } }],
        execute: async (name, args) => { calls.push({ name, args }); return { ok: true, text: 'Opened chrome' }; },
      },
      log: silent,
    });
    const reply = await loop.run('chrome kholo', {}, { nudge: true });
    assert.equal(reply, 'Chrome khul gaya ✅');
    assert.deepEqual(calls, [{ name: 'open_app', args: { app: 'chrome' } }]);
    assert.equal(requests.length, 3, 'claimed-done reply was not accepted on its own');
    assert.ok(requests[1].messages.some((m) => m.role === 'user' && /did not call any tool/i.test(m.content)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agentloop: a model that keeps claiming success with 0 tools is not believed', async () => {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'Ho gaya bhai ✅ chrome khul gaya' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = tempDir();
  try {
    const config = makeConfig(dir, {
      aiProvider: 'ollama',
      ollamaUrl: `http://127.0.0.1:${port}`,
      ollamaModel: 'llama3.2',
      agentTools: true,
      maxAgentSteps: 4,
      aiTimeoutMs: 10_000,
    });
    const loop = createAgentLoop({
      config,
      store: new Store(path.join(dir, 's.json')),
      actions: {
        level: () => 'full',
        toolSchemas: () => [{ name: 'open_app', description: 'open an app', parameters: { type: 'object', properties: { app: { type: 'string' } } } }],
        execute: async () => ({ ok: true, text: 'Opened chrome' }),
      },
      log: silent,
    });
    const reply = await loop.run('chrome kholo', {}, { nudge: true });
    assert.match(String(reply), /Kuch nahi hua/);
    assert.match(String(reply), /sach nahi maanta/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

function makePng(size, rgb) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      raw[offset++] = rgb[0];
      raw[offset++] = rgb[1];
      raw[offset++] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let table = null;
function crc32(buf) {
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}
