// Tests for running the agent on Hugging Face GGUFs through a local
// OpenAI-compatible server (llama.cpp's llama-server, LM Studio, vLLM).
//
// No Hugging Face, no model, no network beyond a localhost fixture: a fake
// llama-server on 127.0.0.1 proves the whole path — routing, tool calls,
// chat and vision — works with zero cloud.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createModelRouter, buildCatalog } from '../src/router.js';
import { createAgentLoop } from '../src/agentloop.js';
import { createAgent } from '../src/commands.js';
import * as ai from '../src/ai.js';
import { Store } from '../src/store.js';

const OWNER = '919528923866';
const AGENT = '918859555795';
const silent = { info() {}, warn() {}, error() {} };

const TEMP = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'wa-local-test-'));
  TEMP.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of TEMP) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function localConfig(dir, overrides = {}) {
  return {
    ownerNumber: OWNER,
    agentNumber: AGENT,
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
    // Everything local: llama.cpp on :8080, no cloud keys at all.
    aiProvider: 'local',
    ollamaUrl: 'http://127.0.0.1:11434',
    ollamaModel: 'llama3.2',
    localApiUrl: 'http://127.0.0.1:8080/v1',
    localModel: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
    localApiKey: 'local',
    agentTools: true,
    maxAgentSteps: 4,
    routerPrefer: 'local',
    aiTimeoutMs: 10_000,
    ...overrides,
  };
}

// ── catalogue from LOCAL_* settings ─────────────────────────────────────────

test('local: llama.cpp models enter the catalogue as free, private brains', () => {
  const catalog = buildCatalog({
    localApiUrl: 'http://127.0.0.1:8080/v1',
    localModel: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
    localApiUrlSmall: 'http://127.0.0.1:8081/v1',
    localModelSmall: 'unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M',
    localApiUrlVision: 'http://127.0.0.1:8080/v1',
    localModelVision: 'ggml-org/gemma-4-12B-it-GGUF:Q4_K_M',
  });
  const llama = catalog.filter((m) => m.provider === 'local');
  assert.equal(llama.length, 3);
  assert.ok(llama.every((m) => m.local && m.cost === 0));
  assert.ok(llama.every((m) => m.baseUrl.startsWith('http://127.0.0.1:808')));

  const small = llama.find((m) => m.model.includes('0.8B'));
  const main = llama.find((m) => m.model.includes('27B'));
  const vision = llama.find((m) => m.vision);
  assert.deepEqual([small.minTier, small.maxTier], [1, 2], 'tiny jobs → the 0.8B');
  assert.deepEqual([main.minTier, main.maxTier], [2, 4], 'real work → the 27B');
  assert.ok(vision && !vision.tools, 'vision model is chat-only for images');
  assert.ok(main.quality > small.quality);
});

test('local: AI_PROVIDER=local never falls back to a cloud brain', () => {
  const router = createModelRouter({
    config: {
      aiProvider: 'local',
      localApiUrl: 'http://127.0.0.1:8080/v1',
      localModel: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
      ollamaModel: 'llama3.2',
      groqApiKey: 'k',
      geminiApiKey: 'k',
      openrouterApiKey: 'k',
    },
    log: silent,
  });
  for (const text of ['hi', 'folder saaf karo phir screenshot bhej', 'write a python script then email it']) {
    const plan = router.plan({ text, needsTools: true });
    assert.ok(plan.candidates.length > 0, `${text} has a brain`);
    assert.ok(plan.candidates.every((m) => m.local), `${text} stays local`);
  }
});

test('local: the router sends tiny jobs to the small local model', () => {
  const router = createModelRouter({
    config: {
      aiProvider: 'local',
      localApiUrl: 'http://127.0.0.1:8080/v1',
      localModel: 'unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL',
      localApiUrlSmall: 'http://127.0.0.1:8081/v1',
      localModelSmall: 'unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M',
    },
    log: silent,
  });
  const tiny = router.plan({ text: 'hi', needsTools: false });
  assert.match(tiny.candidates[0].model, /0\.8B/);
  const standard = router.plan({ text: 'download folder saaf karo, phir screenshot bhej', needsTools: true });
  assert.match(standard.candidates[0].model, /27B/);
});

test('local: /brains labels llama.cpp and its port', () => {
  const router = createModelRouter({
    config: { aiProvider: 'local', localApiUrl: 'http://127.0.0.1:8080/v1', localModel: 'ggml-org/gemma-4-12B-it-GGUF:Q4_K_M' },
    log: silent,
  });
  const text = router.statusText();
  assert.match(text, /Local · ggml-org\/gemma-4-12B/);
  assert.match(text, /llama\.cpp/);
  assert.match(text, /8080/);
});

