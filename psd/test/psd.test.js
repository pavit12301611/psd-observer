// test/psd.test.js — the contract of the whole system, without a desktop.
//   node --test test/

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseIntent, quickReply, keywordTool } from '../src/intents.js';
import { createTools, parseWhen, humanBytes } from '../src/tools.js';
import { Memory } from '../src/memory.js';
import { normalizeToolCall, pickModel } from '../src/engine.js';
import { parseFrontmatter, createAgentLibrary } from '../src/agents.js';
import { createRouter } from '../src/router.js';
import { createNotch } from '../src/notch.js';
import { startFakeBrain } from './fake-brain.mjs';

const tmpConfig = (extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psd-test-'));
  return {
    dataDir: dir, memoryFile: path.join(dir, 'memory.json'), runFile: path.join(dir, 'runs.jsonl'),
    agentDir: path.resolve('agents'), access: 'standard', shell: false, shellPin: '',
    allowRoots: [], confirmTtlMs: 60_000, toolTimeoutMs: 8000, maxHistory: 24, skills: true,
    agent: 'psd', hostname: 'testhost', platform: 'Linux', version: 'test', port: 0,
    notchBus: 'off', notchPath: '/x', whatsappUrl: 'http://127.0.0.1:1', whatsappToken: '', whatsappBridge: false,
    temperature: 0.2, maxSteps: 3, requestTimeoutMs: 5000,
    ...extra,
  };
};

// ── intents ────────────────────────────────────────────────────────────────
test('intents map plain language to one tool call', () => {
  const cases = [
    ['system status', 'system_status'],
    ['what is my battery', 'system_status'],
    ['disk space', 'disk_space'],
    ['open chrome', 'open_app'],
    ['chrome kholo', 'open_app'],
    ['screenshot', 'screenshot'],
    ['volume up', 'volume'],
    ['mute', 'volume'],
    ['wifi off', 'wifi'],
    ['wifi band karo', 'wifi'],
    ['bluetooth on', 'bluetooth'],
    ['dark mode on', 'dark_mode'],
    ['do not disturb on', 'do_not_disturb'],
    ['night light off', 'night_light'],
    ['next', 'media_control'],
    ['list my apps', 'list_apps'],
    ['what windows are open', 'list_windows'],
    ['search quantum error correction', 'web_search'],
    ['remember: my city is Dehradun', 'remember'],
    ['remind me in 25m to stretch', 'remind'],
    ['notch: build finished', 'notch_show'],
  ];
  for (const [input, tool] of cases) {
    assert.equal(parseIntent(input)?.tool, tool, `"${input}" should map to ${tool}`);
  }
});

test('intents never fire on questions or compound sentences', () => {
  assert.equal(parseIntent('what is wifi?')?.tool, undefined);
  assert.equal(parseIntent('how do I open a file in vim?'), null);
  assert.equal(parseIntent('wifi off karo aur phir chrome kholo')?.tool, undefined);
  assert.equal(parseIntent('open chrome and then open code')?.tool, undefined);
  assert.equal(parseIntent('open source kya hai?'), null);
});

test('quick replies answer without a model', () => {
  assert.match(quickReply('hello'), /PSD online/);
  assert.match(quickReply('who are you?'), /personal agent/);
  assert.match(quickReply('help'), /no model needed/);
  assert.equal(quickReply('compile the kernel'), null);
});

test('keyword fallback finds something when there is no brain', () => {
  const tools = { byName: new Map([['disk_space', {}], ['system_status', {}]]) };
  assert.equal(keywordTool('how much storage is left', tools)?.tool, 'disk_space');
  assert.equal(keywordTool('how much Storage is left', tools)?.tool, 'disk_space');
  assert.equal(keywordTool('tell me a joke', tools), null);
});

// ── tools + permissions ────────────────────────────────────────────────────
test('permission levels gate what can actually run', async () => {
  const memory = new Memory(tmpConfig());
  const notch = createNotch(tmpConfig());
  const make = (access) => createTools({ config: tmpConfig({ access }), memory, notch, whatsapp: { send: async () => ({ ok: true }) } });
  const safe = make('safe');
  const full = make('full');

  const refused = await safe.execute('power', { action: 'reboot' });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /PSD_ACCESS=full/);

  // The advertised list stays complete (a hidden tool makes models invent one),
  // but shell only exists once the owner turns it on.
  assert.ok(full.schemas().some((s) => s.function.name === 'power'));
  assert.equal(full.schemas().find((s) => s.function.name === 'shell'), undefined);
  assert.equal(make('full').schemas().find((s) => s.function.name === 'open_app').function.description.includes('PSD_ACCESS'), false);
});

