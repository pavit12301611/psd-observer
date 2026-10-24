import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createUpdateChannel, canonicalManifest, safeEntry } from '../src/mobile/update.js';
import { createBridgeServer } from '../src/server.js';

const folder = (t) => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-update-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };
function dist(t, files = { 'index.html': '<!doctype html><title>fixture</title>', 'assets/app.js': 'console.log(1)', 'assets/app.css': 'body{margin:0}' }) {
  const root = path.join(folder(t), 'dist');
  for (const [name, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), body); }
  return root;
}
const pem = (spki) => `-----BEGIN PUBLIC KEY-----\n${spki.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
/** Minimal central-directory reader: proves the archive is a real ZIP, not a renamed blob. */
function unzip(buffer) {
  let eocd = buffer.length - 22;
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'end of central directory present');
  const count = buffer.readUInt16LE(eocd + 10), files = {};
  let pointer = buffer.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(pointer), 0x02014b50);
    const compressed = buffer.readUInt32LE(pointer + 20), size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28), extra = buffer.readUInt16LE(pointer + 30);
    const comment = buffer.readUInt16LE(pointer + 32), offset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.slice(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    const local = buffer.slice(offset, offset + 30);
    const start = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
    const data = zlib.inflateRawSync(buffer.slice(start, start + compressed));
    assert.equal(data.length, size); files[name] = data.toString('utf8');
    pointer += 46 + nameLength + extra + comment;
  }
  return files;
}
const signatureOf = (updates, version) => fs.readFileSync(path.join(updates, version, 'manifest.sig'), 'utf8').trim();

test('update: pack emits a real ZIP with matching hash and an owner-only private key', (t) => {
  const updates = path.join(folder(t), 'updates'), channel = createUpdateChannel({ dir: updates, now: () => 1_700_000_000_000 });
  const { manifest } = channel.pack({ dist: dist(t), version: '1.1.1', notes: 'fixture notes' });
  const offered = channel.manifest(), bundle = channel.bundle();
  assert.equal(offered.version, '1.1.1');
  assert.equal(createHash('sha256').update(bundle).digest('hex'), manifest.sha256);
  assert.equal(bundle.length, manifest.size);
  assert.deepEqual(Object.keys(unzip(bundle)).sort(), ['assets/app.css', 'assets/app.js', 'index.html']);
  assert.equal(unzip(bundle)['index.html'], '<!doctype html><title>fixture</title>');
  const privateKey = path.join(updates, 'signing', 'update-signing-key.pem');
  assert.equal(fs.statSync(privateKey).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(privateKey, 'utf8'), /BEGIN PRIVATE KEY/);
});
test('update: signature verifies and refuses substituted version/hash or foreign keys', (t) => {
  const updates = path.join(folder(t), 'updates'), channel = createUpdateChannel({ dir: updates });
  const { manifest, keyId } = channel.pack({ dist: dist(t), version: '1.1.2' });
  const key = channel.key(), publicKey = pem(key.key);
  assert.equal(key.keyId, keyId);
  assert.equal(channel.verify(manifest, signatureOf(updates, '1.1.2'), publicKey), true);
  assert.equal(channel.verify({ ...manifest, version: '9.9.9' }, signatureOf(updates, '1.1.2'), publicKey), false);
  assert.equal(channel.verify({ ...manifest, sha256: 'f'.repeat(64) }, signatureOf(updates, '1.1.2'), publicKey), false);
  assert.equal(channel.verify(manifest, Buffer.from('forged').toString('base64'), publicKey), false);
  const other = createUpdateChannel({ dir: path.join(folder(t), 'other') }); other.key();
  assert.equal(channel.verify(manifest, signatureOf(updates, '1.1.2'), pem(other.key().key)), false);
  assert.match(canonicalManifest(manifest), /"version":"1\.1\.2"/);
});
test('update: unsafe distribution content is refused and traversal names never pass validation', (t) => {
  const root = dist(t);
  fs.symlinkSync('/etc/passwd', path.join(root, 'assets/leak.js'));
  const channel = createUpdateChannel({ dir: path.join(folder(t), 'updates') });
  assert.throws(() => channel.pack({ dist: root, version: '1.1.3' }), /Symlink/);
  for (const name of ['../x', 'a/../../b', '/abs', 'a\\b', '', 'a/./b', 'x\u0000y', 'a//b']) assert.equal(safeEntry(name), false, name);
  assert.equal(safeEntry('assets/app-1.2.3.js'), true);
  assert.throws(() => channel.pack({ dist: root, version: 'not-a-version' }), /Version/);
  assert.throws(() => channel.pack({ dist: path.join(folder(t), 'missing'), version: '1.1.4' }), /index\.html/);
});
test('update: newest valid release wins, and a tampered on-disk bundle stops being offered', (t) => {
  const updates = path.join(folder(t), 'updates'), channel = createUpdateChannel({ dir: updates });
  channel.pack({ dist: dist(t), version: '1.1.0' });
  channel.pack({ dist: dist(t), version: '1.2.0' });
  assert.equal(channel.manifest().version, '1.2.0');
  fs.appendFileSync(path.join(updates, '1.2.0', 'bundle.zip'), 'tamper');
  assert.equal(channel.manifest(), null);
  assert.equal(channel.bundle(), null);
  assert.equal(channel.status().latest, null);
});
async function fixture(t) {
  const dir = folder(t);
  const config = { dataDir: dir, host: '127.0.0.1', port: 0, bridgeToken: 'update-fixture-token', dashboardPin: '123456', ownerNumber: '919999999999', agentNumber: '918888888888' };
  const bridge = createBridgeServer({ config, store: { data: { stats: {} } }, whatsapp: { status: () => 'fixture' }, mailbox: { observerOnline: () => false }, actions: {},
    app: { state: () => ({ active: [], pending: [] }), busy: () => false }, runOwner: async () => 'fixture', log: { info() {}, error() {} } });
  const server = await bridge.start();
  t.after(async () => { server.closeAllConnections(); const closed = once(server, 'close'); bridge.stop(); await closed; });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (url, token = 'update-fixture-token') => new Promise((resolve, reject) => {
    http.get(base + url, { headers: token ? { 'x-bridge-token': token } : {} }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  const pair = () => new Promise((resolve, reject) => {
    const req = http.request(base + '/api/app/pair', { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString())));
    });
    req.on('error', reject); req.end(JSON.stringify({ pin: '123456', clientId: 'a1b2c3d4e5f60718', name: 'A53' }));
  });
  return { dir, get, pair };
}
test('update/HTTP: only an authenticated caller receives the bundle, and pairing pins the same key id', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.get('/api/app/update/manifest', null)).status, 401);
  assert.equal((await f.get('/api/app/update/bundle', null)).status, 401);
  assert.equal((await f.get('/api/app/update/manifest')).status, 404, 'nothing packed yet');
  const channel = createUpdateChannel({ dir: path.join(f.dir, 'mobile', 'updates') });
  const { manifest } = channel.pack({ dist: dist(t), version: '1.3.0' });
  const bundle = await f.get('/api/app/update/bundle');
  assert.equal(bundle.status, 200);
  assert.equal(bundle.headers['x-update-version'], '1.3.0');
  assert.equal(bundle.headers['cache-control'], 'no-store');
  assert.equal(createHash('sha256').update(bundle.body).digest('hex'), manifest.sha256);
  const key = JSON.parse((await f.get('/api/app/update/key')).body);
  assert.equal(key.algorithm, 'RSA-3072 SHA-256');
  const paired = await f.pair();
  assert.equal(paired.protocol, 2);
  assert.equal(paired.updateKeyId, key.keyId);
  assert.equal(paired.updateSigningKey, key.key);
  const checked = JSON.parse((await f.get('/api/app/update/manifest')).body);
  assert.equal(checked.keyId, key.keyId);
  assert.equal(channel.verify(checked.manifest, checked.signature, pem(key.key)), true);
  assert.equal(JSON.parse((await f.get('/api/app/update/status')).body).latest, '1.3.0');
});
test('update: a per-device token (not only the legacy root token) can read the signed channel', async (t) => {
  const f = await fixture(t), paired = await f.pair();
  assert.match(paired.token, /^[A-Za-z0-9_-]{20,}$/);
  createUpdateChannel({ dir: path.join(f.dir, 'mobile', 'updates') }).pack({ dist: dist(t), version: '1.3.1' });
  const response = await f.get('/api/app/update/manifest', paired.token);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).manifest.version, '1.3.1');
});