// ── a fake llama-server on localhost ────────────────────────────────────────

/**
 * Mimics llama-server's OpenAI API. `mode` decides what it answers:
 *   tools   → first call asks for open_app, then reports the result
 *   chat    → plain answer
 *   vision  → answers about the attached image
 */
function fakeLlamaServer(mode = 'tools') {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });

      if (req.url === '/v1/models') {
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'local-model' }] }));
      }
      if (mode === 'vision') {
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Screen pe VS Code khula hai, ek error dikh raha hai.' } }],
        }));
      }
      if (mode === 'chat') {
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Namaste! Main tumhare PC pe hi chal raha hoon.' } }],
        }));
      }
      const usedTool = (body.messages ?? []).some((m) => m.role === 'tool');
      if (!usedTool) {
        return res.end(JSON.stringify({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'open_app', arguments: '{"app":"chrome"}' },
              }],
            },
          }],
        }));
      }
      return res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Chrome khul gaya ✅' } }],
      }));
    });
  });
  return { server, requests };
}

async function withServer(mode, fn) {
  const { server, requests } = fakeLlamaServer(mode);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn({ port, requests });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('local: tool calling works against a llama.cpp-shaped server', async () => {
  const dir = tempDir();
  try {
    await withServer('tools', async ({ port, requests }) => {
      const config = localConfig(dir, { localApiUrl: `http://127.0.0.1:${port}/v1` });
      const calls = [];
      const loop = createAgentLoop({
        config,
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
      assert.equal(requests[0].url, '/v1/chat/completions');
      assert.equal(requests[0].body.model, config.localModel);
      assert.ok(Array.isArray(requests[0].body.tools) && requests[0].body.tools.length === 1);
      assert.ok(loop.lastRun.ok);
      assert.equal(loop.lastRun.tier, 'tiny');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local: plain chat goes through the local server', async () => {
  const dir = tempDir();
  try {
    await withServer('chat', async ({ port, requests }) => {
      const config = localConfig(dir, { localApiUrl: `http://127.0.0.1:${port}/v1` });
      const store = new Store(path.join(dir, 'c.json'));
      const result = await ai.chat(config, store, 'namaste', silent);
      assert.match(result.text, /Namaste/);
      assert.equal(result.provider.includes('Local'), true);
      assert.equal(requests[0].url, '/v1/chat/completions');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local: a photo is described by the local vision model (stays on the PC)', async () => {
  const dir = tempDir();
  try {
    await withServer('vision', async ({ port, requests }) => {
      const config = localConfig(dir, {
        localApiUrl: `http://127.0.0.1:${port}/v1`,
        localApiUrlVision: `http://127.0.0.1:${port}/v1`,
        localModelVision: 'ggml-org/gemma-4-12B-it-GGUF:Q4_K_M',
      });
      const base64 = Buffer.from('not-a-real-png').toString('base64');
      const text = await ai.describeImage(config, base64, 'screen pe kya hai?', silent);
      assert.match(text, /VS Code/);
      const body = requests[0].body;
      const content = body.messages[0].content;
      assert.ok(Array.isArray(content), 'vision request uses content parts');
      assert.equal(content[1].type, 'image_url');
      assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── the agent as the owner sees it ──────────────────────────────────────────

test('local: /agent works end-to-end with no cloud at all', async () => {
  const dir = tempDir();
  try {
    await withServer('tools', async ({ port }) => {
      const store = new Store(path.join(dir, 'store.json'));
      const config = localConfig(dir, { localApiUrl: `http://127.0.0.1:${port}/v1` });
      const agent = createAgent({ config, store, log: silent });
      const reply = await agent.handle('/agent chrome kholo', {});
      const text = typeof reply === 'string' ? reply : reply?.text ?? '';
      assert.match(text, /Chrome khul gaya/);
      assert.match(text, /🧠 tiny/, 'proves which brain ran');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('local: a dead llama-server is reported honestly, not as success', async () => {
  const dir = tempDir();
  try {
    const store = new Store(path.join(dir, 'store.json'));
    const config = localConfig(dir, { localApiUrl: 'http://127.0.0.1:9/v1' });
    const agent = createAgent({ config, store, log: silent });
    const reply = await agent.handle('/agent chrome kholo', {});
    const text = typeof reply === 'string' ? reply : reply?.text ?? '';
    assert.match(text, /Kaam nahi ho paaya|kuch bhi nahi kiya/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
