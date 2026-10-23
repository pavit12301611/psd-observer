// batch4.test.js — 3.6.0 improvements: context memory, brain fallback,
// corrections, answer quality, sources, plan-preview, screen diff,
// highlights, timelapse, form fill, share detect, macro-history, watch
// alerts, playlist notes, content search, netwatch, catchup, call scripts,
// quiet hours, voice reply, safety (confirm+trash+panic), rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b4-')), name);

// ══ 🧠 Brain & Chat ════════════════════════════════════════════════════════

test('context: multi-turn memory resolves "wo file" references', async () => {
  const ctx = await import('../src/context.js');
  ctx.clearContext();
  ctx.absorb('/send ~/docs/report.pdf please');
  const resolved = ctx.resolveRefs('wo file bhejo dobara');
  assert.match(resolved, /report\.pdf/, 'pronoun replaced with remembered file');
  assert.match(ctx.contextStatus(), /report\.pdf/);
  ctx.clearContext();
  assert.match(ctx.resolveRefs('wo file bhejo'), /wo file/, 'empty memory keeps original');
});

test('brain fallback: failover ladder never answers blank', async () => {
  const bf = await import('../src/brainfallback.js');
  const slow = async () => { throw new Error('cloud down'); };
  const good = async function local() { return 'local brain answer'; };
  const r = await bf.completeWithFallback('hi', { attempts: [slow, good] });
  assert.equal(r.text, 'local brain answer');
  assert.equal(r.source, 'local');
  assert.equal(r.tried, 2);
  const dead = await bf.completeWithFallback('hi', { attempts: [slow] });
  assert.equal(dead.text, null);
  assert.match(bf.fallbackReply('general'), /brains busy|offline/);
});

test('corrections: "galat, asli jawab X hai" sticks forever + retrain policy', async () => {
  const cr = await import('../src/corrections.js');
  const file = tmpFile('corr.json');
  const parsed = cr.parseCorrection('galat, asli jawab Photosynthesis hai');
  assert.equal(parsed.right, 'Photosynthesis hai');
  assert.equal(cr.parseCorrection('normal question'), null);

  cr.saveCorrection('powerhouse of cell?', 'Mitochondria', { file });
  assert.equal(cr.applyCorrection('powerhouse of cell?', 'some brain answer', { file }), 'Mitochondria');
  assert.equal(cr.applyCorrection('other question', 'brain', { file }), 'brain', 'no correction = passthrough');

  let st = cr.shouldRetrain({ file, now: () => 1000 });
  assert.equal(st.due, false, 'no policy hit yet (1 new, not stale)');
  for (let i = 0; i < 4; i++) cr.saveCorrection(`q${i}`, `a${i}`, { file });
  st = cr.shouldRetrain({ file, now: () => 2000 });
  assert.equal(st.due, true, '5 new corrections trigger retrain');
  cr.markTrained({ file, now: () => 3000 });
  assert.equal(cr.shouldRetrain({ file, now: () => 3000 }).due, false);
  st = cr.shouldRetrain({ file, now: () => 3000 + 8 * 86_400_000 });
  assert.equal(st.due, true, '7+ days stale triggers retrain');
  assert.ok(cr.asTrainingPairs({ file }).length >= 5);
});

test('answer quality: best-scored answer wins; refusals lose', async () => {
  const aq = await import('../src/answerquality.js');
  const q = 'what is photosynthesis in plants';
  const good = 'Photosynthesis is how plants make food using sunlight, water and CO2, in chloroplasts.';
  const bad = 'pata nahi';
  const { winner, ranked } = aq.bestAnswer(q, [
    { name: 'A', text: bad },
    { name: 'B', text: good },
  ]);
  assert.equal(winner.name, 'B');
  assert.ok(ranked[0].score > ranked[1].score);
  assert.equal(aq.scoreAnswer(q, ''), 0, 'empty never wins');
});