test('destructive tools park instead of running', async () => {
  const config = tmpConfig({ access: 'full' });
  const memory = new Memory(config);
  const tools = createTools({ config, memory, notch: createNotch(config), whatsapp: { send: async () => ({ ok: true }) } });
  const parked = await tools.execute('power', { action: 'reboot' });
  assert.equal(parked.ok, false);
  assert.equal(parked.needsConfirmation, true);
  assert.match(parked.text, /reboot/);
  assert.equal(tools.pending.list().length, 1);
  // A wrong id must not execute anything.
  await assert.rejects(() => tools.approve('nope'));
});

test('file tools refuse credentials and paths outside the roots', async () => {
  const config = tmpConfig();
  const tools = createTools({ config, memory: new Memory(config), notch: createNotch(config), whatsapp: {} });
  const secret = await tools.execute('read_file', { path: '~/.ssh/id_rsa' });
  assert.equal(secret.ok, false);
  assert.match(secret.text, /credentials/);
  const outside = await tools.execute('read_file', { path: '/etc/shadow' });
  assert.equal(outside.ok, false);
  assert.match(outside.text, /allowed roots/);
  const inside = await tools.execute('list_dir', { path: '~' });
  assert.equal(inside.ok, true);
});

test('reminder time parsing covers the forms the model is told to use', () => {
  const now = Date.now();
  assert.ok(parseWhen('25m') > now);
  assert.ok(Math.abs(parseWhen('2h') - (now + 7_200_000)) < 5000);
  assert.ok(parseWhen('18:30') > now);
  assert.equal(parseWhen('not a time'), null);
  assert.equal(humanBytes(1536), '1.5 KB');
});

// ── memory ─────────────────────────────────────────────────────────────────
test('memory persists facts, reminders and a bounded thread', () => {
  const config = tmpConfig({ maxHistory: 6 });
  const memory = new Memory(config);
  memory.remember('editor', 'neovim');
  const at = Date.now() + 60_000;
  const id = memory.addReminder('stretch', at);
  for (let i = 0; i < 20; i += 1) memory.append('chat', 'user', `message ${i}`);

  const reloaded = new Memory(config);
  assert.equal(reloaded.data.facts.editor.value, 'neovim');
  assert.equal(reloaded.reminders().length, 1);
  assert.equal(reloaded.history('chat').length, 6);
  assert.match(reloaded.promptBlock(), /editor: neovim/);
  reloaded.completeReminder(id);
  assert.equal(reloaded.reminders().length, 0);
});

test('a corrupt memory file is quarantined, not fatal', () => {
  const config = tmpConfig();
  fs.writeFileSync(config.memoryFile, '{not json');
  const memory = new Memory(config);
  assert.deepEqual(memory.facts(), []);
  assert.ok(fs.readdirSync(config.dataDir).some((name) => name.includes('corrupt')));
});

// ── engine ─────────────────────────────────────────────────────────────────
test('tool calls normalise from every shape a provider uses', () => {
  assert.deepEqual(normalizeToolCall({ function: { name: 'a', arguments: '{"x":1}' } }).arguments, { x: 1 });
  assert.deepEqual(normalizeToolCall({ name: 'b', arguments: { y: 2 } }).arguments, { y: 2 });
  assert.equal(normalizeToolCall({ function: { name: 'c', arguments: 'not json' } }).arguments.x, undefined);
  assert.equal(normalizeToolCall({}), null);
});

test('model picker prefers a capable small instruct model', () => {
  const picked = pickModel(['nomic-embed-text:latest', 'llava:7b', 'qwen3:8b', 'llama3.2:1b']);
  assert.equal(picked, 'qwen3:8b');
  assert.equal(pickModel([]), '');
});

// ── agents + skills ────────────────────────────────────────────────────────
test('frontmatter parsing handles lists, booleans and quoted values', () => {
  const parsed = parseFrontmatter('---\nname: x\ntags: [a, b]\nvoice: true\nmodel: "q" \n---\nthe body');
  assert.equal(parsed.meta.name, 'x');
  assert.deepEqual(parsed.meta.tags, ['a', 'b']);
  assert.equal(parsed.meta.voice, true);
  assert.equal(parsed.meta.model, 'q');
  assert.equal(parsed.body, 'the body');
});

