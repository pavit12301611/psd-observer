// DOM emulation and service-worker contracts, not a physical-browser E2E test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';
import { root } from '../scripts/test-workspace.mjs';
const html = fs.readFileSync(path.join(root, 'webapp/index.html'), 'utf8');
const source = fs.readFileSync(path.join(root, 'webapp/app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'webapp/sw.js'), 'utf8');
const turn = () => new Promise((resolve) => setImmediate(resolve));
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fixture(t, { token = '', history = '[]', onChat = async () => response({ ok: true, text: 'fixture reply' }) } = {}) {
  const errors = [], seen = [], console = new VirtualConsole(); console.on('jsdomError', (err) => errors.push(err.message));
  const dom = new JSDOM(html, { url: 'http://bridge.invalid/', runScripts: 'outside-only', virtualConsole: console });
  t.after(() => dom.window.close()); const win = dom.window;
  win.setInterval = () => 1; win.clearInterval = () => {};
  win.localStorage.setItem('observer-agent-chat', history);
  if (token) win.localStorage.setItem('observer-agent-token', token);
  win.fetch = async (url, opts = {}) => {
    seen.push({ url, ...opts });
    if (url === '/api/login') return response({ token: 'fixture-token' });
    if (url === '/api/chat') return onChat(url, opts);
    if (url === '/api/files') return response({ downloads: [], shared: [] });
    if (url === '/api/status') return response({ whatsapp: 'dry-run', stats: {} });
    return response({});
  };
  win.eval(source + '\n//# sourceURL=' + pathToFileURL(path.join(root, 'webapp/app.js')).href);
  return { win, seen, errors, $: (selector) => win.document.querySelector(selector) };
}

test('deep/webapp: the shipped browser entry point actually parses', () => {
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'webapp/app.js' }));
});

test('deep/webapp: login boots and provider HTML remains inert text in chat', async (t) => {
  const malicious = '<img src=x onerror="window.injected=1"><script>window.injected=1</script>';
  const f = fixture(t, { onChat: async () => response({ ok: true, text: malicious }) });
  assert.equal(f.$('#login').classList.contains('hidden'), false);
  f.$('#pin').value = '123456';
  f.$('#login-form').dispatchEvent(new f.win.Event('submit', { bubbles: true, cancelable: true })); await turn();
  assert.equal(f.win.localStorage.getItem('observer-agent-token'), 'fixture-token');
  assert.equal(f.$('#app').classList.contains('hidden'), false);
  f.$('#chat-input').value = 'hello';
  f.$('#chat-form').dispatchEvent(new f.win.Event('submit', { bubbles: true, cancelable: true })); await turn();
  assert.match(f.$('#messages').textContent, /<img src=x/);
  assert.equal(f.$('#messages script'), null); assert.equal(f.$('#messages img[src=x]'), null); assert.equal(f.win.injected, undefined);
  assert.equal(f.seen.find((req) => req.url === '/api/chat').headers['x-bridge-token'], 'fixture-token');
  assert.deepEqual(f.errors, []);
});

test('deep/webapp: damaged cached chat shapes cannot prevent boot', async (t) => {
  for (const history of ['{}', 'null', '[null,{"role":"bot","text":"hi","images":{}},{"role":"user","text":"ok"}]']) {
    const f = fixture(t, { token: 'fixture-token', history }); await turn();
    assert.equal(f.$('#app').classList.contains('hidden'), false); assert.deepEqual(f.errors, []);
  }
});

test('deep/webapp: logout cannot be undone by a late chat response repopulating local storage', async (t) => {
  let resolve;
  const gate = new Promise((r) => { resolve = r; });
  const f = fixture(t, { token: 'fixture-token', onChat: () => gate }); await turn();
  f.$('#chat-input').value = 'private request';
  f.$('#chat-form').dispatchEvent(new f.win.Event('submit', { bubbles: true, cancelable: true })); await turn();
  f.$('#logout').click(); resolve(response({ ok: true, text: 'private late reply' })); await turn();
  assert.equal(f.win.localStorage.getItem('observer-agent-token'), null);
  assert.deepEqual(JSON.parse(f.win.localStorage.getItem('observer-agent-chat')), []);
  assert.equal(f.$('#login').classList.contains('hidden'), false);
});

