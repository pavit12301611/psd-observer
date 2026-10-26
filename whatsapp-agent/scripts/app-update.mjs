#!/usr/bin/env node
// Owner-local signed Android web-bundle releases. No repository secrets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createUpdateChannel, canonicalManifest, nextBundleVersion } from '../src/mobile/update.js';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const args = process.argv.slice(2), command = args[0] || 'status';
const flag = (name, fallback = '') => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? '' : fallback; };
const dataDir = path.resolve(root, process.env.DATA_DIR || 'data'), updates = path.join(dataDir, 'mobile', 'updates');
const channel = createUpdateChannel({ dir: updates, currentNative: () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version });
const signingKey = path.join(updates, 'signing', 'update-signing-key.pem');
const when = (file) => { try { return fs.statSync(file).mtime.toISOString(); } catch { return null; } };

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
  // A PC with no app checkout has no dist/, and "dist/index.html is required"
  // says nothing about the one command that builds it. Say that instead.
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.error(`No built app at ${dist}.`);
    console.error('Build and publish in one step with:');
    console.error('  bash scripts/observer.sh update --app --bump');
    process.exit(2);
  }
  const result = channel.pack({ dist, version, notes, minNative });
  console.log(JSON.stringify({ packed: result.manifest, keyId: result.keyId, directory: path.join(updates, version) }, null, 2));
  console.log('Phones fetch this from their paired PC. Native-shell changes are NOT included in a web bundle.');
} else if (command === 'next-version') {
  // The version a phone will actually be offered, and nothing else.
  //
  // Phones only install a bundle newer than the one they already run. The old
  // bump added one patch to the app source's own version — which is the version
  // committed on the branch. A PC with no app checkout rebuilds from that
  // tarball every single time, so it republished the same version forever, the
  // phone was told "not newer than the installed interface", and no update ever
  // appeared no matter how often the owner ran the command.
  //
  // So the next version is the highest of the source version and the highest
  // version already published on this PC, plus one patch. That is monotonic
  // whether or not the PC has a checkout, and it never goes backwards.
  const source = flag('--source', path.join(root, '..', 'app', 'companion', 'package.json'));
  const sourceVersion = () => { try { return JSON.parse(fs.readFileSync(source, 'utf8')).version; } catch { return ''; } };
  const next = nextBundleVersion(sourceVersion(), channel.status().versions || []);
  // Keep the source honest so the bundle it builds cannot claim another version.
  try { const p = JSON.parse(fs.readFileSync(source, 'utf8')); p.version = next; fs.writeFileSync(source, JSON.stringify(p, null, 2) + '\n'); } catch { /* a read-only source still gets the version reported */ }
  console.log(next);
} else if (command === 'doctor') {
  // The phone's own check, done here, in the order the phone does it. Every
  // refusal the phone can give has a different fix, and the app only shows the
  // reason after it has already checked — so a PC that cannot be diagnosed
  // from the PC leaves the owner guessing.
  // Read everything before asking the channel for anything: channel.key()
  // creates a signing key when none exists, and a diagnostic must never be
  // the thing that mints the key a phone is about to be pinned to.
  const keyExists = fs.existsSync(signingKey), keyCreated = when(signingKey);
  const status = channel.status(), manifest = channel.manifest(), signature = channel.signature();
  let keyId = status.keyId, verifies = null;
  if (keyExists) {
    const key = channel.key(); keyId = key.keyId;
    const pub = `-----BEGIN PUBLIC KEY-----\n${key.key.match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----\n`;
    if (manifest && signature) {
      try { verifies = crypto.verify('sha256', Buffer.from(canonicalManifest(manifest), 'utf8'), pub, Buffer.from(signature, 'base64')); } catch { verifies = false; }
    }
  }
  const lines = [];
  const row = (label, value) => lines.push(`  ${label.padEnd(18)}: ${value}`);
  row('signing key', keyId || 'none');
  row('key created', keyCreated || 'never');
  row('offered bundle', status.latest || 'nothing published');
  row('published', (status.versions || []).join(', ') || 'nothing');
  row('signature', verifies === null ? 'no bundle to sign' : verifies ? 'verifies against this key' : 'DOES NOT VERIFY — the bundle is corrupt');
  row('minNative', manifest?.minNative ?? '-');
  row('phone sees', status.latest ? `version ${status.latest}` : 'no update offered');
  console.log('PC update channel\n' + lines.join('\n'));

  console.log('\nOn the phone, the app now shows one of these. Match it to the fix:');
  const fixes = [
    ['Interface <version> is ready from your PC', 'working — tap Install, or it installs itself'],
    ['No signed interface update has been prepared on your PC yet', 'nothing is published: bash scripts/observer.sh update --app --bump'],
    ['not newer than the installed interface', 'the phone already has this version — publish a higher one with --bump'],
    ['signed by a different key', 'the phone is pinned to an older signing key: log out of Observer and pair again'],
    ['needs a newer Observer app', 'native change: one APK install, then updates flow again'],
  ];
  for (const [symptom, fix] of fixes) console.log(`  "${symptom}"\n      -> ${fix}`);

  if (!status.latest) {
    console.log('\nNothing is published yet. This builds and publishes it:');
    console.log('  bash scripts/observer.sh update --app --bump');
  } else if (verifies === false) {
    console.log('\nThe published bundle does not match its own signature. Repack it:');
    console.log('  bash scripts/observer.sh update --app --bump');
  }
} else { console.error('Unknown command. Use status | key | pack | doctor'); process.exit(2); }
