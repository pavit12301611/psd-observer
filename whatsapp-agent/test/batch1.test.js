// batch1.test.js — Features 1-5: Live Mirror · Guard Mode · Notification
// Mirror · Study Pack · Expense Tracker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b1-')), name);

// ═══ 1. 🎥 Live Screen Mirror ═══════════════════════════════════════════════

test('live mirror: streams frames to WhatsApp and stops cleanly', async () => {
  const lm = await import('../src/livemirror.js');
  const sent = [];
  let t = 0;
  const msg = await lm.startLive({
    intervalSec: 3,
    maxFrames: 3,
    maxDurationMs: 3_600_000,
    capture: async () => Buffer.from(`frame${++t}`),
    send: async (p) => { sent.push(p); },
  });
  assert.match(msg, /Live mirror ON/);
  assert.equal(sent.length, 1, 'first frame sent immediately');
  assert.match(sent[0].text, /Live 1/);

  // simulate two more ticks via stop + status state machine
  const status = lm.liveStatus();
  assert.match(status, /ON/);
  assert.match(status, /1\/3/);
  const off = lm.stopLive();
  assert.match(off, /OFF/);
  assert.match(off, /1\/1/);
  assert.match(lm.liveStatus(), /OFF/);
});

test('live mirror: double-start is refused, bad input throws', async () => {
  const lm = await import('../src/livemirror.js');
  const noop = async () => Buffer.from('x');
  const send = async () => {};
  await lm.startLive({ intervalSec: 60, maxFrames: 5, capture: noop, send });
  const again = await lm.startLive({ intervalSec: 60, maxFrames: 5, capture: noop, send });
  assert.match(again, /already ON/);
  lm.stopLive();
  await assert.rejects(() => lm.startLive({ intervalSec: 10 }), /capture\(\) and send\(\)/);
});

// ═══ 2. 🛡️ Guard Mode ══════════════════════════════════════════════════════

test('guard: motion trips an alert with photo, throttled to one per cooldown', async () => {
  const g = await import('../src/guard.js');
  const sent = [];
  let brightness = 100;
  await g.startGuard({
    capture: async () => Buffer.from('cam'),
    statFn: () => ({ mean: brightness }),
    send: async (p) => { sent.push(p); },
    sensitivity: 8,
    intervalMs: 60_000,
  });
  // tick 1: baseline established (no alert)
  assert.equal(await g.guardTick({ capture: async () => Buffer.from('cam'), statFn: () => ({ mean: brightness }), send: async (p) => sent.push(p) }), 'quiet');
  // sudden jump = motion
  brightness = 160;
  const r = await g.guardTick({ capture: async () => Buffer.from('cam'), statFn: () => ({ mean: brightness }), send: async (p) => sent.push(p) });
  assert.equal(r, 'alerted');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Motion detected/);
  assert.ok(sent[0].image, 'alert carries the photo');
  // immediate second jump: throttled by cooldown
  brightness = 40;
  const r2 = await g.guardTick({ capture: async () => Buffer.from('cam'), statFn: () => ({ mean: brightness }), send: async (p) => sent.push(p), now: () => Date.now() + 500 });
  assert.equal(r2, 'quiet');
  assert.equal(sent.length, 1, 'cooldown prevented spam');
  assert.match(g.guardStatus(), /ON/);
  assert.match(g.stopGuard(), /OFF/);
});

test('guard: sensitivity curve — 1 ignores humans, 10 catches ghosts', () => {
  const g = { isMotion: null };
  return import('../src/guard.js').then((mod) => {
    assert.equal(mod.isMotion(5, 1), false, 'tiny delta ignored at sens 1');
    assert.equal(mod.isMotion(5, 10), true, 'tiny delta trips at sens 10');
    assert.equal(mod.isMotion(30, 1), true, 'huge delta trips at any sens');
    assert.equal(mod.isMotion(0.5, 10), false, 'sub-pixel noise never trips');
  });
});

// ═══ 3. 🔔 Notification Mirror ══════════════════════════════════════════════

test('notif mirror: parses gdbus lines, filters allowlist, throttles bursts', async () => {
  const nm = await import('../src/notifmirror.js');
  const line = `/org/freedesktop/Notifications: org.freedesktop.Notifications.Notification (uint32 42, '', 'Slack', 'New message', 'Rahul: meeting at 4', @[] {})`;
  const notif = nm.parseNotificationLine(line);
  assert.deepEqual(notif, { app: 'Slack', summary: 'New message', body: 'Rahul: meeting at 4' });
  assert.equal(nm.parseNotificationLine('random dbus noise'), null);

  assert.equal(nm.allowed(notif, []), true, 'empty allow = all apps');
  assert.equal(nm.allowed(notif, ['slack']), true);
  assert.equal(nm.allowed(notif, ['telegram']), false);

  let t = 1000;
  const throttle = nm.makeThrottle(2, 60_000, () => t);
  assert.equal(throttle(), true);
  assert.equal(throttle(), true);
  assert.equal(throttle(), false, 'third within a minute blocked');
  t += 61_000;
  assert.equal(throttle(), true, 'window slides');
});