test('sources: informative answers get a source footer', async () => {
  const sl = await import('../src/sourcelinks.js');
  assert.equal(sl.withSource('jawab', []), 'jawab', 'no sources = unchanged');
  const out = sl.withSource('jawab', [{ url: 'https://en.wikipedia.org/wiki/Cell', title: 'Cell' }]);
  assert.match(out, /Sources/);
  assert.match(out, /en\.wikipedia\.org/);
  assert.equal(sl.extractSources({ sources: [{ url: 'https://x.dev', title: 'X' }] }).length, 1);
});

// ══ 🖥️ PC & Screen ═════════════════════════════════════════════════════════

test('plan preview: plan → approve → execute; cancel discards', async () => {
  const pp = await import('../src/planpreview.js');
  const steps = await pp.buildSteps('open chrome and search weather', {
    plannerFn: async () => '1. open chrome\n2. type weather\n3. press enter',
  });
  assert.equal(steps.length, 3);
  const plan = pp.makePlan('open chrome and search weather', steps);
  assert.match(pp.planReply(plan), /\/go/);
  assert.match(pp.planStatus(), /Pending plan/);
  const approved = pp.approvePlan();
  assert.equal(approved.task, 'open chrome and search weather');
  assert.equal(pp.approvePlan(), null, 'cleared after approve');
  pp.makePlan('x', ['a']);
  assert.match(pp.cancelPlan(), /cancel/i);
  const generic = await pp.buildSteps('anything', {});
  assert.equal(generic.length, 3, 'generic plan always available');
});

test('screen diff: identical = no change; different = summary', async () => {
  const sd = await import('../src/screendiff.js');
  sd.resetDiff();
  const a = Buffer.from('screen-state-A'.repeat(200));
  const b = Buffer.from('screen-state-B completely different now'.repeat(200));
  assert.equal(sd.diffBuffers(a, a).changed, false);
  const d = sd.diffBuffers(a, b);
  assert.equal(d.changed, true);
  assert.ok(d.ratio > 0);
  assert.match(d.summary, /badla|hua/);
  sd.setBaseline(a, { statFn: () => ({ mean: 10, distinct: 5 }) });
  const cmp = sd.compareWithBaseline(b, { statFn: () => ({ mean: 40, distinct: 40 }), baselineBuffer: a });
  assert.equal(cmp.first, false);
});

test('highlights: ffmpeg scene recipe + timelapse concat recipe', async () => {
  const hl = await import('../src/highlights.js');
  const tl = await import('../src/timelapse.js');
  const src = tmpFile('rec.mp4');
  fs.writeFileSync(src, 'fake');
  const calls = [];
  const run = async (bin, args) => { calls.push([bin, args]); return { stdout: '' }; };
  const r = await hl.extractHighlights(src, { run, outFile: tmpFile('out.mp4') });
  assert.equal(r.ok, true);
  assert.ok(calls[0][1].join(' ').includes('scene'), 'scene detection filter used');

  // timelapse: fake capture + assemble
  const frames = tl.startTimelapse({
    durationMs: 60_000,
    intervalSec: 10_000,
    capture: async () => Buffer.from('frame'),
    dir: fs.mkdtempSync(path.join(os.tmpdir(), 'tl-')),
  });
  assert.match(frames.reply, /Timelapse ON/);
  assert.match(tl.stopTimelapse(frames.id), /roka/);
  const assembleRun = async (bin, args) => { calls.push([bin, args]); return { stdout: '' }; };
  const out = await tl.assembleTimelapse(['/tmp/f1.jpg', '/tmp/f2.jpg'], { run: assembleRun, outFile: tmpFile('tl.mp4') });
  assert.ok(out, 'assembled');
  assert.ok(calls.at(-1)[1].join(' ').includes('concat'), 'concat demuxer used');
});