test('the shipped agent and skills load, and skills match their topic', () => {
  const library = createAgentLibrary(tmpConfig());
  library.load({ force: true });
  assert.ok(library.agents.length >= 1);
  assert.equal(library.agent('psd').id, 'psd');
  assert.ok(library.skills.length >= 2);
  const triage = library.matchSkills('the pc is slow and the fan is loud');
  assert.ok(triage.length >= 1, 'a slow-PC question must surface the system-triage skill');
  assert.ok(triage.some((s) => s.id === 'system-triage'), `got ${triage.map((s) => s.id)}`);
  assert.equal(library.matchSkills('research the latest rust release')[0]?.id, 'research-brief');
  assert.deepEqual(library.matchSkills('hello there'), []);
});

// ── router: the four paths ─────────────────────────────────────────────────
function routerHarness({ engine, config = {} } = {}) {
  const cfg = tmpConfig(config);
  const memory = new Memory(cfg);
  const notch = createNotch(cfg);
  const tools = createTools({ config: cfg, memory, notch, whatsapp: { send: async () => ({ ok: true }) } });
  const agents = createAgentLibrary(cfg);
  const bus = Object.assign(() => {}, { subscribe: () => () => {} });
  const router = createRouter({ config: cfg, engine, tools, memory, agents, notch, whatsapp: {}, bus });
  return { cfg, memory, tools, router, agents };
}

test('router: quick path answers in single-digit milliseconds', async () => {
  const { router } = routerHarness({ engine: { chat: async () => { throw new Error('model must not be called'); } } });
  const result = await router.turn('hello', { source: 'test' });
  assert.equal(result.path, 'quick');
  assert.ok(result.ms < 50, `quick path took ${result.ms}ms`);
});

test('router: intent path runs exactly one tool', async () => {
  const { router, tools } = routerHarness({ engine: { chat: async () => { throw new Error('model must not be called'); } } });
  const calls = [];
  const original = tools.execute;
  tools.execute = async (name, args) => { calls.push(name); return original(name, args); };
  const result = await router.turn('disk space', { source: 'test' });
  assert.equal(result.path, 'intent');
  assert.deepEqual(calls, ['disk_space']);
});

test('router: model path streams, calls a tool, then answers', async () => {
  const brain = await startFakeBrain();
  try {
    const { router } = routerHarness({
      engine: {
        healthy: true,
        chat: async ({ messages, tools, onToken }) => {
          const hasResult = messages.some((m) => m.role === 'tool');
          if (!hasResult) {
            assert.ok(tools.length > 0, 'tools must be offered');
            return { content: '', toolCalls: [{ id: 'c1', name: 'disk_space', arguments: {} }], brain: 'fake' };
          }
          onToken?.('All good. ');
          return { content: 'All good.', toolCalls: [], brain: 'fake' };
        },
      },
    });
    const result = await router.turn('give me a quick read on this machine please', { source: 'test' });
    assert.equal(result.path, 'model');
    assert.match(result.text, /All good/);
    assert.deepEqual(result.toolsUsed, ['disk_space']);
  } finally { await brain.close(); }
});

test('router: a dead model falls back instead of failing the turn', async () => {
  const { router } = routerHarness({
    engine: { healthy: false, chat: async () => { const { NoBrainError } = await import('../src/engine.js'); throw new NoBrainError('down'); } },
  });
  const system = await router.turn('system status', { source: 'test' });
  assert.equal(system.path, 'intent', 'deterministic intents must not depend on the model');
  const question = await router.turn('why is my wifi so slow these days?', { source: 'test' });
  // Any path is fine as long as it is not silent: intent, keyword or the
  // explicit no-brain message that tells the owner how to start a model.
  assert.ok(['no-brain', 'keyword', 'intent'].includes(question.path), `unexpected path ${question.path}`);
  assert.ok(question.text.length > 0);
});

test('router: approval is parked, never executed by the model', async () => {
  const { router } = routerHarness({
    config: { access: 'full' },
    engine: {
      healthy: true,
      chat: async ({ messages }) => (messages.some((m) => m.role === 'tool')
        ? { content: 'Waiting for approval.', toolCalls: [] }
        : { content: '', toolCalls: [{ id: 'c1', name: 'power', arguments: { action: 'reboot' } }] }),
    },
  });
  const result = await router.turn('please reboot this box for me now', { source: 'test' });
  assert.equal(result.path, 'approval');
  assert.match(result.text, /approve/);
});

