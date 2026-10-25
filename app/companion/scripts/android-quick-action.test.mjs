// Static checks on the native quick-action path. The service runs from the
// tile and the widget with no app UI in front of it, so the safety of what it
// can send has to be provable from the source, not from a tap test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../android/app/src/main');
const read = (name) => fs.readFileSync(path.join(dir, 'java/in/observer/companion', name), 'utf8');
const service = read('QuickActionService.java');
const tile = read('ObserverTile.java');
const widget = read('ObserverWidget.java');
const features = read('PhoneFeatures.java');
const manifest = fs.readFileSync(path.join(dir, 'AndroidManifest.xml'), 'utf8');

test('the quick action can only ever send a fixed read-only allowlist', () => {
  const allowed = service.match(/static final String\[\] ALLOWED = \{([^}]*)\}/)[1]
    .split(',').map((s) => s.trim().replaceAll('"', '')).filter(Boolean);
  assert.ok(allowed.length >= 6, `expected a real allowlist, got ${allowed.length}`);
  for (const command of allowed) assert.match(command, /^\/[a-z]+$/);
  // Every command the list carries is a report, never a mutation.
  for (const forbidden of ['/rm', '/run', '/approve', '/yes', '/send', '/write', '/shutdown', '/open'])
    assert.ok(!allowed.includes(forbidden), `${forbidden} must never be a quick action`);
  // The service refuses anything outside the list.
  assert.match(service, /for \(String allowed : ALLOWED\) if \(allowed\.equals\(value\)\) return value;/);
});

test('the quick action never logs or embeds the bridge token', () => {
  assert.ok(!/Log\.[a-z]\([^)]*token/i.test(service), 'no logging of the token');
  // The token is read from the encrypted vault, never from an intent extra.
  assert.match(service, /new SecureVault\(this\)\.get\("profile"\)/);
  assert.ok(!/getStringExtra\("token"\)/.test(service));
});

test('the tile and widget start the same foreground service, never a raw activity call', () => {
  assert.match(tile, /startForegroundService\(new Intent\(c,QuickActionService\.class\)\)/);
  assert.match(widget, /PendingIntent\.getForegroundService/);
  assert.ok(!tile.includes('startService('), 'a background start would be refused');
});

test('the manifest declares the service with the foreground type Android 14 requires', () => {
  assert.match(manifest, /<service android:name="\.QuickActionService"[^>]*foregroundServiceType="dataSync"/);
  assert.match(manifest, /FOREGROUND_SERVICE_DATA_SYNC/);
});

test('the app can only choose a command from the same allowlist', () => {
  assert.match(features, /setQuickAction[\s\S]{0,400}?QuickActionService\.ALLOWED/);
  assert.match(features, /getQuickAction/);
});