test('form fill: fields typed with tabs between; share detect policy', async () => {
  const ff = await import('../src/formfill.js');
  const fields = ff.parseFill('name:Rahul, email:r@x.com, phone: 98765');
  assert.equal(fields.length, 3);
  assert.deepEqual(fields[0], { field: 'name', value: 'Rahul' });
  const keys = [];
  const r = await ff.fillForm(fields, {
    type: async (t) => keys.push(`type:${t}`),
    tab: async () => keys.push('tab'),
  });
  assert.equal(r.typed, 3);
  assert.deepEqual(keys, ['type:Rahul', 'tab', 'type:r@x.com', 'tab', 'type:98765']);

  const sx = await import('../src/sharedetect.js');
  const hit = await sx.detectShare({ probe: async () => 'zoom --type=renderer\nchrome --type=gpu' });
  assert.equal(hit.sharing, true);
  assert.match(sx.sharePolicy(hit, { shadesOn: false }).message, /Screen share/);
  assert.equal(sx.sharePolicy(hit, { shadesOn: true }).action, 'stay');
  assert.equal(sx.sharePolicy(hit, { autoArm: true }).action, 'arm');
  const miss = await sx.detectShare({ probe: async () => 'bash\nsystemd' });
  assert.equal(miss.sharing, false);
});

test('macro history: last commands become a replayable macro', async () => {
  const mh = await import('../src/macrohistory.js');
  mh.clearRecent();
  mh.trackCommand('open', 'chrome');
  mh.trackCommand('pc', 'type github.com');
  mh.trackCommand('screenshot', '');
  const store = {
    data: {},
    addLearned(name, commands) { this.data.learned = [{ keyword: name, commands }]; return this.data.learned[0]; },
  };
  const r = mh.saveMacroFromHistory(store, 'morning', 3);
  assert.equal(r.ok, true);
  assert.equal(store.data.learned[0].commands.length, 3);
  assert.match(r.reply, /\/open chrome/);
  const tooFew = mh.saveMacroFromHistory(store, 'x', 5);
  assert.equal(tooFew.ok, false, 'macro needs ≥2 commands');
});

// ══ 🌐 Internet ════════════════════════════════════════════════════════════

test('watch: price-drop and page-change alerts (throttled)', async () => {
  const wa = await import('../src/watchalert.js');
  const file = tmpFile('watch.json');
  const now = 5000;
  const add = wa.addWatch('https://shop.example/item', 'price<5000', { file, now: () => now });
  assert.equal(add.ok, true);
  const w = add.watcher;

  let page = 'Item MRP ₹7,999 only';
  let alert = await wa.checkWatch(w, async () => page, { now: () => now });
  assert.equal(alert, null, 'above target: silent');
  page = 'Item MRP ₹4,499 only';
  alert = await wa.checkWatch(w, async () => page, { now: () => now + 1000 });
  assert.match(alert, /Price alert/);
  assert.match(alert, /4499/);
  alert = await wa.checkWatch(w, async () => page, { now: () => now + 2000 });
  assert.equal(alert, null, 'cooldown blocks spam');

  // change watch on a second URL
  const add2 = wa.addWatch('https://blog.example', 'release', { file, now: () => now });
  const w2 = add2.watcher;
  await wa.checkWatch(w2, async () => 'version 1.0.0', { now: () => now + 3000 });
  const rel = await wa.checkWatch(w2, async () => 'version 2.0.0', { now: () => now + 4000 });
  assert.match(rel, /Naya release.*2\.0\.0/);
  assert.match(wa.watchList({ file }), /blog\.example/);
  assert.match(wa.removeWatch(w.id, { file }), /hata diya/);
});

test('playlist: id parsing + notes from transcripts', async () => {
  const pl = await import('../src/playlist.js');
  assert.equal(pl.parsePlaylistId('https://youtube.com/playlist?list=PLabc12345678'), 'PLabc12345678');
  assert.equal(pl.parsePlaylistId('nonsense'), null);
  const notes = pl.playlistNotes([
    { title: 'Intro', transcript: 'welcome to the course ' + 'word '.repeat(30) },
    { title: 'Deep dive', transcript: '' },
  ]);
  assert.match(notes, /Playlist notes/);
  assert.match(notes, /Intro/);
  assert.match(pl.summaryPrompt([{ title: 'A', transcript: 'hello world' }]), /playlist/i);
});

