// Tests for the optional cloud free tiers: Groq and OpenRouter.
//
// No real network: both providers are pointed at a localhost fake that speaks
// the OpenAI REST shape (that is exactly what Groq and OpenRouter expose), so
// chat, tool-capable routing, vision and the failover path are all covered.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildCatalog } from '../src/router.js';
import { createAgentLoop } from '../src/agentloop.js';
import * as ai from '../src/ai.js';
import { Store } from '../src/store.js';

const OWNER = '919528923866';
const AGENT = '918859555795';
const silent = { info() {}, warn() {}, error() {} };

// ── a tiny OpenAI-compatible provider ───────────────────────────────────────

async function fakeProvider(reply = (body) => `ok:${body.model}`, status = 200) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      calls.push({ url: req.url, auth: req.headers.authorization, body });
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end('{"error":{"message":"nope"}}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: reply(body) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function config(overrides = {}) {
  return {
    ownerNumber: OWNER,
    agentNumber: AGENT,
    timezone: 'Asia/Kolkata',
    accessLevel: 'full',
    allowPcControl: false,
    allowShell: false,
    agentTools: true,
    maxAgentSteps: 4,
    aiProvider: 'auto',
    routerPrefer: 'cloud',
    aiTimeoutMs: 4_000,
    ollamaUrl: 'http://127.0.0.1:1',
    ollamaModel: 'llama3.2',
    localApiUrl: '',
    ...overrides,
  };
}

const store = () => new Store({ dir: undefined, memory: true });

// ── defaults in the catalogue ───────────────────────────────────────────────

test('groq: free-tier defaults are current (gpt-oss + qwen vision, not Llama)', () => {
  const catalog = buildCatalog({ groqApiKey: 'k' });
  const groq = catalog.filter((m) => m.provider === 'groq');
  const ids = groq.map((m) => m.model);

  assert.ok(ids.includes('openai/gpt-oss-20b'), 'small brain');
  assert.ok(ids.includes('openai/gpt-oss-120b'), 'big brain');
  assert.ok(ids.includes('qwen/qwen3.8-27b'), 'vision brain');
  // Llama left Groq's free tier on 16 Aug 2026 — a stale default would 404.
  assert.ok(!ids.some((id) => id.includes('llama-3')), 'no dead Llama defaults');

  const vision = groq.find((m) => m.model === 'qwen/qwen3.8-27b');
  assert.equal(vision.vision, true);
  assert.equal(vision.tools, true);
  assert.equal(vision.cost, 1);
});

test('groq: GROQ_VISION_MODEL="" switches vision off', () => {
  const catalog = buildCatalog({ groqApiKey: 'k', groqVisionModel: '' });
  assert.ok(!catalog.some((m) => m.provider === 'groq' && m.vision));
});

test('openrouter: gemma 4 free is the default and it can see images', () => {
  const catalog = buildCatalog({ openrouterApiKey: 'k' });
  const or = catalog.filter((m) => m.provider === 'openrouter');
  assert.equal(or.length, 1);
  assert.equal(or[0].model, 'google/gemma-4-31b-it:free');
  assert.equal(or[0].vision, true);
  assert.equal(or[0].tools, true);
});

test('openrouter: an explicit text model is not marked as vision', () => {
  const catalog = buildCatalog({ openrouterApiKey: 'k', openrouterModel: 'openai/gpt-oss-120b:free' });
  const or = catalog.filter((m) => m.provider === 'openrouter');
  assert.equal(or[0].vision, false);
});

// ── chat through each provider ─────────────────────────────────────────────

test('groq: chat reaches the Groq base URL and returns the answer', async () => {
  const fake = await fakeProvider((body) => `groq says hi (${body.model})`);
  try {
    const cfg = config({ groqApiKey: 'gsk_test', groqBaseUrl: fake.url, aiProvider: 'groq' });
    const out = await ai.chat(cfg, store(), 'hi', silent);

    assert.ok(out, 'got an answer');
    assert.match(out.text, /groq says hi/);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].url, '/v1/chat/completions');
    assert.equal(fake.calls[0].auth, 'Bearer gsk_test');
    // 'hi' is a tiny task → the small model, so the big one is not wasted.
    assert.equal(fake.calls[0].body.model, 'openai/gpt-oss-20b');
  } finally {
    await fake.close();
  }
});

test('openrouter: chat reaches the OpenRouter base URL', async () => {
  const fake = await fakeProvider((body) => `or says hi (${body.model})`);
  try {
    const cfg = config({ openrouterApiKey: 'sk-or-test', openrouterBaseUrl: fake.url, aiProvider: 'openrouter' });
    const out = await ai.chat(cfg, store(), 'explain how TCP handshake works in detail', silent);

    assert.ok(out);
    assert.match(out.text, /or says hi/);
    assert.equal(fake.calls[0].auth, 'Bearer sk-or-test');
    assert.equal(fake.calls[0].body.model, 'google/gemma-4-31b-it:free');
  } finally {
    await fake.close();
  }
});

