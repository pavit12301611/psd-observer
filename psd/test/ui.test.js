// test/ui.test.js — the real client, in a real DOM, against the real server.
//
// jsdom has no layout engine, so this does not replace a browser. What it does
// prove is that web/app.js runs end to end: it wires its listeners, sends a
// message, consumes the SSE stream, renders bubbles, and fills the System,
// Files and More views from live API data. A broken selector or a typo in the
// DOM contract fails here instead of on the owner's phone.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// jsdom is a devDependency: without it this file must *skip*, not fail, so
// `npm test` stays meaningful on a machine that only runs the service.
let JSDOM;
let VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = await import('jsdom'));
} catch {
  JSDOM = null;
}
const needsDom = JSDOM ? {} : { skip: 'jsdom is not installed (npm install -D jsdom)' };

import { Memory } from '../src/memory.js';
import { createTools } from '../src/tools.js';
import { createNotch } from '../src/notch.js';
import { createAgentLibrary } from '../src/agents.js';
import { createRouter } from '../src/router.js';
import { createServer } from '../src/server.js';

const WEB = path.resolve('web');

function tmpConfig(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psd-ui-'));
  return {
    dataDir: dir, memoryFile: path.join(dir, 'memory.json'), runFile: path.join(dir, 'runs.jsonl'),
    agentDir: path.resolve('agents'), webDir: WEB, agent: 'psd', access: 'standard',
    shell: false, shellPin: '', allowRoots: [], confirmTtlMs: 60_000, toolTimeoutMs: 10_000,
    maxHistory: 24, skills: true, hostname: 'uitest', platform: 'Linux', version: 'test',
    port: 0, token: 'uitoken', trustLoopback: true, corsOrigin: '', notchBus: 'off',
    notchPath: '/x', whatsappUrl: 'http://127.0.0.1:1', whatsappToken: '', whatsappBridge: false,
    temperature: 0.2, maxSteps: 3, requestTimeoutMs: 5000, startedAt: Date.now(),
    ...extra,
  };
}

async function harness(overrides = {}) {
  const config = tmpConfig(overrides);
  const memory = new Memory(config);
  const notch = createNotch(config);
  const whatsapp = { send: async () => ({ ok: true }), status: async () => null, info: {}, flush: async () => 0 };
  const tools = createTools({ config, memory, notch, whatsapp });
  const agents = createAgentLibrary(config);
  const bus = Object.assign(() => {}, { subscribe: () => () => {} });
  const engine = {
    healthy: false, chat: async () => { throw new Error('no model in this test'); },
    probe: async () => ({ brains: [], brain: null, model: null }), chosen: null, lastProbe: { brains: [], brain: null, model: null },
  };
  const router = createRouter({ config, engine, tools, memory, agents, notch, whatsapp, bus });
  const openai = { models: () => ({ data: [] }), completions: async () => ({}), streamCompletions: async () => ({}), forward: async () => ({}) };
  const web = createServer({ config, engine, tools, memory, agents, notch, whatsapp, router, openai, registry: tools.registry, bus });
  const { port } = await web.listen();
  return { config, memory, tools, web, url: `http://127.0.0.1:${port}` };
}

/** Load the shell into jsdom with the app pointed at the test server. */
async function openApp(url, { token = 'uitoken' } = {}) {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => errors.push(err.message));
  virtualConsole.on('error', (message) => errors.push(String(message)));

  const dom = new JSDOM(html.replace('/app.js', '/app.js'), {
    url: `${url}/`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const { window } = dom;
  window.fetch = (input, init) => {
    const target = typeof input === 'string' && input.startsWith('http') ? input : `${url}${input}`;
    return fetch(target, init);
  };
  window.localStorage.setItem('psd.token', token);
  window.localStorage.setItem('psd.url', url);
  window.TextDecoder = TextDecoder;
  window.TextEncoder = TextEncoder;
  window.AbortController = AbortController;
  window.ReadableStream = ReadableStream;

  const script = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  window.eval(script.replace(/^import .*$/gm, ''));
  return { dom, window, errors };
}

const waitFor = async (predicate, { timeout = 5000, step = 30 } = {}) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
};

