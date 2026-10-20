// Tests for screenshot auto-deletion (2.8.2) — the "screenshot bhej diya, ab
// uska use nahi" cleanup.
//
// No desktop, no WhatsApp: every folder is a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ttlSeconds,
  cleanupEnabled,
  createShotJanitor,
  startShotJanitor,
  describeJanitor,
  cleanNow,
  cleanupReply,
  trackScreenshot,
  takePending,
  DEFAULT_TTL_MINUTES,
  MIN_TTL_MINUTES,
  MAX_TTL_MINUTES,
} from '../src/screenshots.js';
import { Store } from '../src/store.js';
import { createAgent } from '../src/commands.js';

const silent = { info() {}, warn() {}, error() {} };
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'observer-shots-'));

function makeConfig(dir, overrides = {}) {
  return {
    ownerNumber: '919528923866',
    agentNumber: '918859555795',
    timezone: 'Asia/Kolkata',
    accessLevel: 'full',
    dataDir: dir,
    storeFile: path.join(dir, 'store.json'),
    downloadsDir: path.join(dir, 'downloads'),
    sharedDir: path.join(dir, 'shared'),
    filesExtraRoots: [],
    ...overrides,
  };
}

function pngFile(dir, name = `observer-shot-${Date.now()}.png`, bytes = 2048) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

test('shots: TTL defaults to 4 minutes and stays inside 2–5 unless forced', () => {
  assert.equal(ttlSeconds({}), DEFAULT_TTL_MINUTES * 60);
  assert.equal(ttlSeconds({ screenshotTtlMinutes: 2 }), 120);
  assert.equal(ttlSeconds({ screenshotTtlMinutes: 5 }), 300);
  assert.equal(ttlSeconds({ screenshotTtlMinutes: '3' }), 180);
  // Nonsense input falls back to the default instead of deleting instantly.
  assert.equal(ttlSeconds({ screenshotTtlMinutes: 0 }), DEFAULT_TTL_MINUTES * 60);
  assert.equal(ttlSeconds({ screenshotTtlMinutes: -9 }), DEFAULT_TTL_MINUTES * 60);
  // A hard clamp keeps someone from setting "delete after 3 seconds".
  assert.equal(ttlSeconds({ screenshotTtlMinutes: 0.01 }), 60);
  assert.equal(ttlSeconds({ screenshotTtlMinutes: 999 }), 1800);
  assert.ok(MIN_TTL_MINUTES <= DEFAULT_TTL_MINUTES && DEFAULT_TTL_MINUTES <= MAX_TTL_MINUTES);
});