test('content search: finds files by body text, not name', async () => {
  const cs = await import('../src/contentsearch.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-'));
  fs.writeFileSync(path.join(root, 'notes-a.txt'), 'random notes about food');
  fs.writeFileSync(path.join(root, 'invoice-2026.txt'), 'GST number 22AAAAA0000A1Z5 total 5000');
  const hits = await cs.searchContent('GST number', { root });
  assert.equal(hits.length, 1);
  assert.match(hits[0].file, /invoice-2026/);
  assert.match(hits[0].snippet, /GST/i);
  assert.match(cs.contentReply([], 'x'), /nahi mila/);
});

// ══ 📁 System & Ops ════════════════════════════════════════════════════════

test('netwatch: down → reconnect → outage logged in report', async () => {
  const nw = await import('../src/netwatch.js');
  const file = tmpFile('net.json');
  const now = 1_000_000;
  let up = false;
  const pingFn = async () => { if (!up) throw new Error('no route'); return 12; };
  const reconnectFn = async () => { up = true; return true; };

  let r = await nw.netTick({ pingFn, file, now: () => now });
  assert.equal(r.state, 'down');
  r = await nw.netTick({ pingFn, reconnectFn, file, now: () => now + 60_000 });
  assert.equal(r.action, 'reconnected');
  r = await nw.netTick({ pingFn, reconnectFn, file, now: () => now + 120_000 });
  assert.equal(r.state, 'up');
  const report = nw.netReport({ file });
  assert.match(report, /Drops: 1/);
  assert.match(report, /Reconnects: 1/);
  assert.match(report, /Outages/);
  assert.match(nw.setNetwatch(true, { file }), /ON/);
});

test('catchup: missed cron jobs run with a catch-up note', async () => {
  const cu = await import('../src/catchup.js');
  const now = 10_000_000;
  const jobs = [
    { text: 'morning brief', nextDueTs: now - 3 * 3600_000 },
    { text: 'future job', nextDueTs: now + 3600_000 },
    { text: 'ancient job', nextDueTs: now - 3 * 86_400_000 },
  ];
  const missed = cu.missedJobs(jobs, { now: () => now });
  assert.equal(missed.length, 1, 'only the recently-missed one');
  const ran = await cu.runCatchup(jobs, {
    now: () => now,
    runJob: async (j) => `ran ${j.text}`,
    advance: (j) => { j.nextDueTs = now + 86_400_000; },
  });
  assert.equal(ran.ran, 1);
  assert.match(cu.catchupNote(missed[0], { now: () => now }), /PC band tha/);
});

test('call scripts: save + segments + questions flagged', async () => {
  const cs = await import('../src/callscript.js');
  const file = tmpFile('scripts.json');
  const r = cs.saveScript('gym check', 'Roz gym kiya? Kitne minute kiye? Kal 6 baje ready rehna.', { file });
  assert.equal(r.ok, true);
  const script = cs.getScript('gym-check', { file });
  assert.equal(script.segments.length, 3);
  const plan = cs.callPlan(script);
  assert.equal(plan[0].question, true);
  assert.equal(plan[2].question, false);
  assert.match(cs.listScripts({ file }), /gym-check/);
});

test('quiet hours: overnight window queues, priority passes, digest flushes', async () => {
  const q = await import('../src/quiet.js');
  const file = tmpFile('quiet.json');
  assert.ok(q.parseWindow('22:00-07:00'));
  const win = q.parseWindow('22:00-07:00');
  // 23:30 IST = quiet
  const night = Date.UTC(2026, 9, 22, 18, 0); // 23:30 IST
  assert.equal(q.isQuiet(win, { now: () => night }), true);
  const day = Date.UTC(2026, 9, 22, 6, 0); // 11:30 IST
  assert.equal(q.isQuiet(win, { now: () => day }), false);

  q.setWindow('22:00-07:00', { file });
  const queued = q.gate('net band tha 4 min', { file, now: () => night });
  assert.equal(queued.send, false);
  assert.equal(queued.queued, true);
  const prio = q.gate('BATTERY 3%!', { file, now: () => night, priority: true });
  assert.equal(prio.send, true, 'priority always goes');
  const d = q.digest({ file });
  assert.match(d, /Morning digest/);
  assert.match(d, /net band tha/);
  assert.match(q.clearWindow({ file }), /hata diye/);
});

