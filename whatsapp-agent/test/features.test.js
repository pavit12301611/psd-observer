// Tests for 2.8.0 — the "trust + reach" batch:
//   /undo · /usage · /watch · /teach · /brief · /resume · /tap · /remote
//   live progress · photo diagnosis (prompt only) · remote screen routes
//
// Everything is offline: no desktop, no WhatsApp, no network, no real model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createJournal, undoReply } from '../src/journal.js';
import { noteUsage, totals, quotaUsed, warnings, usageReport, QUOTAS } from '../src/usage.js';
import * as watch from '../src/watch.js';
import * as macro from '../src/macro.js';
import { buildBrief, scheduleBrief, unscheduleBrief } from '../src/brief.js';
import { createProgress, stepLine, describeHandsStep } from '../src/progress.js';
import { buildWatchPrompt } from '../src/watch.js';
import { Store } from '../src/store.js';
import { runDueJobs, parseCronSchedule } from '../src/cron.js';
import { createAgent } from '../src/commands.js';
import { createBridgeServer, screenTag } from '../src/server.js';
import { buildUpdateMessage } from '../src/updates.js';

const silent = { info() {}, warn() {}, error() {} };
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'observer-feat-'));

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

function makeStore(dir) {
  const store = new Store(path.join(dir, 'store.json'));
  store.data.stats.startedAt = Date.now();
  return store;
}

// ── /undo journal ───────────────────────────────────────────────────────────

