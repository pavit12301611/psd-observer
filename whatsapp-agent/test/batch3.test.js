// batch3.test.js — Features 11-15: Screen Time · Meeting Notes · Clipboard
// Sync · Multi-PC Fleet · Homework Tracker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b3-')), name);

// ═══ 11. 📊 Screen Time ════════════════════════════════════════════════════

test('stats: samples map to app categories and build day/week reports', async () => {
  const st = await import('../src/screentime.js');
  const file = tmpFile('st.json');
  const now = 1_760_000_000_000;
  assert.equal(st.appNameFromTitle('YouTube - Mozilla Firefox'), 'browser');
  assert.equal(st.appNameFromTitle('WhatsApp — Desktop'), 'chat');
  assert.equal(st.appNameFromTitle('main.js - Visual Studio Code'), 'dev tools');

  st.recordSample('YouTube - Firefox', { file, now: () => now });
  st.recordSample('YouTube - Firefox', { file, now: () => now });
  st.recordSample('Google Docs - Chrome', { file, now: () => now });
  st.recordSample('WhatsApp — Desktop', { file, now: () => now });

  const reply = st.todayReply({ file, now: () => now });
  assert.match(reply, /total 20 min/);
  assert.match(reply, /browser: 10 min/);
  assert.match(st.weekReply({ file, now: () => now }), /last 7 days/);
  assert.match(st.toggleSampling(true, { file }), /sampling \*ON\*/);
});

test('stats: empty day is honest', async () => {
  const st = await import('../src/screentime.js');
  assert.match(st.todayReply({ file: tmpFile('empty.json') }), /record nahi hua/);
});

// ═══ 12. 🎙️ Meeting Notes ═════════════════════════════════════════════════

test('notes: start → stop → transcript summarized into notes', async () => {
  const mn = await import('../src/meetingnotes.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-'));
  const file = path.join(dir, 'meeting-test.wav');
  const fakeProc = new EventEmitter();
  fakeProc.kill = () => { fakeProc.killed = true; };

  const start = mn.startNotes({
    spawnRec: (f) => { fs.writeFileSync(f, ''); assert.equal(f, file.replace('meeting-test', path.basename(f).replace('.wav', '')) || true); return fakeProc; },
    dir,
  });
  assert.match(start, /Meeting recording ON/);
  assert.match(mn.notesStatus(), /ON/);

  // double-start refused
  assert.match(mn.startNotes({ spawnRec: () => fakeProc, dir }), /pehle se recording/i);

  const summary = await mn.stopNotes({
    transcribe: async (f) => {
      assert.ok(fs.existsSync(f), 'recorder file handed to transcriber');
      return { text: 'Rahul: we launch on Friday. Priya owns the docs.' };
    },
    summarize: async (t) => {
      assert.match(t, /launch on Friday/);
      return '• Decisions: launch Friday\n• Actions: Priya — docs';
    },
  });
  assert.match(summary, /Meeting notes/);
  assert.match(summary, /launch Friday/);
  assert.equal(fakeProc.killed, true, 'recorder stopped');
  assert.match(mn.notesStatus(), /OFF/);
  assert.match(await mn.stopNotes({}), /Koi recording chal hi nahi/);
});

// ═══ 13. 📋 Clipboard Sync ═════════════════════════════════════════════════

test('clip: pull PC clipboard, push text back, history remembers', async () => {
  const cp = await import('../src/clipboard.js');
  const file = tmpFile('clip.json');
  let pcClipboard = 'meeting at 4pm in room 2';

  const run = async (bin, args, opts = {}) => {
    if (bin === 'wl-paste') {
      if (pcClipboard == null) throw new Error('no wl');
      return { stdout: pcClipboard };
    }
    if (bin === 'wl-copy') {
      pcClipboard = opts.input;
      return { stdout: '' };
    }
    throw new Error(`unexpected ${bin}`);
  };

  const pull = await cp.clipPull({ run, file });
  assert.match(pull, /meeting at 4pm/);
  const push = await cp.clipPush('otp 445566', { run, file });
  assert.match(push, /otp 445566/);
  assert.equal(pcClipboard, 'otp 445566', 'text landed on the PC clipboard');

  const list = cp.clipList({ file });
  assert.match(list, /otp/, 'entry kept');
  assert.doesNotMatch(list, /445566/, '3.7.0: PII redacted in history');
  assert.match(list, /meeting at 4pm/);
});

test('clip: no clipboard tool → honest hint', async () => {
  const cp = await import('../src/clipboard.js');
  const run = async () => { throw new Error('missing'); };
  assert.match(await cp.clipPull({ run, file: tmpFile('c2.json') }), /xclip|wl-clipboard/);
  assert.match(await cp.clipPush('x', { run, file: tmpFile('c3.json') }), /xclip|wl-clipboard/);
});

// ═══ 14. 🖥️ Multi-PC Fleet ════════════════════════════════════════════════

test('pcs: register machines, heartbeats decide alive/dead', async () => {
  const fp = await import('../src/fleetstatus.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-'));
  const now = 5_000_000;

  assert.match(fp.registerPc('gaming-rig', { file: path.join(dir, 'gaming-rig.json') }), /registered/);
  assert.match(fp.registerPc('office-pc', { file: path.join(dir, 'office-pc.json') }), /registered/);
  // office-pc heartbeat fresh, gaming-rig stale
  fs.writeFileSync(path.join(dir, 'office-pc.json'), JSON.stringify({ name: 'office-pc', os: 'linux', at: now - 30_000 }));
  fs.writeFileSync(path.join(dir, 'gaming-rig.json'), JSON.stringify({ name: 'gaming-rig', os: 'linux', at: now - 10 * 60_000 }));

  const reply = fp.fleetReply({ dir, now: () => now });
  assert.match(reply, /1\/2 online/);
  assert.match(reply, /🟢 \*office-pc\*/);
  assert.match(reply, /🔴 \*gaming-rig\*/);
  assert.match(fp.removePc('gaming-rig', { file: path.join(dir, 'gaming-rig.json') }), /hata diya/);
});

test('pcs: empty fleet suggests registering', async () => {
  const fp = await import('../src/fleetstatus.js');
  assert.match(fp.fleetReply({ dir: path.join(os.tmpdir(), 'nope-never') }), /Fleet khaali/);
});

// ═══ 15. 📝 Homework Tracker ═══════════════════════════════════════════════

test('hw: add with due dates, today/week views, done marks', async () => {
  const hw = await import('../src/homework.js');
  const file = tmpFile('hw.json');
  const now = Date.UTC(2026, 9, 22, 5, 0);

  const added = hw.addHw('maths pg 42 kal', { file, now: () => now });
  assert.equal(added.ok, true);
  assert.match(added.reply, /maths pg 42/);
  assert.match(added.reply, /due/);

  hw.addHw('history project pars?o', { file, now: () => now });
  hw.addHw('science diagram', { file, now: () => now }); // default: tonight

  const today = hw.todayReply({ file, now: () => now });
  assert.match(today, /maths pg 42/);
  assert.match(today, /science diagram/);
  assert.match(hw.weekReply({ file, now: () => now }), /history project/);

  assert.match(hw.doneHw('maths', { file }), /Marked done/);
  assert.match(hw.todayReply({ file, now: () => now }), /science diagram/);
  assert.doesNotMatch(hw.weekReply({ file, now: () => now }), /maths pg 42/);
});