test('voice reply: voice in → voice out (fallback text on failure)', async () => {
  const vr = await import('../src/voicereply.js');
  assert.equal(vr.shouldVoiceReply({ voice: true }), true);
  assert.equal(vr.shouldVoiceReply({ ptt: true }), true);
  assert.equal(vr.shouldVoiceReply({}), false);
  const out = await vr.voiceReply('hello *duniya*', {
    ctx: { voice: true },
    speak: async () => ({ audio: Buffer.from('pcm'), mimetype: 'audio/ogg' }),
  });
  assert.ok(out.audio);
  const fallback = await vr.voiceReply('hi', {
    ctx: { voice: true },
    speak: async () => { throw new Error('no tts'); },
  });
  assert.equal(fallback.text, 'hi');
  const textOnly = await vr.voiceReply('hi', { ctx: {}, speak: async () => ({ audio: Buffer.from('x') }) });
  assert.equal(textOnly.audio, undefined);
});

// ══ 🔒 Safety ══════════════════════════════════════════════════════════════

test('safety: confirm token, trash-restore, panic wipe', async () => {
  const sf = await import('../src/safety.js');
  const msg = sf.requestConfirm('rm', '~/old.pdf');
  assert.match(msg, /Pakka/);
  assert.match(msg, /\/confirm \w+/);
  const bad = sf.confirmPending('wrongtoken');
  assert.equal(bad.ok, false);
  const good = sf.confirmPending(msg.match(/\/confirm (\w+)/)[1]);
  assert.equal(good.ok, true);
  assert.equal(good.action, 'rm');
  assert.equal(sf.confirmPending('x').ok, false, 'cleared after use');

  // trash round-trip
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-'));
  const victim = path.join(dir, 'secret.txt');
  fs.writeFileSync(victim, 'data');
  const trashDir = path.join(dir, 'trash');
  const tr = sf.moveToTrash(victim, { trashDir });
  assert.equal(tr.ok, true);
  assert.equal(fs.existsSync(victim), false, 'removed from original spot');
  assert.match(sf.listTrash(trashDir), /secret/);
  const back = sf.restoreTrash(fs.readdirSync(trashDir)[0], { trashDir, destDir: dir });
  assert.match(back, /Restored/);
  assert.ok(fs.readdirSync(dir).some((f) => f.endsWith('secret.txt')), 'file back');

  // panic wipe
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'memory.json'), 'x');
  fs.writeFileSync(path.join(dataDir, 'journal.json'), 'x');
  fs.writeFileSync(path.join(dataDir, 'photo-index.json'), 'keep');
  const p = sf.runPanic({ dataDir });
  assert.equal(p.wiped, 2);
  assert.ok(fs.existsSync(path.join(dataDir, 'photo-index.json')), 'keep-list survives');
});

test('rollback: snapshot then restore previous src', async () => {
  const rb = await import('../src/rollback.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-root-'));
  const snapRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-snap-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'v1');
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"1.0.0"}');
  const s = rb.saveSnapshot({ root, snapRoot, label: 'v1' });
  assert.equal(s.ok, true);
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'v2-broken');
  const r = rb.rollback({ root, snapRoot });
  assert.match(r, /Rolled back/);
  assert.equal(fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8'), 'v1', 'code restored');
  assert.match(rb.snapshotList({ snapRoot: snapRoot + '-empty' }), /Koi snapshot nahi/);
});