test('deep/webapp: service worker never caches API/private routes and activates without deleting unrelated caches', async () => {
  const handlers = {}, deleted = [], cached = [];
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const name = `observer-agent-v${version}`;
  const context = { URL, location: { origin: 'http://bridge.invalid' }, self: { addEventListener: (event, handler) => { handlers[event] = handler; }, clients: { claim: async () => {} }, skipWaiting: async () => {} },
    caches: { match: async () => null, keys: async () => ['observer-agent-v3', name, 'unrelated-cache'], delete: async (key) => deleted.push(key), open: async () => ({ addAll: async (paths) => cached.push(...paths) }) }, fetch: async () => { throw new Error('no real network'); } };
  vm.runInNewContext(sw, context, { filename: path.join(root, 'webapp/sw.js') });
  let install; handlers.install({ waitUntil: (p) => { install = p; } }); await install;
  assert.ok(cached.includes('/app.js'));
  let activate; handlers.activate({ waitUntil: (p) => { activate = p; } }); await activate;
  assert.deepEqual(deleted, ['observer-agent-v3']);
  for (const url of ['/api/chat', '/api/status', '/qr.png', '/health', 'https://other.invalid/a', '/?t=fixture-secret', '/app.js?t=fixture-secret', '/unknown-private-path']) {
    let intercepted = false;
    handlers.fetch({ request: { url: new URL(url, context.location.origin).href, method: 'GET' }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, url);
  }
});

test('deep/webapp: a stale 401 from an old session cannot log out a fresh login', async (t) => {
  let resolve; const gate = new Promise((r) => { resolve = r; });
  const f = fixture(t, { token: 'old-fixture-token', onChat: () => gate }); await turn();
  f.$('#chat-input').value = 'old session request';
  f.$('#chat-form').dispatchEvent(new f.win.Event('submit', { bubbles: true, cancelable: true })); await turn();
  f.$('#logout').click(); f.$('#pin').value = '123456';
  f.$('#login-form').dispatchEvent(new f.win.Event('submit', { bubbles: true, cancelable: true })); await turn();
  resolve(response({ detail: 'old session expired' }, 401)); await turn();
  assert.equal(f.win.localStorage.getItem('observer-agent-token'), 'fixture-token');
  assert.equal(f.$('#app').classList.contains('hidden'), false);
  assert.deepEqual(JSON.parse(f.win.localStorage.getItem('observer-agent-chat')), []);
});

function publicShell({ ownHit = null, network = async () => { throw new Error('offline'); }, globalMatch = async () => ({ body: 'foreign-cache' }) } = {}) {
  const handlers = {}, opened = [], written = [], waits = [], fetched = []; let globalReads = 0;
  const cache = { match: async () => ownHit, put: async (request, value) => written.push({ request, value }) };
  const context = { URL, location: { origin: 'http://bridge.invalid' }, self: { addEventListener: (name, handler) => { handlers[name] = handler; } },
    caches: { open: async (name) => { opened.push(name); return cache; }, match: async (request) => { globalReads++; return globalMatch(request); } },
    fetch: async (request) => { fetched.push(request); return network(request); } };
  vm.runInNewContext(sw, context, { filename: path.join(root, 'webapp/sw.js') });
  const request = { url: 'http://bridge.invalid/app.js', method: 'GET', mode: 'same-origin' }; let result;
  handlers.fetch({ request, respondWith: (p) => { result = p; }, waitUntil: (p) => waits.push(p) });
  return { opened, written, waits, fetched, result, request, globalReads: () => globalReads };
}

test('deep/webapp: public shell only reads its own versioned cache, never another app cache', async () => {
  const ownHit = { body: 'observer-code' }, f = publicShell({ ownHit });
  assert.equal(await f.result, ownHit); assert.equal(f.globalReads(), 0); assert.equal(f.fetched.length, 0);
  assert.deepEqual(f.opened, [`observer-agent-v${JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version}`]);
});

test('deep/webapp: public shell network misses persist only in the owning cache and extend event lifetime', async () => {
  const copy = { body: 'copy' }, original = { ok: true, clone: () => copy };
  const f = publicShell({ globalMatch: async () => null, network: async () => original });
  assert.equal(await f.result, original); await Promise.all(f.waits);
  assert.equal(f.waits.length, 1); assert.equal(f.written.length, 1); assert.equal(f.written[0].value, copy);
  assert.equal(f.globalReads(), 0);
});

test('deep/webapp: public shell offline script misses cannot return cached HTML as JavaScript', async () => {
  const f = publicShell({ globalMatch: async (request) => typeof request === 'string' ? { body: '<html>foreign fallback</html>' } : null });
  await assert.rejects(f.result, /offline/); assert.equal(f.globalReads(), 0);
});
