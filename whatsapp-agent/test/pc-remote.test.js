import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridgeServer, readCrop } from '../src/server.js';
import { parseLockedHint, parseScreensaverActive, parseUpowerBattery } from '../src/pccontrol.js';
import { Store } from '../src/store.js';

const silent = { info() {}, warn() {}, error() {} };
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'observer-pc-'));
function fakePng(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16); buffer.writeUInt32BE(height, 20);
  return buffer;
}
function config(dir, overrides = {}) {
  return {
    ownerNumber: '919528923866', agentNumber: '918859555795', timezone: 'Asia/Kolkata', accessLevel: 'full',
    dataDir: dir, storeFile: path.join(dir, 'store.json'), downloadsDir: path.join(dir, 'downloads'), sharedDir: path.join(dir, 'shared'),
    filesExtraRoots: [], allowPcControl: true, bridgeToken: 'tok-pc', dashboardPin: '4321', ...overrides,
  };
}
async function bridgeFor(t, { screen = {}, system = {}, cfg = {} } = {}) {
  const dir = tempDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(path.join(dir, 'store.json'));
  store.data.stats.startedAt = Date.now();
  const bridge = createBridgeServer({
    config: config(dir, cfg), store, log: silent, screen, system,
    whatsapp: { status: () => 'connected', state: {}, sendToOwner: async () => {} },
    mailbox: { observerOnline: () => false, listen: async () => [] }, actions: null,
  });
  const server = await bridge.start();
  t.after(async () => { server.closeAllConnections?.(); await new Promise((resolve) => { server.close(resolve); bridge.stop?.(); }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { 'x-bridge-token': 'tok-pc' };
  const get = (p, headers = auth) => fetch(base + p, { headers });
  const post = (p, body, headers = auth) => fetch(base + p, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { base, auth, get, post };
}

test('pc/state: reports lock, display and busy without ever exposing a password', async (t) => {
  const calls = { state: 0 };
  const f = await bridgeFor(t, { system: {
    state: async () => { calls.state += 1; return { session: 'wayland', graphical: true, locked: true, display: 'unknown', battery: { percent: 74, charging: false }, diskFreeMb: 51200, host: 'fedora' }; },
  } });
  const res = await f.get('/api/pc/state');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.locked, true);
  assert.equal(body.session, 'wayland');
  assert.equal(body.battery.percent, 74);
  assert.equal(body.pcControl, true);
  assert.equal(body.accessLevel, 'full');
  assert.equal(calls.state, 1);
  assert.equal((await f.get('/api/pc/state', {})).status, 401, 'state is not public');
});

test('pc/state: an unavailable desktop is a 503 with a reason, not a silent empty object', async (t) => {
  const f = await bridgeFor(t, { system: { state: async () => { throw new Error('No graphical session found.'); } } });
  const res = await f.get('/api/pc/state');
  assert.equal(res.status, 503);
  assert.match((await res.json()).detail, /No graphical session/);
});

test('pc/display: wakes the display behind the PIN gate and reports what ran', async (t) => {
  const seen = [];
  const f = await bridgeFor(t, { system: { wake: async () => ({ woken: ['gdbus'], locked: false, session: 'wayland' }) }, cfg: { controlPin: '2468' } });
  assert.equal((await f.post('/api/pc/display', {})).status, 403, 'PIN required');
  assert.equal((await f.post('/api/pc/display', { pin: '0000' })).status, 403);
  const ok = await f.post('/api/pc/display', { pin: '2468' });
  seen.push(ok.status);
  assert.deepEqual(seen, [200]);
  assert.deepEqual(await ok.json(), { ok: true, woken: ['gdbus'], locked: false, session: 'wayland' });
});

test('pc/display: policy off is refused and a failed wake is not reported as success', async (t) => {
  const off = await bridgeFor(t, { cfg: { allowPcControl: false } });
  assert.equal((await off.post('/api/pc/display', {})).status, 403);
  const broken = await bridgeFor(t, { system: { wake: async () => { throw new Error('Could not wake the display: no tool'); } } });
  const res = await broken.post('/api/pc/display', {});
  assert.equal(res.status, 503);
  assert.match((await res.json()).detail, /Could not wake the display/);
});

test('clipboard: read and bounded write, with PIN and policy on write', async (t) => {
  const writes = [];
  const f = await bridgeFor(t, { system: {
    clipboardRead: async () => ({ text: 'hello from the PC', truncated: false }),
    clipboardWrite: async (text) => { writes.push(text); return { ok: true, chars: text.length }; },
  }, cfg: { controlPin: '2468' } });
  assert.deepEqual(await (await f.get('/api/clipboard')).json(), { text: 'hello from the PC', truncated: false });
  assert.equal((await f.post('/api/clipboard', { text: 'nope' })).status, 403, 'PIN required to overwrite');
  assert.equal((await f.post('/api/clipboard', { text: 'nope', pin: '0000' })).status, 403);
  assert.equal((await f.post('/api/clipboard', { text: '', pin: '2468' })).status, 400);
  assert.equal((await f.post('/api/clipboard', { text: 'x'.repeat(20_001), pin: '2468' })).status, 413);
  const ok = await f.post('/api/clipboard', { text: 'typed on the phone', pin: '2468' });
  assert.equal(ok.status, 200);
  assert.deepEqual(writes, ['typed on the phone']);
});

test('screen: a zoomed request asks the capture layer for exactly that region', async (t) => {
  const boxes = [];
  const f = await bridgeFor(t, {
    screen: {
      capture: async () => fakePng(1600, 900),
      crop: async (buffer, box) => { boxes.push(box); return { image: Buffer.from('cropped-jpeg'), mime: 'image/jpeg' }; },
    },
  });
  const res = await f.get('/api/screen?w=1440&cx=250&cy=0&cw=500&ch=500');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-screen-crop'), 'region');
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(boxes, [{ x: 250, y: 0, w: 500, h: 500 }]);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'cropped-jpeg');
});

test('screen: nonsense or missing crop falls back to the full frame', async (t) => {
  const boxes = [];
  const f = await bridgeFor(t, {
    screen: { capture: async () => fakePng(1200, 800), crop: async (buffer, box) => { boxes.push(box); return null; } },
  });
  for (const query of ['', '?cx=1&cy=1', '?cx=-5&cy=0&cw=500&ch=500', '?cx=600&cy=0&cw=500&ch=500', '?cx=0&cy=0&cw=5&ch=5']) {
    const res = await f.get('/api/screen' + query);
    assert.equal(res.status, 200, query);
    assert.equal(res.headers.get('x-screen-crop'), 'full', query);
  }
  assert.equal(boxes.length, 0, 'invalid crops never reach the capture layer');
  // A structurally valid region is passed on even when the backend cannot crop.
  const valid = await f.get('/api/screen?cx=0&cy=0&cw=500&ch=500');
  assert.equal(valid.headers.get('x-screen-crop'), 'full', 'sharp-less backend degrades to the full frame');
  assert.deepEqual(boxes, [{ x: 0, y: 0, w: 500, h: 500 }]);
  assert.deepEqual(readCrop(new URLSearchParams('cx=0&cy=0&cw=1000&ch=1000')), { x: 0, y: 0, w: 1000, h: 1000 });
  assert.equal(readCrop(new URLSearchParams('cx=0&cy=0&cw=1000&ch=1001')), null, 'crop cannot leave the screen');
});

test('parsers: lock, screensaver and battery text are read conservatively', () => {
  assert.equal(parseLockedHint('LockedHint=yes'), true);
  assert.equal(parseLockedHint('LockedHint=no'), false);
  assert.equal(parseLockedHint('garbage'), null);
  assert.equal(parseScreensaverActive('(true,)'), true);
  assert.equal(parseScreensaverActive('(false,)'), false);
  assert.equal(parseScreensaverActive('()'), null);
  assert.deepEqual(parseUpowerBattery('state: discharging\npercentage: 42%'), { percent: 42, charging: false });
  assert.deepEqual(parseUpowerBattery('state: charging\npercentage: 88%'), { percent: 88, charging: true });
  assert.equal(parseUpowerBattery('percentage: unknown'), null);
  assert.equal(parseUpowerBattery('percentage: 140%'), null);
});
