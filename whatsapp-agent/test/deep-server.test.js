import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridgeServer, replyForApp } from '../src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = { info() {}, error() {}, warn() {} };
async function fixture(t, overrides = {}) {
  let ownerCalls = 0;
  const config = { host: '127.0.0.1', port: 0, bridgeToken: 'deep-fixture-token', dashboardPin: '123456', ownerNumber: '919999999999', agentNumber: '918888888888', ...overrides };
  const bridge = createBridgeServer({ config, store: { data: { stats: {} } }, whatsapp: { status: () => ({ connected: false }) }, mailbox: { observerOnline: () => false },
    actions: {}, runOwner: async (text) => { ownerCalls++; return `fixture: ${text}`; }, log });
  const server = await bridge.start();
  t.after(async () => { server.closeAllConnections(); const closed = once(server, 'close'); bridge.stop(); await closed; });
  return { url: `http://127.0.0.1:${server.address().port}`, config, calls: () => ownerCalls };
}

const post = (url, data, token = 'deep-fixture-token') => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bridge-token': token }, body: typeof data === 'string' ? data : JSON.stringify(data) });

test('deep/bridge: missing or blank configured tokens fail closed, not open', async (t) => {
  for (const bridgeToken of ['', undefined, '   ']) {
    const f = await fixture(t, { bridgeToken });
    const response = await fetch(`${f.url}/api/not-a-route`);
    assert.equal(response.status, 401); assert.equal(f.calls(), 0);
  }
});

test('deep/bridge: every credential channel rejects wrong values and accepts only the configured token', async (t) => {
  const f = await fixture(t);
  for (const [headers, query, wanted] of [
    [{}, '', 401], [{ authorization: 'Bearer wrong' }, '', 401], [{ 'x-bridge-token': 'wrong' }, '', 401],
    [{ authorization: 'Bearer deep-fixture-token' }, '', 404], [{ 'x-bridge-token': 'deep-fixture-token' }, '', 404], [{}, '?t=deep-fixture-token', 404],
  ]) assert.equal((await fetch(`${f.url}/api/not-a-route${query}`, { headers })).status, wanted);
});

test('deep/bridge: malformed Host cannot reject the async handler and terminate the process', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http'; import {createBridgeServer} from './src/server.js';
    const noop=()=>{}; let server;
    process.on('unhandledRejection',()=>{server?.closeAllConnections();server?.close();process.exitCode=17;});
    const bridge=createBridgeServer({config:{host:'127.0.0.1',port:0,bridgeToken:'fixture'},store:{data:{}},whatsapp:{status:()=>({})},mailbox:{observerOnline:()=>false},actions:{},log:{info:noop,error:noop}});
    server=await bridge.start();
    await new Promise(resolve=>{const req=http.get({host:'127.0.0.1',port:server.address().port,path:'/health',headers:{host:'['}},res=>{console.log('status='+res.statusCode);res.resume();res.on('end',resolve);});req.on('error',resolve);});
    server.closeAllConnections();bridge.stop();
  `], { cwd: root, encoding: 'utf8', timeout: 5000 });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /status=400/);
});

test('deep/bridge: body must be a JSON object; malformed/scalar payloads never reach owner code', async (t) => {
  const f = await fixture(t);
  for (const body of ['{', 'null', '[]', '42', '"text"']) {
    const response = await post(`${f.url}/api/chat`, body);
    assert.equal(response.status, 400, body);
  }
  assert.equal(f.calls(), 0);
  const good = await post(`${f.url}/api/chat`, { text: '/time' });
  assert.equal(good.status, 200); assert.equal(f.calls(), 1);
});

test('deep/bridge: failed structured replies retain their failure rather than becoming empty success', () => {
  const reply = replyForApp({ ok: false, error: 'not completed' });
  assert.equal(reply.ok, false); assert.match(reply.text, /not completed/);
  assert.equal(replyForApp('done').ok, true); assert.equal(replyForApp(null).text, '');
});

test('deep/bridge: health version is the installed package version, not a hard-coded old release', async (t) => {
  const f = await fixture(t), body = await (await fetch(`${f.url}/health`)).json();
  assert.equal(body.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
});

test('deep/bridge: login failure budget is enforced; valid login returns only the configured token', async (t) => {
  const f = await fixture(t);
  assert.equal((await post(`${f.url}/api/login`, { pin: 'wrong' })).status, 401);
  const valid = await post(`${f.url}/api/login`, { pin: f.config.dashboardPin });
  assert.equal((await valid.json()).token, f.config.bridgeToken);
  for (let i = 0; i < 12; i++) assert.equal((await post(`${f.url}/api/login`, { pin: 'wrong' })).status, 401);
  assert.equal((await post(`${f.url}/api/login`, { pin: 'wrong' })).status, 429);
  assert.equal(f.calls(), 0);
});

test('deep/bridge: oversized declared bodies are rejected before waiting for an upload or running owner code', async (t) => {
  const f = await fixture(t), url = new URL(`${f.url}/api/chat`);
  const status = await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'x-bridge-token': f.config.bridgeToken, 'content-length': 31 * 1024 * 1024 } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end('{}');
  });
  assert.equal(status, 413); assert.equal(f.calls(), 0);
  assert.equal((await fetch(`${f.url}/health`)).status, 200);
});

test('deep/bridge: a valid PIN cannot issue an empty bridge credential', async (t) => {
  const f = await fixture(t, { bridgeToken: '' });
  assert.equal((await post(`${f.url}/api/login`, { pin: f.config.dashboardPin })).status, 503);
});