test('notif mirror: start/stop lifecycle + allowlist persistence', async () => {
  const nm = await import('../src/notifmirror.js');
  const stateFile = tmpFile('nm.json');
  const sent = [];
  let lines = [];
  const spawnMonitor = (onLine) => { lines = onLine; return { kill() {} }; };
  const msg = await nm.startMirror({ spawnMonitor, send: async (t) => sent.push(t), stateFile });
  assert.match(msg, /Notification mirror ON/);
  lines(`/org/...: org.freedesktop.Notifications.Notification (uint32 1, '', 'Telegram', 'Papa', 'Call karo', @[] {})`);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /\*Telegram\* — Papa/);
  assert.match(nm.setAllow('slack, discord', stateFile), /Allowlist set/);
  assert.match(nm.stopMirror(), /OFF/);
});

// ═══ 4. 📚 Study Pack ══════════════════════════════════════════════════════

test('study: build → save → load pack with flashcards and quiz', async () => {
  const st = await import('../src/studypack.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-'));
  const pack = st.buildPack('Photosynthesis', {
    summary: 'Plants make food using sunlight.',
    flashcards: [
      { q: 'Raw material?', a: 'CO2 + water' },
      { question: 'Where?', a: 'Chloroplast' },
      { q: 'Bad', a: '' }, // filtered out
    ],
    quiz: [{ q: 'Gas released?', options: ['O2', 'CO2', 'N2'], answer: 'O2' }],
  }, 1000);
  assert.equal(pack.flashcards.length, 2, 'invalid cards filtered');
  st.savePack(pack, dir);
  const loaded = st.loadPack('photosynthesis', dir);
  assert.equal(loaded.topic, 'Photosynthesis');
  assert.equal(loaded.flashcards[0].q, 'Raw material?');

  // spaced repetition: due now, review pushes 1 day out, "again" resets
  assert.equal(st.dueCards(loaded, 1000).length, 2);
  const card = st.reviewCard(loaded.flashcards[0], true, 2000);
  assert.equal(card.reviewCount, 1);
  assert.equal(card.nextDue, 2000 + 3 * 86_400_000, 'second rung = 3 days');
  st.reviewCard(card, false, 3000);
  assert.equal(card.reviewCount, 0, 'forgotten = restart ladder');
  assert.match(st.reviseMessage(loaded, 2000), /cards due|sab revise/);
  assert.match(st.quizMessage(loaded), /Gas released/);
  assert.match(st.quizAnswers(loaded), /O2/);
});

// ═══ 5. 💰 Expense Tracker ═════════════════════════════════════════════════

test('expenses: parse, ledger, monthly report, budget alerts, undo', async () => {
  const ex = await import('../src/expenses.js');
  const file = tmpFile('exp.json');
  assert.deepEqual(ex.parseExpense('250 khana'), { amount: 250, note: 'khana' });
  assert.deepEqual(ex.parseExpense('₹120 auto'), { amount: 120, note: 'auto' });
  assert.deepEqual(ex.parseExpense('rs 99.5 recharge'), { amount: 99.5, note: 'recharge' });
  assert.equal(ex.parseExpense('khana 250'), null, 'amount must lead');

  const r = ex.addExpense('250 khana', { file, now: () => Date.UTC(2026, 9, 15) });
  assert.equal(r.ok, true);
  assert.match(r.reply, /Saved: \*₹250\*/);
  ex.addExpense('120 auto', { file, now: () => Date.UTC(2026, 9, 16) });
  ex.addExpense('500 rent', { file, now: () => Date.UTC(2026, 8, 30) }); // September

  assert.equal(ex.monthTotal(ex.loadExpenses(file), '2026-10'), 370);
  const rep = ex.report({ file, now: () => Date.UTC(2026, 9, 20) });
  assert.match(rep, /₹370/);
  assert.match(rep, /khana/);

  ex.setBudget(300, { file });
  const over = ex.addExpense('100 coffee', { file, now: () => Date.UTC(2026, 9, 21) });
  assert.match(over.reply, /Budget 300 cross/, 'over-budget alert');
  assert.match(ex.undoLast({ file }), /Undo/);
  assert.equal(ex.loadExpenses(file).entries.length, 3);
  assert.match(ex.lastEntries(5, { file }), /Last/);
});
