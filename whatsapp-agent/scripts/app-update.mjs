#!/usr/bin/env node
// Owner-local signed Android web-bundle releases. No repository secrets.
import fs from 'node:fs';
import path from 'node:path';
import { createUpdateChannel } from '../src/mobile/update.js';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2), command = args[0] || 'status';
const flag = (name, fallback = '') => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? '' : fallback; };
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data'), updates = path.join(dataDir, 'mobile', 'updates');
const channel = createUpdateChannel({ dir: updates, currentNative: () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version });
if (command === 'status') {
  const status = channel.status(); const key = channel.key(); const manifest = channel.manifest();
  console.log(JSON.stringify({ ...status, publicKey: key.key, latestManifest: manifest }, null, 2));
} else if (command === 'key') {
  const key = channel.key();
  fs.mkdirSync(path.join(dataDir, 'mobile'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dataDir, 'mobile', 'update-public-key.pem'), `-----BEGIN PUBLIC KEY-----\n${key.key.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`, { mode: 0o644 });
  console.log(`Update key id: ${key.keyId}\nPublic key written to ${path.join(dataDir, 'mobile', 'update-public-key.pem')}\nPrivate key stays owner-only in data/mobile/updates/signing/.`);
} else if (command === 'pack') {
  const dist = flag('--dist', path.join(root, '..', 'app', 'companion', 'dist'));
  const notes = flag('--notes'); const minNative = flag('--min-native', '1.1.0');
  // The bundle version is the app's own version by default, so packing right
  // after a build cannot ship a bundle that claims to be something else.
  const appVersion = () => { try { return JSON.parse(fs.readFileSync(path.join(root, '..', 'app', 'companion', 'package.json'), 'utf8')).version; } catch { return ''; } };
  const version = flag('--version') || appVersion();
  if (!version) { console.error('Usage: npm run app:update:pack -- --version 1.1.1 [--dist ./dist] [--notes "text"] [--min-native 1.1.0]'); process.exit(2); }
  const result = channel.pack({ dist, version, notes, minNative });
  console.log(JSON.stringify({ packed: result.manifest, keyId: result.keyId, directory: path.join(updates, version) }, null, 2));
  console.log('Phones fetch this from their paired PC. Native-shell changes are NOT included in a web bundle.');
} else { console.error('Unknown command. Use status | key | pack'); process.exit(2); }