test('the app renders, streams an answer into a bubble, and fills every view', needsDom, async () => {
  const world = await harness();
  try {
    const { dom, window, errors } = await openApp(world.url);
    const $ = (sel) => window.document.querySelector(sel);

    // Shell rendered and wired.
    assert.ok($('#input'), 'composer input must exist');
    assert.equal(window.document.querySelectorAll('.tab').length, 5);
    assert.ok($('#hello'), 'welcome block renders before the first message');

    // Status polling fills the top bar and the System view from the live API.
    const brainPill = await waitFor(() => $('#brain-label').textContent !== 'brain' && $('#brain-label').textContent);
    assert.ok(brainPill, 'brain pill must be filled by /psd/status');
    await waitFor(() => $('#val-cpu').textContent !== '—');
    assert.match($('#val-cpu').textContent, /%|—/);
    assert.ok($('#kv-health').children.length > 0, 'health card must list values');

    // Send a real message: it must go through POST /psd/chat/stream.
    $('#input').value = 'system status';
    $('#btn-send').click();
    const bubbles = await waitFor(() => {
      const all = [...window.document.querySelectorAll('.msg.agent')];
      return all.length && all.some((node) => /Host:|CPU:/.test(node.textContent)) ? all : null;
    });
    assert.ok(bubbles, 'the intent answer must be rendered as an agent bubble');
    const last = bubbles.at(-1);
    assert.match(last.textContent, /CPU:/);
    assert.ok(last.querySelector('.meta'), 'the answer must show its path/tools footer');
    assert.match(last.querySelector('.meta').textContent, /intent|tool/);
    assert.equal(window.document.querySelector('.msg.user')?.textContent, 'system status');
    assert.equal($('#hello'), null, 'welcome block is removed after the first message');

    // Files view: real directory listing through the tool API.
    window.document.querySelector('.tab[data-view="files"]').click();
    const rows = await waitFor(() => {
      const list = window.document.querySelectorAll('#files-list .row');
      return list.length ? [...list] : null;
    });
    assert.ok(rows.length > 0, 'home directory must list something');

    // More view: memory + reminders render, connection fields are prefilled.
    window.document.querySelector('.tab[data-view="more"]').click();
    await waitFor(() => window.document.querySelector('#memory-list .row, #memory-list .empty'));
    assert.ok($('#memory-list').children.length > 0);
    assert.equal($('#set-url').value, world.url);
    assert.ok($('#set-token').value.startsWith('•'));

    // Agents view: the shipped agent and skills come from disk.
    window.document.querySelector('.tab[data-view="agents"]').click();
    await waitFor(() => /agent|skill/i.test($('#agents-count').textContent));
    assert.match($('#agents-count').textContent, /\d+ agents/);
    assert.match($('#agents-count').textContent, /\d+ skills/);

    assert.deepEqual(errors.filter((m) => !/Not implemented|Could not parse CSS/.test(m)), [],
      'no uncaught errors in the client');
    dom.window.close();
  } finally {
    await world.web.close();
  }
});

test('a rejected token surfaces the connect sheet instead of a silent empty app', needsDom, async () => {
  // trustLoopback off is what an owner sees when they point the app at a PC
  // from a device, or after changing the token: a 401, not an empty shell.
  const world = await harness({ trustLoopback: false });
  try {
    const { dom, window } = await openApp(world.url, { token: 'wrong-token' });
    const sheet = await waitFor(() => !window.document.querySelector('#sheet-conn').classList.contains('hidden'));
    assert.ok(sheet, 'the connect sheet must open when the token is rejected');
    // The app must offer a way forward: a token field and a connect button.
    assert.ok(window.document.querySelector('#conn-token'));
    assert.ok(window.document.querySelector('#btn-conn-save'));
    dom.window.close();
  } finally {
    await world.web.close();
  }
});

test('the shell keeps its accessibility and theming promises', needsDom, () => {
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
  const { document } = new JSDOM(html, { url: 'http://127.0.0.1:7788/' }).window;

  // Every navigation target is named for a screen reader, not just an icon.
  for (const tab of document.querySelectorAll('.tabbar .tab')) {
    assert.ok(tab.getAttribute('aria-label'), `tab ${tab.dataset.view} needs an aria-label`);
  }
  // The composer and its send button are reachable and named.
  assert.ok(document.querySelector('#input'));
  assert.ok(document.querySelector('#btn-send').getAttribute('aria-label'));
  assert.equal(document.querySelector('#thread').getAttribute('aria-live'), 'polite',
    'the answer thread must announce changes');
  assert.equal(document.querySelectorAll('h1').length, 1, 'one h1 per page');

  // Focus is visible for keyboard users, and motion is respectful.
  assert.match(css, /:focus-visible/, 'focus must be styled');
  assert.match(css, /prefers-reduced-motion/, 'reduced motion must be honoured');
  assert.match(css, /prefers-contrast/, 'high contrast must be honoured');
  assert.match(css, /prefers-color-scheme: light/, 'light mode must follow the system');
  assert.match(css, /safe-area-inset/, 'phones with a gesture bar need safe insets');
});