test('failover: a dead Groq brain falls through to OpenRouter', async () => {
  const dead = await fakeProvider(() => 'never', 500);
  const alive = await fakeProvider(() => 'openrouter saved the day');
  try {
    const cfg = config({
      groqApiKey: 'gsk_dead', groqBaseUrl: dead.url,
      openrouterApiKey: 'sk-or-live', openrouterBaseUrl: alive.url,
    });
    const out = await ai.chat(cfg, store(), 'hi', silent);

    assert.ok(out);
    assert.equal(out.text, 'openrouter saved the day');
    assert.ok(dead.calls.length >= 1, 'Groq was tried and failed');
    assert.equal(alive.calls.length, 1);
  } finally {
    await dead.close();
    await alive.close();
  }
});

// ── vision ─────────────────────────────────────────────────────────────────

test('groq vision: photos go to qwen3.8 as an OpenAI image_url data URL', async () => {
  const fake = await fakeProvider(() => 'ek screenshot jisme Chrome khula hai');
  try {
    const cfg = config({ groqApiKey: 'gsk_test', groqBaseUrl: fake.url, aiProvider: 'groq' });
    const text = await ai.describeImage(cfg, 'aGVsbG8=', 'ye kya hai?', silent);

    assert.equal(text, 'ek screenshot jisme Chrome khula hai');
    const sent = fake.calls[0].body;
    assert.equal(sent.model, 'qwen/qwen3.8-27b');
    const parts = sent.messages[0].content;
    assert.ok(Array.isArray(parts), 'multimodal content array');
    const image = parts.find((p) => p.type === 'image_url');
    assert.ok(image, 'image part present');
    assert.match(image.image_url.url, /^data:image\/png;base64,aGVsbG8=$/);
  } finally {
    await fake.close();
  }
});

test('openrouter vision: gemma 4 gets the image when it is the main model', async () => {
  const fake = await fakeProvider(() => 'a screenshot of a terminal');
  try {
    const cfg = config({ openrouterApiKey: 'sk-or-test', openrouterBaseUrl: fake.url, aiProvider: 'openrouter' });
    const text = await ai.describeImage(cfg, 'aGVsbG8=', '', silent);

    assert.equal(text, 'a screenshot of a terminal');
    const sent = fake.calls[0].body;
    assert.equal(sent.model, 'google/gemma-4-31b-it:free');
    assert.ok(sent.messages[0].content.some((p) => p.type === 'image_url'));
  } finally {
    await fake.close();
  }
});

test('describeImage: no vision brain configured → null, never a made-up description', async () => {
  const cfg = config({ groqApiKey: 'k', groqVisionModel: '', aiProvider: 'groq' });
  assert.equal(await ai.describeImage(cfg, 'aGVsbG8=', '', silent), null);
});

// ── /model status ──────────────────────────────────────────────────────────

test('/model lists the Groq + OpenRouter model IDs and their vision models', async () => {
  const cfg = config({
    aiProvider: 'groq',
    groqApiKey: 'gsk_test',
    groqModel: 'openai/gpt-oss-120b',
    groqModelSmall: 'openai/gpt-oss-20b',
    groqVisionModel: 'qwen/qwen3.8-27b',
    openrouterApiKey: 'sk-or-test',
    openrouterModel: 'google/gemma-4-31b-it:free',
  });
  const text = await ai.aiStatus(cfg);
  assert.match(text, /openai\/gpt-oss-120b/);
  assert.match(text, /qwen\/qwen3\.8-27b/);
  assert.match(text, /google\/gemma-4-31b-it:free/);
});

// ── tool calling through the same OpenAI adapter ───────────────────────────

test('groq: /agent tool calling round-trips through the OpenAI adapter', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push(body);
      const done = body.messages.some((m) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: done
            ? { content: 'Chrome khul gaya ✅' }
            : {
                content: null,
                tool_calls: [{
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'open_app', arguments: '{"app":"chrome"}' },
                }],
              },
        }],
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cloud-test-'));
  try {
    const cfg = config({ groqApiKey: 'gsk_test', groqBaseUrl: `http://127.0.0.1:${port}/v1`, aiProvider: 'groq' });
    const calls = [];
    const loop = createAgentLoop({
      config: cfg,
      store: new Store(path.join(dir, 's.json')),
      actions: {
        level: () => 'full',
        toolSchemas: () => [{
          name: 'open_app',
          description: 'open an app',
          parameters: { type: 'object', properties: { app: { type: 'string' } } },
        }],
        execute: async (name, args) => { calls.push({ name, args }); return { ok: true, text: 'Opened chrome' }; },
      },
      log: silent,
    });

    const reply = await loop.run('chrome kholo', {}, { nudge: true });
    assert.equal(reply, 'Chrome khul gaya ✅');
    assert.deepEqual(calls, [{ name: 'open_app', args: { app: 'chrome' } }]);
    assert.equal(seen[0].model, 'openai/gpt-oss-20b');
    assert.equal(seen[0].tools[0].function.name, 'open_app');
    assert.ok(loop.lastRun.ok);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
