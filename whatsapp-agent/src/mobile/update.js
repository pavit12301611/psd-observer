// PC-managed Android UI updates: a locally pinned RSA key signs a web bundle,
// so a personal install can receive in-place UI updates without repository
// signing secrets or an APK reinstall. Native-shell changes still need an APK.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { error } from './records.js';

const MAX_FILES = 4000, MAX_UNCOMPRESSED = 64 * 1024 * 1024, MAX_ENTRY = 16 * 1024 * 1024, MAX_BUNDLE = 32 * 1024 * 1024;
const VERSION = /^\d{1,4}\.\d{1,3}\.\d{1,3}$/;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const keyId = (spkiBase64) => sha256(Buffer.from(spkiBase64, 'base64')).slice(0, 32);
export const safeEntry = (name) => typeof name === 'string' && name.length > 0 && name.length <= 180 && !name.startsWith('/') && !name.includes('\\') && !name.includes('\0') && !/[\u0000-\u001f]/.test(name) && !name.split('/').some((part) => part === '' || part === '.' || part === '..');
export function canonicalManifest(manifest) {
  return JSON.stringify({ schema: 1, version: manifest.version, createdAt: manifest.createdAt, sha256: manifest.sha256, size: manifest.size, fileCount: manifest.fileCount, minNative: manifest.minNative, notes: manifest.notes || '' });
}

// Deterministic store-only ZIP: no absolute/generated timestamps, and no
// extraction is performed by the packer itself.
function crcTable() { const table = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c; } return table; }
const CRC = crcTable();
function crc32(buffer) { let c = -1; for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }
export function zipStore(entries) {
  const locals = [], central = []; let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8'), crc = crc32(data), compressed = zlib.deflateRawSync(data, { level: 9 });
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, compressed);
    const dir = Buffer.alloc(46); dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0x21, 14); dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(compressed.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBytes.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBytes); offset += 30 + nameBytes.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(centralBuffer.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

export function createUpdateChannel({ dir, signingDir, now = Date.now, currentNative = () => '0.0.0' } = {}) {
  if (!dir) return { status: () => ({ supported: false }), manifest: () => null, signature: () => null, bundle: () => null, key: () => null };
  const keyFile = path.join(signingDir || path.join(dir, 'signing'), 'update-signing-key.pem');
  const releases = () => {
    let names = []; try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((n) => VERSION.test(n)).map((version) => { const folder = path.join(dir, version); return { version, folder }; })
      .filter(({ folder }) => { try { return fs.statSync(path.join(folder, 'manifest.json')).isFile() && fs.statSync(path.join(folder, 'bundle.zip')).isFile() && fs.statSync(path.join(folder, 'manifest.sig')).isFile(); } catch { return false; } })
      .sort((a, b) => { const x = a.version.split('.').map(Number), y = b.version.split('.').map(Number); return y[0] - x[0] || y[1] - x[1] || y[2] - x[2]; });
  };
  function keys(create = false) {
    const pubFile = path.join(path.dirname(keyFile), 'update-signing-public.pem');
    if (!fs.existsSync(keyFile)) {
      if (!create) return null;
      fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      fs.writeFileSync(keyFile, privateKey, { mode: 0o600, flag: 'wx' }); fs.writeFileSync(pubFile, publicKey, { mode: 0o644, flag: 'wx' });
    }
    const stat = fs.lstatSync(keyFile);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw error(500, 'Private update-signing key must be an owner-only regular file');
    const privateKey = fs.readFileSync(keyFile, 'utf8'), publicKey = fs.readFileSync(pubFile, 'utf8');
    const spki = publicKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return { privateKey, publicKey, spki, keyId: keyId(spki) };
  }
  function current() {
    const list = releases(); if (!list.length) return null;
    const latest = list[0], manifest = JSON.parse(fs.readFileSync(path.join(latest.folder, 'manifest.json'), 'utf8'));
    const bundle = fs.readFileSync(path.join(latest.folder, 'bundle.zip'));
    if (bundle.length > MAX_BUNDLE || bundle.length !== manifest.size || sha256(bundle) !== manifest.sha256) return null;
    return { manifest, bundle };
  }
  return {
    status() {
      const k = keys(false), list = releases();
      return { supported: true, keyId: k?.keyId || null, versions: list.map((r) => r.version).slice(0, 5), latest: current()?.manifest.version || null, native: currentNative(), note: 'Bundles are signed locally on this PC; native APK changes still require an APK install.' };
    },
    key: () => { const k = keys(true); return { key: k.spki, keyId: k.keyId, algorithm: 'RSA-3072 SHA-256' }; },
    manifest: () => current()?.manifest || null,
    signature: () => {
      const offered = current(); if (!offered) return null;
      try { return fs.readFileSync(path.join(dir, offered.manifest.version, 'manifest.sig'), 'utf8').trim(); } catch { return null; }
    },
    bundle: () => current()?.bundle || null,
    /** Called by the owner CLI only: pack a built web directory into a signed release. */
    pack({ dist, version, notes = '', minNative = '1.1.0' }) {
      if (!VERSION.test(version)) throw error(400, 'Version must be X.Y.Z');
      const root = path.resolve(dist); if (!fs.existsSync(path.join(root, 'index.html'))) throw error(400, 'dist/index.html is required');
      const entries = [];
      const walk = (folder, prefix) => { for (const name of fs.readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(folder, name.name), rel = prefix ? `${prefix}/${name.name}` : name.name, stat = fs.lstatSync(full);
        if (stat.isSymbolicLink()) throw error(400, `Symlink not allowed in a web bundle: ${rel}`);
        if (stat.isDirectory()) { walk(full, rel); continue; }
        if (!stat.isFile() || !safeEntry(rel)) throw error(400, `Unsafe bundle entry: ${rel}`);
        if (stat.size > MAX_ENTRY) throw error(400, `Bundle entry too large: ${rel}`);
        entries.push({ name: rel, data: fs.readFileSync(full) });
        if (entries.length > MAX_FILES) throw error(400, 'Too many bundle files');
      } };
      walk(root, '');
      if (!entries.some((e) => e.name === 'index.html')) throw error(400, 'index.html missing');
      const total = entries.reduce((sum, e) => sum + e.data.length, 0);
      if (total > MAX_UNCOMPRESSED) throw error(413, 'Bundle exceeds the uncompressed limit');
      const bundle = zipStore(entries), k = keys(true);
      const manifest = { schema: 1, version, createdAt: new Date(now()).toISOString(), sha256: sha256(bundle), size: bundle.length, fileCount: entries.length, minNative, notes: String(notes).slice(0, 1000) };
      const signature = sign('sha256', Buffer.from(canonicalManifest(manifest)), k.privateKey).toString('base64');
      const target = path.join(dir, version); fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(target, 'bundle.zip'), bundle, { mode: 0o600 }); fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 }); fs.writeFileSync(path.join(target, 'manifest.sig'), signature + '\n', { mode: 0o600 });
      for (const old of releases().slice(3)) fs.rmSync(old.folder, { recursive: true, force: true });
      return { manifest, keyId: k.keyId };
    },
    verify(manifest, signatureBase64, publicKeyPem) {
      try { return verify('sha256', Buffer.from(canonicalManifest(manifest)), publicKeyPem, Buffer.from(signatureBase64, 'base64')); } catch { return false; }
    },
  };
}
