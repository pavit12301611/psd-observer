// batch6.test.js — 3.8.0 mega-round: today timeline, exams, accuracy,
// revision call, study scan, escalating reminders, site blocker, audit,
// nudges, recap, fun, roles, smart home, routines, organizer, backup,
// leave-by, timeline, fleet queue, action items, wake word.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b6-')), name);

test('today: master timeline composes all sources', async () => {
  const { buildToday } = await import('../src/today.js');
  const out = buildToday({
    calToday: () => '🗓️ *Aaj ke events*\n• 4pm — meeting',
    hwToday: () => '📝 *Homework*\n• maths pg 42',
    examCountdown: () => '🎓 *Exams*\n• physics: 5 din',
  });
  assert.match(out, /Aaj ka din/);
  assert.match(out, /meeting/);
  assert.match(out, /maths/);
  assert.match(out, /physics/);
  const calm = buildToday({});
  assert.match(calm, /calm hai/, 'empty day is honest');
});

test('exams: parse, add, countdown, next, remove', async () => {
  const ex = await import('../src/exams.js');
  const file = tmpFile('exams.json');
  const now = Date.UTC(2026, 9, 1);
  const p = ex.parseExam('physics 12 dec', now);
  assert.equal(p.subject, 'physics');
  assert.equal(new Date(p.at).getDate(), 12);
  const r = ex.addExam('physics 12 dec', { file, now: () => now });
  assert.equal(r.ok, true);
  assert.match(r.reply, /din baaki/);
  ex.addExam('maths 2026-12-20', { file, now: () => now });
  const cd = ex.examCountdownReply({ file, now: () => now });
  assert.match(cd, /physics/);
  assert.match(cd, /maths/);
  assert.equal(ex.nextExam({ file, now: () => now }).subject, 'physics');
  assert.match(ex.removeExam('physics', { file }), /hata diya/);
});

test('accuracy: report card from store stats', async () => {
  const ac = await import('../src/accuracyreport.js');
  const store = { data: { accuracyStats: { asked: 20, verifiedAnswers: 15, deterministicHits: 3, corrections: 2 } } };
  const out = ac.accuracyReport(store);
  assert.match(out, /Sawaal aaye: 20/);
  assert.match(out, /90%/, 'hit rate computed');
  assert.equal(ac.accuracyTrend({ data: {} }), null);
});

test('revision call: segments from cards + spoken-answer scoring', async () => {
  const rc = await import('../src/revisioncall.js');
  const pack = { topic: 'Bio', flashcards: [
    { q: 'Powerhouse?', a: 'Mitochondria makes ATP energy' },
    { q: 'Gas released?', a: 'Oxygen O2 during photosynthesis' },
  ] };
  const segs = rc.buildRevisionSegments(pack, { max: 5 });
  assert.equal(segs.length, 6, 'intro + 2×(q+reveal) + outro');
  assert.match(segs[1].say, /Sawal 1/);
  assert.equal(segs[2].kind, 'reveal');
  const score = rc.scoreAnswerSpoken(pack.flashcards[0], 'mitochondria makes atp');
  assert.equal(score.correct, true);
  assert.equal(rc.scoreAnswerSpoken(pack.flashcards[0], '').correct, false);
  assert.match(rc.revisionSummary([{ correct: true }, { correct: false }]), /1\/2/);
});

test('study scan: OCR text → cards → pack', async () => {
  const ss = await import('../src/studyscan.js');
  const naive = await ss.cardsFromText('Powerhouse: Mitochondria makes ATP\nSun: Provides light energy');
  assert.equal(naive.ok, true);
  assert.equal(naive.cards.length, 2);
  assert.equal(naive.cards[0].q, 'Powerhouse');
  const pack = { topic: 'scan', flashcards: [] };
  const r = await ss.scanToPack(Buffer.from('x'), pack, {
    ocr: async () => 'Definition: A cell is the basic unit of life',
    makeCards: async () => [{ q: 'Unit of life?', a: 'Cell' }],
  });
  assert.equal(r.ok, true);
  assert.equal(pack.flashcards.length, 1);
  assert.match(r.reply, /1 cards add/);
  assert.equal((await ss.scanToPack(Buffer.from('x'), pack, { ocr: async () => 'tiny' })).ok, false);
});

test('escalate: soon → urgent → overdue fires once each', async () => {
  const es = await import('../src/escalate.js');
  const now = 1_000_000_000_000;
  const at = now + 3 * 3600_000;
  const state = {};
  const item = [{ id: 'hw1', title: 'maths pg 42', at }];
  assert.equal(es.tick(item, { now: () => now, state }).length, 0, 'too early');
  assert.equal(es.tick(item, { now: () => at - 60 * 60_000, state }).length, 1, 'soon');
  assert.equal(es.tick(item, { now: () => at - 60 * 60_000, state }).length, 0, 'not again');
  assert.equal(es.tick(item, { now: () => at - 10 * 60_000, state }).length, 1, 'urgent');
  const over = es.tick(item, { now: () => at + 60_000, state });
  assert.equal(over.length, 1);
  assert.match(over[0], /OVERDUE/);
  assert.match(es.humanDelta(90 * 60_000), /ghante/);
});