// ── server ─────────────────────────────────────────────────────────────────
test('server: auth, health, chat and SSE all behave', async () => {
  const { createServer } = await import('../src/server.js');
  const { config } = { config: { ...tmpConfig(), token: 'secret', trustLoopback: false, corsOrigin: '*', webDir: path.resolve('web') } };
  const engine = { healthy: false, chat: async () => { throw new Error('no'); }, probe: async () => ({ brains: [], brain: null }), chosen: null, lastProbe: null, plan: [] };
  const memory = new Memory(config);
  const notch = createNotch(config);
  const tools = createTools({ config, memory, notch, whatsapp: { send: async () => ({ ok: true }), status: async () => null, info: {} } });
  const agents = createAgentLibrary(config);
  const bus = Object.assign(() => {}, { subscribe: () => () => {} });
  const router = createRouter({ config, engine, tools, memory, agents, notch, whatsapp: {}, bus });
  const web = createServer({
    config, engine, tools, memory, agents, notch,
    whatsapp: { send: async () => ({ ok: true }), status: async () => null, info: {} },
    router, registry: tools.registry, bus,
  });
  const address = await web.listen();
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/psd/status`)).status, 401);
    assert.equal((await fetch(`${base}/psd/status`, { headers: { 'x-psd-token': 'secret' } })).status, 200);
    assert.equal((await fetch(`${base}/psd/status?token=secret`)).status, 200);

    const chat = await fetch(`${base}/psd/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-psd-token': 'secret' },
      body: JSON.stringify({ text: 'who are you?' }),
    }).then((r) => r.json());
    assert.equal(chat.path, 'quick');

    const tool = await fetch(`${base}/psd/tool`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-psd-token': 'secret' },
      body: JSON.stringify({ tool: 'list_dir', args: { path: '~' } }),
    }).then((r) => r.json());
    assert.equal(tool.ok, true);

    // SSE must emit start → done for a deterministic turn.
    const stream = await fetch(`${base}/psd/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-psd-token': 'secret' },
      body: JSON.stringify({ text: 'system status' }),
    });
    const text = await stream.text();
    assert.match(text, /event: start/);
    assert.match(text, /event: done/);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>PSD/);
  } finally {
    await web.close();
  }
});

// ── browser safety ─────────────────────────────────────────────────────────
test('a cross-origin page cannot drive the agent, with or without a token in the URL', async () => {
  const { createServer } = await import('../src/server.js');
  const config = { ...tmpConfig(), token: 'secret', trustLoopback: true, corsOrigin: '', webDir: path.resolve('web') };
  const memory = new Memory(config);
  const notch = createNotch(config);
  const whatsapp = { send: async () => ({ ok: true }), status: async () => null, info: {} };
  const tools = createTools({ config, memory, notch, whatsapp });
  const agents = createAgentLibrary(config);
  const bus = Object.assign(() => {}, { subscribe: () => () => {} });
  const engine = { healthy: false, chat: async () => { throw new Error('no'); }, probe: async () => ({ brains: [] }), chosen: null, lastProbe: null };
  const router = createRouter({ config, engine, tools, memory, agents, notch, whatsapp, bus });
  const openai = { models: () => ({ data: [] }), completions: async () => ({}), streamCompletions: async () => ({}), forward: async () => ({}) };
  const web = createServer({ config, engine, tools, memory, agents, notch, whatsapp, router, openai, registry: tools.registry, bus });
  const { port } = await web.listen();
  const base = `http://127.0.0.1:${port}`;
  const evil = { origin: 'https://evil.example' };
  try {
    // A foreign origin is refused outright — before auth is even considered.
    const noToken = await fetch(`${base}/psd/status`, { headers: evil });
    assert.equal(noToken.status, 403);
    assert.equal((await noToken.json()).error, 'origin_refused');
    assert.equal(noToken.headers.get('access-control-allow-origin'), null);

    // Even with the token in the URL, an Origin-bearing request may not use it.
    const queryToken = await fetch(`${base}/psd/status?token=secret`, { headers: evil });
    assert.equal(queryToken.status, 403);

    // A header token from a page IS allowed to authenticate (explicit, browser-visible
    // secret) but still gets no permissive CORS header unless allowlisted.
    const headerToken = await fetch(`${base}/psd/status`, { headers: { ...evil, 'x-psd-token': 'secret' } });
    assert.equal(headerToken.headers.get('access-control-allow-origin'), null);

    // Preflight from a foreign origin fails instead of lying.
    assert.equal((await fetch(`${base}/psd/status`, { method: 'OPTIONS', headers: evil })).status, 403);

    // Non-browser clients are unaffected: no Origin, loopback, no token.
    assert.equal((await fetch(`${base}/psd/status`)).status, 200);
    // And curl-style with an explicit token always works.
    assert.equal((await fetch(`${base}/psd/status?token=secret`)).status, 200);
  } finally {
    await web.close();
  }
});
