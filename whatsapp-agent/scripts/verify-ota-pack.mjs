#!/usr/bin/env node
// Verify a packed OTA bundle the way a phone does, so a broken release is
// caught here instead of on a device. Owner-local, no repository secrets.
//
//   node scripts/verify-ota-pack.mjs <pack.json> <version>
//   node scripts/verify-ota-pack.mjs --status <status.json> <version>
//
// The check is the same one the app performs: read manifest.json, read
// manifest.sig, verify it against the public key the PC publishes, and confirm
// the bundle on disk hashes to what the manifest claims.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const usage = () => {
  console.error('Usage: node scripts/verify-ota-pack.mjs <pack.json> <version> | --status <status.json> <version>');
  process.exit(2);
};
const version = args[args.length - 1];
if (args.length < 2 || !/^\d{1,4}\.\d{1,3}\.\d{1,3}$/.test(version || '')) usage();

const fail = (message) => { console.error(`OTA pack check failed: ${message}`); process.exit(1); };
const canonical = (m) => JSON.stringify({
  schema: 1, version: m.version, createdAt: m.createdAt, sha256: m.sha256,
  size: m.size, fileCount: m.fileCount, minNative: m.minNative, notes: m.notes || '',
});
// The packer prints JSON and then a human note, so take the first balanced
// object rather than assuming the whole file is JSON.
const readJsonFirst = (file) => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { fail(`${file} could not be read (${e.message})`); }
  const start = text.indexOf('{');
  if (start < 0) fail(`${file} contains no JSON`);
  let depth = 0, end = -1, quoted = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '\\') i++; else if (ch === '"') quoted = false; continue; }
    if (ch === '"') quoted = true;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) fail(`${file} has no complete JSON object`);
  try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { fail(`${file} is not valid JSON (${e.message})`); }
};

// Same resolution as the packer, so a relocated DATA_DIR is checked too.
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data');
const bundleDir = path.join(dataDir, 'mobile', 'updates', version);
if (!fs.existsSync(bundleDir)) fail(`no packed bundle for ${version} in ${bundleDir}`);
const manifest = readJsonFirst(path.join(bundleDir, 'manifest.json'));
if (manifest.version !== version) fail(`bundle on disk is ${manifest.version}, expected ${version}`);
const signature = fs.readFileSync(path.join(bundleDir, 'manifest.sig'), 'utf8').trim();
const bundle = fs.readFileSync(path.join(bundleDir, 'bundle.zip'));
if (crypto.createHash('sha256').update(bundle).digest('hex') !== manifest.sha256)
  fail('bundle.zip does not hash to the manifest sha256, so a phone would refuse it');
if (bundle.length !== manifest.size) fail(`bundle is ${bundle.length} bytes, manifest says ${manifest.size}`);

// The public key comes from the pack output or the phone-visible status.
let publicKey = null;
if (args[0] === '--status') {
  const status = readJsonFirst(args[1]);
  if (status.latest !== version) fail(`the PC publishes ${status.latest} as latest, so phones would never see ${version}`);
  if (!status.keyId) fail('status carries no key id');
  publicKey = status.publicKey;
} else {
  const pack = readJsonFirst(args[0]);
  if (pack.packed?.version !== version) fail(`pack output says ${pack.packed?.version}`);
  if (!pack.keyId) fail('pack output carries no signing key id');
  // The pack output carries the key id; the public half lives beside the
  // private signing key, exactly where a phone's key check reads it.
  const { createUpdateChannel } = await import('../src/mobile/update.js');
  const key = createUpdateChannel({ dir: path.join(dataDir, 'mobile', 'updates') }).key();
  if (!key) fail('no update signing key found on this PC');
  if (key.keyId !== pack.keyId) fail(`packed with key ${pack.keyId} but this PC publishes ${key.keyId}`);
  publicKey = key.key;
}

if (!publicKey) fail('no public key to verify the signature against');
const pem = `-----BEGIN PUBLIC KEY-----\n${publicKey.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
let verified = false;
try {
  verified = crypto.verify('sha256', Buffer.from(canonical(manifest), 'utf8'), pem, Buffer.from(signature, 'base64'));
} catch (e) { fail(`signature could not be checked (${e.message})`); }
if (!verified) fail('manifest signature does not verify, so a phone would refuse to install');
console.log(`OTA pack check: ${version} verifies (${manifest.fileCount} files, ${bundle.length} bytes, minNative ${manifest.minNative}).`);