test('siteblock: closes blocked windows, ignores the rest', async () => {
  const sb = await import('../src/siteblock.js');
  const windows = [
    '0x1  host YouTube - Mozilla Firefox',
    '0x2  host vim notes.txt',
    '0x3  host Instagram',
  ];
  assert.equal(sb.findBlockedWindows(windows, ['youtube.com']).length, 1);
  const closed = [];
  const r = await sb.blockTick({
    sites: ['youtube.com', 'instagram.com'],
    listWindows: async () => windows.join('\n'),
    closeWindow: async (line) => closed.push(line),
  });
  assert.equal(r.closed, 2);
  assert.match(r.message, /2 blocked window/);
  assert.deepEqual(sb.parseBlockList(''), sb.DEFAULT_BLOCK);
});

test('audit + nudges + recap: log, once-a-day nudges, weekly compose', async () => {
  const au = await import('../src/audit.js');
  const file = tmpFile('audit.jsonl');
  au.logAudit({ who: 'owner', cmd: 'screenshot' }, { file });
  au.logAudit({ who: 'guest', cmd: 'rm', ok: false }, { file });
  const rep = au.auditReply({ file, limit: 5 });
  assert.match(rep, /screenshot/);
  assert.match(rep, /guest/);

  const nu = await import('../src/nudges.js');
  const nf = tmpFile('nudges.json');
  const facts = { youtubeMin: 180, hwOverdue: 2 };
  const first = nu.fireNudges(facts, { file: nf });
  assert.equal(first.length, 2, 'two nudges fired');
  assert.match(first[0], /youtube|entertainment/i);
  const second = nu.fireNudges(facts, { file: nf });
  assert.equal(second.length, 0, 'once per day');
  assert.match(nu.setNudges(false, { file: nf }), /OFF/);
  assert.equal(nu.fireNudges(facts, { file: nf }).length, 0, 'disabled');

  const { buildRecap, recapGoal } = await import('../src/recap.js');
  const recap = buildRecap({ focusWeek: () => '🎯 *Focus* — 90 min', hwDone: 3, hwTotal: 4 });
  assert.match(recap, /Weekly Recap/);
  assert.match(recap, /3\/4/);
  assert.match(recapGoal({ focusMin: 10 }), /60 min/);
});

test('fun + roles: quiz flow and kids-mode limits', async () => {
  const fun = await import('../src/fun.js');
  const q = fun.newQuiz({ now: () => 0 });
  assert.match(q, /Trivia time/);
  assert.match(fun.answerQuiz(99), /Galat|Sahi/); // whatever answer, flow completes
  const q2 = fun.newQuiz({ now: () => 1 });
  assert.match(q2, /Trivia/);
  assert.match(fun.newRiddle(), /Riddle/);

  const roles = await import('../src/roles.js');
  const file = tmpFile('roles.json');
  roles.setRole('919999', 'kids', { file });
  const ok = roles.allowCommand('919999', 'study', { file });
  assert.equal(ok.allow, true);
  const blocked = roles.allowCommand('919999', 'rm', { file });
  assert.equal(blocked.allow, false);
  assert.equal(roles.allowCommand('919999', 'make', { file }).allow, false);
  assert.match(roles.rolesStatus({ file }), /kids/);
});