test('journal: a write is undone by restoring the previous bytes', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'notes.txt');
    fs.writeFileSync(file, 'purana content');
    const journal = createJournal({ config: { dataDir: path.join(dir, 'data') }, log: silent });
    await journal.wrapWrite(file, () => fs.writeFileSync(file, 'naya content'));
    assert.equal(fs.readFileSync(file, 'utf8'), 'naya content');
    const result = await journal.undo();
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'purana content');
    assert.match(undoReply(result), /Undo ho gaya/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('journal: undoing a new file deletes it', async () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, 'fresh.txt');
    const journal = createJournal({ config: { dataDir: path.join(dir, 'data') }, log: silent });
    await journal.wrapWrite(file, () => fs.writeFileSync(file, 'hello'));
    assert.ok(fs.existsSync(file));
    await journal.undo();
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('journal: move, copy, mkdir and delete all walk back', async () => {
  const dir = tempDir();
  try {
    const journal = createJournal({ config: { dataDir: path.join(dir, 'data') }, log: silent });
    const a = path.join(dir, 'a.txt');
    fs.writeFileSync(a, 'A');

    const moved = path.join(dir, 'b.txt');
    await journal.wrapMove(a, moved, () => fs.renameSync(a, moved));
    await journal.undo();
    assert.ok(fs.existsSync(a), 'move undone');

    const copy = path.join(dir, 'c.txt');
    await journal.wrapCopy(a, copy, () => fs.copyFileSync(a, copy));
    await journal.undo();
    assert.equal(fs.existsSync(copy), false, 'copy deleted');

    const folder = path.join(dir, 'newdir');
    await journal.wrapMkdir(folder, () => fs.mkdirSync(folder));
    await journal.undo();
    assert.equal(fs.existsSync(folder), false, 'empty dir removed');

    await journal.wrapDelete(a, () => fs.rmSync(a));
    assert.equal(fs.existsSync(a), false);
    await journal.undo();
    assert.equal(fs.readFileSync(a, 'utf8'), 'A', 'delete restored from backup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('journal: undo on an empty journal says so instead of throwing', async () => {
  const dir = tempDir();
  try {
    const journal = createJournal({ config: { dataDir: path.join(dir, 'data') }, log: silent });
    const result = await journal.undo();
    assert.equal(result.ok, false);
    assert.match(undoReply(result), /khali/);
    assert.match(journal.describe(), /khali/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('updates: the message keeps a title plus six bullets, not five', () => {
  const text = buildUpdateMessage({
    from: '2.7.0',
    to: '2.8.0',
    seconds: 62,
    changes: ['*title*', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'],
  });
  const bullets = text.split('\n').filter((l) => l.startsWith('• '));
  assert.equal(bullets.length, 7, 'title + six changes');
  assert.ok(!bullets.some((b) => b.includes('seven')), 'the oldest change is dropped');
  assert.match(text, /2\.7\.0 → 2\.8\.0 · 1m 2s/);
});

test('updates: a phone bundle published with the same update is announced, and its absence is silent', () => {
  const withApp = buildUpdateMessage({
    from: '2.7.0', to: '2.8.0', seconds: 5, changes: ['one'],
    app: { version: '1.5.1' },
  });
  assert.match(withApp, /📱 \*Phone app 1\.5\.1\* bhi ready hai/);
  assert.match(withApp, /APK install ki zaroorat nahi/);
  const withoutApp = buildUpdateMessage({
    from: '2.7.0', to: '2.8.0', seconds: 5, changes: ['one'],
  });
  assert.ok(!withoutApp.includes('Phone app'), 'no bundle, no phone line');
});

// ── /usage ──────────────────────────────────────────────────────────────────

test('usage: counts per model and per provider for the day', () => {
  const store = { data: {}, save() {} };
  for (let i = 0; i < 5; i++) noteUsage(store, 'groq:openai/gpt-oss-120b', { ok: true, ms: 400 });
  noteUsage(store, 'groq:openai/gpt-oss-120b', { ok: false, ms: 900 });
  noteUsage(store, 'gemini:gemini-3.8-flash', { ok: true, ms: 300 });
  const t = totals(store);
  assert.equal(t.calls, 7);
  assert.equal(t.ok, 6);
  assert.equal(t.fail, 1);
  assert.equal(t.byProvider.groq, 6);
  assert.equal(t.byProvider.gemini, 1);
});

test('usage: warns at 80% of a known quota, stays quiet for unpublished ones', () => {
  const store = { data: {}, save() {} };
  for (let i = 0; i < 800; i++) noteUsage(store, 'groq:openai/gpt-oss-20b', { ok: true, ms: 10 });
  for (let i = 0; i < 200; i++) noteUsage(store, 'gemini:gemini-3.8-flash', { ok: true, ms: 10 });
  assert.ok(Math.abs(quotaUsed(store, 'groq') - 0.8) < 0.001);
  assert.equal(quotaUsed(store, 'gemini'), null, 'Gemini publishes no daily limit');
  const warn = warnings(store);
  assert.equal(warn.length, 1);
  assert.match(warn[0], /groq/i);
  assert.match(warn[0], /80%/);
  assert.equal(QUOTAS.openrouter.perDay, 50);
});

test('usage: report shows the day, models and limits', () => {
  const store = { data: {}, save() {} };
  noteUsage(store, 'groq:openai/gpt-oss-120b', { ok: true, ms: 1200 });
  const text = usageReport(store, { catalog: [{}, {}] });
  assert.match(text, /AI usage/);
  assert.match(text, /gpt-oss-120b/);
  assert.match(text, /2 brains configured/);
});

// ── /watch ──────────────────────────────────────────────────────────────────

test('watch: args parse list, stop, once and every', () => {
  assert.equal(watch.parseWatchArgs('').action, 'list');
  assert.equal(watch.parseWatchArgs('list').action, 'list');
  assert.equal(watch.parseWatchArgs('stop all').all, true);
  assert.equal(watch.parseWatchArgs('stop 2').id, '2');
  const once = watch.parseWatchArgs('once jab build complete ho');
  assert.equal(once.action, 'add');
  assert.equal(once.once, true);
  assert.match(once.condition, /build complete/);
  const every = watch.parseWatchArgs('every 2m OTP box khali hai');
  assert.equal(every.everyMs, 120_000);
  assert.equal(every.condition, 'OTP box khali hai');
  assert.equal(watch.parseWatchArgs('x').action, 'invalid');
});

test('watch: YES/NO/MAYBE parsing is strict (no accidental alerts)', () => {
  assert.equal(watch.parseWatchDecision('YES').hit, true);
  assert.equal(watch.parseWatchDecision('haan, download ho gaya').hit, true);
  assert.equal(watch.parseWatchDecision('NO').hit, false);
  assert.equal(watch.parseWatchDecision('nahi hua').hit, false);
  assert.equal(watch.parseWatchDecision('MAYBE').hit, false);
  assert.equal(watch.parseWatchDecision('').hit, false);
  assert.equal(watch.parseWatchDecision('{"hit":true,"why":"bar dikh gayi"}').hit, true);
});

test('watch: add, list and remove survive in the store', () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    const w = watch.addWatcher(store, { condition: 'download khatam', everyMs: 60_000 });
    assert.equal(watch.watchers(store).length, 1);
    assert.match(watch.describeWatcher(w, 0), /#1 download khatam/);
    assert.equal(watch.removeWatcher(store, '1').id, w.id);
    assert.equal(watch.watchers(store).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('watch: a YES sends the screenshot, a NO stays silent', async () => {
  const image = Buffer.from('fake-png');
  const deps = {
    observe: async () => ({ image, size: { width: 100, height: 100 } }),
    shrink: async () => ({ image: Buffer.from('small'), mime: 'image/jpeg' }),
  };
  const watcher = { id: 'w1', condition: 'build green', everyMs: 60_000 };

  const yes = await watch.checkWatcher(watcher, {
    config: {}, log: silent, deps: { ...deps, think: async () => 'YES' },
  });
  assert.equal(yes.hit, true);
  assert.equal(yes.image, image);

  const no = await watch.checkWatcher(watcher, {
    config: {}, log: silent, deps: { ...deps, think: async () => 'NO' },
  });
  assert.equal(no.hit, false);

  const broken = await watch.checkWatcher(watcher, {
    config: {}, log: silent, deps: { ...deps, think: async () => null },
  });
  assert.equal(broken.hit, false);
  assert.match(broken.error, /jawab nahi/);
});

test('watch: prompt forces one-word answers', () => {
  const prompt = buildWatchPrompt('build fail ho gaya');
  assert.match(prompt, /build fail ho gaya/);
  assert.match(prompt, /YES/);
  assert.match(prompt, /exactly one word/);
});

// ── /teach ──────────────────────────────────────────────────────────────────

test('teach: records only commands, then saves a replayable macro', () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    assert.equal(macro.startRecording(store, 'morning').ok, true);
    assert.ok(macro.recordStep(store, 'open', 'chrome'));
    assert.ok(macro.recordStep(store, 'pc', 'type hello'));
    assert.equal(macro.recordStep(store, 'teach', 'stop'), null, 'teach itself is never recorded');
    assert.match(macro.teachStatusText(store), /1\. \/open chrome/);

    const saved = macro.stopRecording(store);
    assert.equal(saved.ok, true);
    assert.equal(saved.name, 'morning');
    const entry = store.getLearned('morning');
    assert.equal(entry.commands.length, 2);
    assert.equal(macro.recording(store), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('teach: parse start/stop/cancel/delete and reject reserved names', () => {
  assert.deepEqual(macro.parseTeachArgs('start work'), { action: 'start', name: 'work' });
  assert.equal(macro.parseTeachArgs('stop').action, 'stop');
  assert.equal(macro.parseTeachArgs('cancel').action, 'cancel');
  assert.equal(macro.parseTeachArgs('delete work').action, 'delete');
  assert.equal(macro.parseTeachArgs('list').action, 'list');

  const store = { data: {}, save() {}, getLearned: () => null };
  assert.equal(macro.startRecording(store, 'help').ok, false, 'reserved command name');
});

test('teach: replay runs each step in order through the command runner', async () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    macro.startRecording(store, 'demo');
    macro.recordStep(store, 'open', 'chrome');
    macro.recordStep(store, 'screenshot', '');
    macro.stopRecording(store);

    const seen = [];
    const result = await macro.replayMacro(store, 'demo', async (cmd, args) => {
      seen.push(`${cmd}:${args}`);
      return `did ${cmd}`;
    });
    assert.deepEqual(seen, ['open:chrome', 'screenshot:']);
    assert.match(result.text, /2 steps/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── /brief ──────────────────────────────────────────────────────────────────

test('brief: pulls reminders, todos, jobs and watchers into one message', () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    const now = Date.now();
    store.data.reminders = [
      { id: 1, text: 'pani piyo', dueTs: now - 60_000 },
      { id: 2, text: 'standup', dueTs: now + 3_600_000 },
    ];
    store.data.todos = [{ id: 1, text: 'thesis likho', done: false }];
    store.data.cronJobs = [{ id: 1, text: 'water plants', nextDueTs: now + 7_200_000 }];
    watch.addWatcher(store, { condition: 'build green' });

    const text = buildBrief({ store, config: { timezone: 'Asia/Kolkata' }, now });
    assert.match(text, /Overdue/);
    assert.match(text, /pani piyo/);
    assert.match(text, /standup/);
    assert.match(text, /thesis likho/);
    assert.match(text, /water plants/);
    assert.match(text, /build green/);
    assert.match(text, /Disk/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('brief: an empty store still greets instead of showing nothing', () => {
  const store = { data: {} };
  const text = buildBrief({ store, config: {}, now: Date.now() });
  assert.ok(text.length > 20);
  assert.match(text, /Kuch pending nahi/);
});

test('brief: schedule/unschedule a daily job', () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    assert.equal(scheduleBrief(store, '9am').at, '9am');
    store.addCronJob('/brief', 'every day at 9am', { kind: 'daily', hour: 9, minute: 0 }, Date.now() + 1000);
    assert.equal(unscheduleBrief(store), true);
    assert.equal(unscheduleBrief(store), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── live progress ───────────────────────────────────────────────────────────

test('progress: one line per step, throttled so it cannot spam', async () => {
  const sent = [];
  let clock = 0;
  const progress = createProgress({
    send: async (text) => { sent.push(text); },
    label: 'Hands',
    total: 8,
    now: () => clock,
    log: silent,
  });
  assert.equal(await progress.step({ n: 1, action: 'click Search' }), false, 'first seconds stay quiet');
  clock = 4000;
  assert.equal(await progress.step({ n: 1, action: 'click Search' }), true);
  clock = 5000;
  assert.equal(await progress.step({ n: 2, action: 'type' }), false, 'throttled');
  clock = 12_000;
  assert.equal(await progress.step({ n: 3, action: 'key Enter', detail: 'enter dabaya' }), true);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /Hands/);
  assert.match(sent[0], /1\/8/);
  assert.match(sent[1], /enter dabaya/);
});

test('progress: a failing send disables progress but never throws', async () => {
  let calls = 0;
  let clock = 0;
  const progress = createProgress({
    send: async () => { calls += 1; throw new Error('whatsapp down'); },
    label: 'Hands', now: () => clock, log: silent,
  });
  clock = 10_000;
  assert.equal(await progress.step({ n: 1, action: 'click' }), false);
  assert.equal(await progress.step({ n: 2, action: 'click' }), false);
  assert.equal(calls, 1, 'stops after the first failure');
});

test('progress: step lines stay short and describe hands actions', () => {
  assert.match(stepLine({ label: 'Hands', n: 2, total: 8, action: 'click', startedMs: 9000 }), /2\/8 · 9s/);
  assert.deepEqual(
    describeHandsStep({ action: 'click', thought: 'Search box kholta hoon. Phir type karunga' }),
    { action: 'Search box kholta hoon', detail: '' },
  );
  assert.deepEqual(describeHandsStep({ action: 'type', text: 'hello' }), { action: 'type', detail: 'hello' });
});

// ── new commands through the agent ──────────────────────────────────────────

test('agent: /undo, /usage, /watch, /teach, /brief, /resume, /remote all answer', async () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir);
    const store = makeStore(dir);
    const agent = createAgent({ config, store, log: silent, notify: async () => {} });

    assert.match(await agent.handle('/undo list'), /Undo journal/);
    assert.match(await agent.handle('/usage'), /AI usage/);
    assert.match(await agent.handle('/watch list'), /watch|Watches/);

    const started = await agent.handle('/teach start demo');
    assert.match(started, /Recording shuru/);
    await agent.handle('/usage');
    const stopped = await agent.handle('/teach stop');
    assert.match(stopped, /Sikha diya/);
    assert.ok(store.getLearned('demo'));
    assert.ok(store.getLearned('demo').commands.some((c) => c.cmd === 'usage'));

    assert.match(await agent.handle('/brief'), /Disk|Kuch pending|Subah|Shaam|Raat|Dopahar|Shubh/);
    assert.match(await agent.handle('/resume'), /adhoora|Koi adhoora/);
    assert.match(await agent.handle('/remote'), /Kahin se bhi control/);
    assert.match(await agent.handle('/tap'), /Tap/);
    assert.match(await agent.handle('/help'), /\/watch/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent: /resume is refused when nothing was interrupted, and reports a finished task', async () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir);
    const store = makeStore(dir);
    const agent = createAgent({ config, store, log: silent });
    assert.match(await agent.handle('/resume'), /Koi adhoora kaam nahi/);

    store.data.lastTask = { kind: 'use', text: 'YouTube kholo', done: true, doneTs: Date.now() - 5000, ts: Date.now() - 9000 };
    await new Promise((r) => setTimeout(r, 4100)); // dedup window is 4s
    assert.match(await agent.handle('/resume'), /poora ho gaya/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent: /brief on schedules a daily 9am job that feeds /brief', async () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir);
    const store = makeStore(dir);
    const agent = createAgent({ config, store, log: silent });
    const reply = await agent.handle('/brief on 9am');
    assert.match(reply, /Morning brief on/);
    const job = store.data.cronJobs.find((j) => j.text === '/brief');
    assert.ok(job, 'cron job created');
    assert.equal(job.schedule.kind, 'daily');
    assert.equal(job.schedule.hour, 9);
    assert.equal(job.schedule.minute, 0);
    assert.ok(job.nextDueTs > Date.now());
    assert.ok(job.nextDueTs - Date.now() <= 86_400_000, 'next 9am within a day');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cron: a "/brief" job runs through the agent, a text job stays a reminder', async () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    const schedule = parseCronSchedule('roz 9 baje /brief');
    store.addCronJob('/brief', schedule.scheduleRaw, schedule.schedule, Date.now() - 1000);
    const schedule2 = parseCronSchedule('roz 10 baje pani piyo');
    store.addCronJob('pani piyo', schedule2.scheduleRaw, schedule2.schedule, Date.now() - 1000);

    const sent = [];
    const ran = [];
    const fired = await runDueJobs(
      store,
      async (message) => { sent.push(message); },
      silent,
      async (text) => { ran.push(text); return '🌅 brief body'; },
      Date.now(),
    );
    assert.equal(fired.length, 2);
    assert.deepEqual(ran, ['/brief'], 'only the command job went through the agent');
    assert.ok(sent.includes('🌅 brief body'));
    assert.ok(sent.some((m) => typeof m === 'string' && m.includes('pani piyo')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── remote screen routes ────────────────────────────────────────────────────

/** Smallest buffer that passes pngSize(): signature + IHDR width/height. */
function fakePng(width, height) {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer;
}

test('bridge: screenTag is stable per frame and changes with the pixels', () => {
  const a = fakePng(100, 50);
  const b = fakePng(100, 51);
  assert.equal(screenTag(a), screenTag(Buffer.from(a)));
  assert.notEqual(screenTag(a), screenTag(b));
  assert.match(screenTag(a), /^"[0-9a-f]{20}"$/);
});

test('bridge: the screen is captured on request only, and taps reuse its size', async () => {
  const dir = tempDir();
  const config = makeConfig(dir, {
    port: 0, host: '127.0.0.1', bridgeToken: 'tok-123', dashboardPin: '4321', allowPcControl: true,
  });
  const calls = { capture: 0, click: [], key: [], type: [] };
  const screen = {
    capture: async () => { calls.capture += 1; return fakePng(1000, 500); },
    click: async (x, y) => { calls.click.push([x, y]); },
    key: async (combo) => { calls.key.push(combo); },
    type: async (text) => { calls.type.push(text); },
  };
  const whatsapp = { status: () => 'connected', state: {}, sendToOwner: async () => {} };
  const mailbox = { observerOnline: () => false, listen: async () => [] };
  const bridge = createBridgeServer({
    config, store: makeStore(dir), whatsapp, mailbox, actions: null, log: silent, screen,
  });
  const server = await bridge.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { 'x-bridge-token': 'tok-123' };
  try {
    assert.equal(calls.capture, 0, 'nothing is captured just by starting the server');

    const first = await fetch(`${base}/api/screen`, { headers: auth });
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('x-screen-width'), '1000');
    assert.equal(first.headers.get('x-screen-height'), '500');
    const tag = first.headers.get('etag');
    assert.ok(tag, 'frame carries an etag');
    await first.arrayBuffer();
    assert.equal(calls.capture, 1);

    // Same frame again: 304, so the phone keeps the image it already has.
    const again = await fetch(`${base}/api/screen`, { headers: { ...auth, 'if-none-match': tag } });
    assert.equal(again.status, 304);
    assert.equal(calls.capture, 2, 'still one capture per explicit request, never a loop');

    // A tap must NOT take its own screenshot — it uses the frame's size.
    const before = calls.capture;
    const tap = await fetch(`${base}/api/tap`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ x: 500, y: 500, relative: true }),
    });
    assert.equal(tap.status, 200);
    const tapped = await tap.json();
    assert.deepEqual({ x: tapped.x, y: tapped.y }, { x: 500, y: 250 });
    assert.deepEqual(calls.click, [[500, 250]]);
    assert.equal(calls.capture, before, 'tap added zero screenshots');

    const key = await fetch(`${base}/api/key`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ key: 'ctrl+l' }),
    });
    assert.equal(key.status, 200);
    assert.deepEqual(calls.key, ['ctrl+l']);

    const typed = await fetch(`${base}/api/type`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hello' }),
    });
    assert.equal(typed.status, 200);
    assert.deepEqual(calls.type, ['hello']);
  } finally {
    bridge.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge: PC control off means no screen and no tap at all', async () => {
  const dir = tempDir();
  const config = makeConfig(dir, {
    port: 0, host: '127.0.0.1', bridgeToken: 'tok-123', dashboardPin: '4321', allowPcControl: false,
  });
  const whatsapp = { status: () => 'connected', state: {}, sendToOwner: async () => {} };
  const mailbox = { observerOnline: () => false, listen: async () => [] };
  const bridge = createBridgeServer({
    config, store: makeStore(dir), whatsapp, mailbox, actions: null, log: silent,
    screen: { capture: async () => fakePng(10, 10), click: async () => {}, key: async () => {}, type: async () => {} },
  });
  const server = await bridge.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const auth = { 'x-bridge-token': 'tok-123' };
    assert.equal((await fetch(`${base}/api/screen`, { headers: auth })).status, 403);
    assert.equal((await fetch(`${base}/api/tap`, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ x: 1, y: 1 }),
    })).status, 403);
  } finally {
    bridge.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bridge: remote screen + tap routes are token-protected', async () => {
  const dir = tempDir();
  const config = makeConfig(dir, {
    port: 0,
    host: '127.0.0.1',
    bridgeToken: 'tok-123',
    dashboardPin: '4321',
    allowPcControl: true,
  });
  const whatsapp = {
    status: () => 'connected',
    state: {},
    sendToOwner: async () => {},
  };
  const mailbox = { observerOnline: () => false, listen: async () => [] };
  const bridge = createBridgeServer({ config, store: makeStore(dir), whatsapp, mailbox, actions: null, log: silent });
  const server = await bridge.start();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const unauth = await fetch(`${base}/api/screen`);
    assert.equal(unauth.status, 401, 'no token, no screen');

    const status = await fetch(`${base}/api/status`, { headers: { 'x-bridge-token': 'tok-123' } });
    assert.equal(status.status, 200);

    const tapNoBody = await fetch(`${base}/api/tap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': 'tok-123' },
      body: JSON.stringify({}),
    });
    // No screenshot backend in CI, so this either 400s (no coords) or 500s
    // (no display) — never 200, and never unauthenticated.
    assert.ok([400, 500].includes(tapNoBody.status), `unexpected ${tapNoBody.status}`);
  } finally {
    bridge.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