test('shots: cleanup can be turned off and nothing is deleted', () => {
  assert.equal(cleanupEnabled({}), true);
  assert.equal(cleanupEnabled({ screenshotCleanup: false }), false);
  assert.equal(cleanupEnabled({ screenshotCleanup: 'false' }), false);
  assert.equal(cleanupEnabled({ screenshotCleanup: 'true' }), true);

  const dir = tempDir();
  try {
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const file = pngFile(tmp);
    const janitor = createShotJanitor({ config: makeConfig(dir, { screenshotCleanup: false }), log: silent });
    janitor.track({ path: file, kind: 'tmp', ts: Date.now() - 3_600_000 });
    const result = janitor.cleanup({ ttl: 120, ts: Date.now(), tmpDir: tmp, pictures: [] });
    assert.equal(result.deleted, 0);
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shots: a fresh screenshot survives, an old one is deleted after the TTL', () => {
  const dir = tempDir();
  try {
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const now = Date.now();
    const fresh = pngFile(tmp, 'observer-shot-1.png');
    const old = pngFile(tmp, 'observer-shot-2.png', 4096);
    fs.utimesSync(old, new Date(now - 10 * 60_000), new Date(now - 10 * 60_000));

    const janitor = createShotJanitor({ config: makeConfig(dir), log: silent });
    janitor.track({ path: fresh, kind: 'tmp', ts: now });
    janitor.track({ path: old, kind: 'tmp', ts: now - 10 * 60_000 });

    const early = janitor.cleanup({ ttl: 240, ts: now + 60_000, tmpDir: tmp, pictures: [] });
    assert.equal(early.deleted, 1, 'only the old one');
    assert.equal(early.kept, 1);
    assert.equal(early.bytes, 4096);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(fresh), true);

    // Past the TTL the fresh one goes too.
    const later = janitor.cleanup({ ttl: 240, ts: now + 5 * 60_000, tmpDir: tmp, pictures: [] });
    assert.equal(later.deleted, 1);
    assert.equal(fs.existsSync(fresh), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shots: the ledger survives a restart, so old portal files still get cleaned', () => {
  const dir = tempDir();
  try {
    const pictures = path.join(dir, 'Pictures');
    fs.mkdirSync(pictures);
    const shot = path.join(pictures, 'Screenshot from 2026-10-20 12-00-00.png');
    fs.writeFileSync(shot, Buffer.alloc(1024, 1));
    const now = Date.now();
    fs.utimesSync(shot, new Date(now - 15 * 60_000), new Date(now - 15 * 60_000));

    const config = makeConfig(dir);
    // First process captured it...
    takePending();
    trackScreenshot(shot, { kind: 'pictures', ts: now - 15 * 60_000 });
    const first = createShotJanitor({ config, log: silent });
    first.cleanup({ ttl: 240, ts: now - 14 * 60_000, tmpDir: os.tmpdir(), pictures: [pictures] });
    assert.ok(fs.existsSync(shot), 'not old enough yet');

    // ...then restarted. A new janitor reads data/shots.json.
    const second = createShotJanitor({ config, log: silent });
    const result = second.cleanup({ ttl: 240, ts: now, tmpDir: os.tmpdir(), pictures: [pictures] });
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(shot), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shots: crash leftovers in the temp dir are swept by name, but nothing else', () => {
  const dir = tempDir();
  try {
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const now = Date.now();
    const leftover = pngFile(tmp, 'observer-shot-999.png');
    const freshLeftover = pngFile(tmp, 'observer-shot-1000.png');
    const ownerFile = path.join(tmp, 'mera-important.png');
    fs.writeFileSync(ownerFile, Buffer.alloc(10, 1));
    const unrelated = path.join(tmp, 'observer-shot-notes.txt');
    fs.writeFileSync(unrelated, 'not a png');
    for (const file of [leftover, ownerFile, unrelated]) {
      fs.utimesSync(file, new Date(now - 30 * 60_000), new Date(now - 30 * 60_000));
    }

    const janitor = createShotJanitor({ config: makeConfig(dir), log: silent });
    const result = janitor.cleanup({ ttl: 240, ts: now, tmpDir: tmp, pictures: [] });
    assert.equal(result.swept, 1, 'only the old observer-shot png');
    assert.equal(fs.existsSync(leftover), false);
    assert.equal(fs.existsSync(freshLeftover), true, 'newer than the TTL');
    assert.equal(fs.existsSync(ownerFile), true, 'owner files are never touched');
    assert.equal(fs.existsSync(unrelated), true, 'wrong extension');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shots: a tracked path outside the allowed folders is ignored (no rm surprises)', () => {
  const dir = tempDir();
  try {
    const tmp = path.join(dir, 'tmp');
    const pictures = path.join(dir, 'Pictures');
    fs.mkdirSync(tmp);
    fs.mkdirSync(pictures);
    const outside = path.join(dir, 'precious.png');
    fs.writeFileSync(outside, Buffer.alloc(100, 1));
    const wrongName = path.join(tmp, 'notes.png');
    fs.writeFileSync(wrongName, Buffer.alloc(100, 1));
    const old = new Date(Date.now() - 3_600_000);
    fs.utimesSync(outside, old, old);
    fs.utimesSync(wrongName, old, old);

    const janitor = createShotJanitor({ config: makeConfig(dir), log: silent });
    janitor.track({ path: outside, kind: 'pictures', ts: old.getTime() });
    janitor.track({ path: wrongName, kind: 'tmp', ts: old.getTime() });
    const result = janitor.cleanup({ ttl: 60, ts: Date.now(), tmpDir: tmp, pictures: [pictures] });
    assert.equal(result.deleted, 0);
    assert.ok(fs.existsSync(outside), 'outside every managed folder');
    assert.ok(fs.existsSync(wrongName), 'not an observer-shot temp file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shots: /shots clean deletes immediately, even before the TTL', () => {
  const dir = tempDir();
  try {
    const pictures = path.join(dir, 'Pictures');
    fs.mkdirSync(pictures);
    const shot = path.join(pictures, 'Screenshot_2026-10-20.png');
    fs.writeFileSync(shot, Buffer.alloc(5000, 2));

    const janitor = createShotJanitor({ config: makeConfig(dir), log: silent });
    janitor.track({ path: shot, kind: 'pictures', ts: Date.now() });
    // Other tests in this file may have queued captures; drain those first so
    // this test only measures its own file.
    takePending();
    const result = cleanNow(janitor, { pictures: [pictures] });
    assert.equal(result.deleted, 1);
    assert.ok(result.bytes >= 5000);
    assert.equal(fs.existsSync(shot), false);
    assert.match(cleanupReply(result), /1 screenshot delete/);
    assert.match(cleanupReply({ deleted: 0, swept: 0, bytes: 0 }), /already saaf|nahi mila/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shots: the report says the TTL and what is waiting', () => {
  const dir = tempDir();
  try {
    const pictures = path.join(dir, 'Pictures');
    fs.mkdirSync(pictures);
    const shot = path.join(pictures, 'Screenshot_1.png');
    fs.writeFileSync(shot, Buffer.alloc(2048, 3));
    const config = makeConfig(dir, { screenshotTtlMinutes: 2 });
    const janitor = createShotJanitor({ config, log: silent });
    janitor.track({ path: shot, kind: 'pictures', ts: Date.now() - 30_000 });

    const text = describeJanitor({ config, file: janitor.file });
    assert.match(text, /Screenshot cleanup: ON/);
    assert.match(text, /2 min/);
    assert.match(text, /1\*? file/);
    assert.match(text, /\/shots clean/);

    const off = describeJanitor({ config: { ...config, screenshotCleanup: false }, file: janitor.file });
    assert.match(off, /OFF/);
    assert.match(off, /SCREENSHOT_CLEANUP=true/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shots: the background loop deletes by itself, then stops quietly', async () => {
  const dir = tempDir();
  try {
    const tmp = path.join(dir, 'tmp');
    fs.mkdirSync(tmp);
    const old = pngFile(tmp, 'observer-shot-777.png');
    const past = new Date(Date.now() - 20 * 60_000);
    fs.utimesSync(old, past, past);

    const logs = [];
    const janitor = createShotJanitor({ config: makeConfig(dir), log: silent });
    const stop = startShotJanitor({
      config: makeConfig(dir),
      log: { info: (m) => logs.push(m), warn() {}, error() {} },
      janitor,
      intervalMs: 5_000,
      tmpDir: tmp,
      pictures: [],
    });
    await new Promise((r) => setTimeout(r, 2600)); // first tick is 2s
    assert.equal(fs.existsSync(old), false, 'deleted by the timer, no command needed');
    assert.ok(logs.some((line) => /deleted 1 screenshot/.test(line)));
    stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('shots: /shots and /shots clean work through the agent', async () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir, { screenshotTtlMinutes: 5 });
    const store = new Store(path.join(dir, 'store.json'));
    const agent = createAgent({ config, store, log: silent });

    const report = await agent.handle('/shots');
    assert.match(report, /Screenshot cleanup: ON/);
    assert.match(report, /5 min/);

    const clean = await agent.handle('/shots clean');
    assert.match(clean, /delete|already saaf/);

    const help = await agent.handle('/help');
    assert.match(help, /\/shots/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