test('smarthome + routines + organizer: webhook, schedules, file sorting', async () => {
  const sm = await import('../src/smarthome.js');
  const file = tmpFile('home.json');
  assert.match(sm.setupHome('', { file }), /Usage/);
  assert.match(sm.setupHome('http://ha.local:8123/webhook light bulb1', { file }), /setup done/);
  const calls = [];
  const r = await sm.controlHome('light', 'on', {
    file,
    post: async (url, body) => calls.push({ url, body }),
  });
  assert.match(r, /light.*on/s);
  assert.equal(calls[0].body.action, 'on');
  assert.match(sm.buildAction('light', 'dim 40').action, /dim/);

  const rt = await import('../src/routine.js');
  const rf = tmpFile('routines.json');
  const added = rt.addRoutine('at 7am morning', { file: rf });
  assert.equal(added.ok, true);
  assert.equal(added.routine.hour, 7);
  assert.equal(rt.dueRoutines({ file: rf, now: () => Date.UTC(2026, 0, 1, 1, 30) }).length, 1, '7:00 IST = 1:30 UTC');
  assert.match(rt.routineList({ file: rf }), /07:00/);
  assert.match(rt.removeRoutine('morning', { file: rf }), /hata diya/);

  const org = await import('../src/organizer.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  fs.writeFileSync(path.join(dir, 'song.mp3'), 'x');
  fs.writeFileSync(path.join(dir, 'report.pdf'), 'x');
  fs.writeFileSync(path.join(dir, 'random.bin'), 'x');
  const res = org.organize(dir);
  assert.equal(res.moved, 3);
  assert.ok(fs.existsSync(path.join(dir, 'Audio', 'song.mp3')));
  assert.ok(fs.existsSync(path.join(dir, 'Documents', 'report.pdf')));
  assert.ok(fs.existsSync(path.join(dir, 'Others', 'random.bin')));
  assert.match(org.organizeReply(res), /3 files/);
});

test('backup + leaveby + timeline: zip recipe, leave calc, shot index', async () => {
  const bk = await import('../src/backup.js');
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bak-'));
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-'));
  fs.writeFileSync(path.join(srcDir, 'a.txt'), 'x');
  const calls = [];
  const r = await bk.backupNow(srcDir, {
    outDir,
    now: () => 1_760_000_000_000,
    run: async (bin, args) => { calls.push([bin, args]); fs.writeFileSync(args[2], 'PK'); return { stdout: '' }; },
  });
  assert.match(r, /Backup done/);
  assert.equal(calls[0][0], 'zip');
  assert.match(bk.backupList(), /Backups/);
  assert.match(await bk.cloudCopy('/nonexistent/x.png', {}), /nahi mili/);

  const lb = await import('../src/leaveby.js');
  assert.deepEqual(lb.parseLeave('9am 25km').arriveBy, { hour: 9, minute: 0 });
  assert.equal(lb.parseLeave('25km 9:30pm').km, 25);
  assert.equal(lb.parseLeave('9:30pm 25km').arriveBy.hour, 21);
  const reply = lb.leaveByReply('9am 25km', { now: () => Date.UTC(2026, 0, 1, 0, 0), speedKmph: 30, bufferMin: 15 });
  assert.match(reply, /Leave-by calc/);
  assert.match(reply, /Nikalna/);

  const tl = await import('../src/timeline.js');
  const tf = tmpFile('tl.json');
  const now = Date.UTC(2026, 0, 1, 15, 0);
  tl.setTimeline(true, { file: tf });
  assert.equal(tl.recordShot(Buffer.from('x'), { file: tf, now: () => now, text: 'youtube playlist' }), true);
  tl.recordShot(Buffer.from('x'), { file: tf, now: () => now + 600_000, text: 'vscode code' });
  const reply2 = tl.timelineReply('3pm', { file: tf, now: () => now });
  assert.match(reply2, /Screen timeline/);
  assert.match(reply2, /youtube/);
  assert.match(tl.timelineReply('3pm', { file: tmpFile('empty.json') }), /record nahi/);
});

test('fleetqueue + actionitems + wake: remote cmds, meeting actions, hot-word', async () => {
  const fq = await import('../src/fleetqueue.js');
  const enq = fq.enqueue('gaming-rig', 'screenshot');
  assert.equal(enq.ok, true);
  const item = fq.takeNext('gaming-rig');
  assert.equal(item.cmd, 'screenshot');
  assert.equal(fq.takeNext('gaming-rig'), null, 'queue drained');
  assert.ok(fq.postResult('gaming-rig', item.id, 'done: shot.png'));
  assert.match(fq.checkResult('gaming-rig', 'old-id'), /done: shot\.png/);
  assert.match(fq.checkResult('gaming-rig', item.id), /wahi purana/);

  const ai2 = await import('../src/actionitems.js');
  const actions = ai2.extractActions('Rahul will send the deck by Friday. We should review budget next week. Ok.');
  assert.equal(actions.length, 2);
  assert.equal(actions[0].owner, 'Rahul');
  assert.ok(actions[0].dueHint);
  assert.match(ai2.actionsReply(actions), /Action items/);
  assert.equal(ai2.extractActions('hello there').length, 0);

  const wk = await import('../src/wake.js');
  assert.equal(wk.matchWake('hey jarvis screenshot lo'), 'screenshot lo');
  assert.equal(wk.matchWake('Jarvis, status'), 'status');
  assert.equal(wk.matchWake('random talk'), null);
  const heard = [];
  const msg = wk.startWake({
    spawnRec: (f) => { fs.writeFileSync(f, 'fake-wav'); const e = { on: (ev, cb) => { if (ev === 'exit') setTimeout(cb, 5); }, }; return e; },
    transcribe: async () => 'hey jarvis open chrome',
    onCommand: async (c) => heard.push(c),
  });
  assert.match(msg, /Hey JARVIS ON/);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(heard.length >= 1, `heard: ${heard}`);
  assert.match(heard[0], /open chrome/);
  assert.match(wk.wakeStatus(), /ON/);
  assert.match(wk.stopWake(), /OFF/);
});
