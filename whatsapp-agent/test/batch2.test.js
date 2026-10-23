// batch2.test.js — Features 6-10: Doc Q&A · Photo Search · Calendar ·
// Focus Mode · Power Guardian.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b2-')), name);

// ═══ 6. 📄 Document Q&A ════════════════════════════════════════════════════

test('doc: load txt, ask strictly from it, clear', async () => {
  const dc = await import('../src/docchat.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'));
  const file = path.join(dir, 'notes.txt');
  fs.writeFileSync(file, 'The mitochondria is the powerhouse of the cell. It makes ATP.');

  dc.clearDoc();
  const loaded = await dc.loadDoc(file);
  assert.equal(loaded.ok, true);
  assert.match(loaded.reply, /Loaded: notes.txt/);
  assert.match(dc.docStatus(), /notes\.txt/);

  const answer = await dc.askDoc('what makes ATP?', {
    ask: async (prompt) => {
      assert.match(prompt, /powerhouse of the cell/, 'doc text reaches the brain');
      assert.match(prompt, /STRICTLY from the document/);
      return 'Mitochondria makes ATP.';
    },
  });
  assert.match(answer, /Mitochondria makes ATP/);

  assert.match(dc.clearDoc(), /hata diya/);
  const blocked = await dc.askDoc('anything', { ask: async () => 'x' });
  assert.match(blocked, /Pehle doc load karo/);
});

test('doc: missing file is an honest error, pdf path needs pdftotext', async () => {
  const dc = await import('../src/docchat.js');
  const missing = await dc.loadDoc('/nonexistent/nope.txt');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /File nahi mili/);
  // pdf with failing pdftotext → honest tool hint
  const pdf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-')), 'x.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4 fake');
  const failed = await dc.loadDoc(pdf, {
    run: async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
  });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /pdftotext|Padh nahi paya/);
});

// ═══ 7. 🔍 Photo Search ════════════════════════════════════════════════════

test('photos: index a folder and find by meaning/keywords', async () => {
  const ps = await import('../src/photosearch.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pics-'));
  fs.mkdirSync(path.join(dir, 'goa trip 2026'));
  fs.writeFileSync(path.join(dir, 'goa trip 2026', 'beach_sunset.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'goa trip 2026', 'food_thali.png'), 'x');
  fs.writeFileSync(path.join(dir, 'birthday party.jpg'), 'x');
  const file = tmpFile('idx.json');

  const idx = ps.buildPhotoIndex({ dir, file, now: 1000 });
  assert.equal(idx.photos.length, 3);
  const hits = ps.searchPhotos('goa beach', { file, now: 1000 });
  assert.ok(hits.length >= 1);
  assert.match(hits[0].file, /beach_sunset/);
  const reply = ps.photoReply('goa beach', { file, now: 1000 });
  assert.match(reply, /beach_sunset/);
  assert.match(ps.photoReply('nonexistent zebra', { file, now: 1000 }), /kuch nahi mila/);
});

test('photos: empty index tells the owner to build it first', async () => {
  const ps = await import('../src/photosearch.js');
  const reply = ps.photoReply('goa', { file: tmpFile('empty.json') });
  assert.match(reply, /index khaali/);
});

// ═══ 8. 🗓️ Calendar ═══════════════════════════════════════════════════════

test('cal: parse when, add events, today/week views, delete', async () => {
  const cal = await import('../src/calendar.js');
  const now = Date.UTC(2026, 9, 22, 5, 0); // Thu 22 Oct 2026, 10:30 IST
  const file = tmpFile('cal.json');

  const tomorrow = cal.parseWhen('kal 4pm meeting with sir', now);
  assert.equal(tomorrow.rest, 'meeting with sir');
  const d = new Date(tomorrow.at);
  assert.equal(d.getDate(), 23);
  assert.equal(d.getHours(), 16);

  assert.ok(cal.parseWhen('in 2h call papa', now).at - now === 2 * 3600_000);
  assert.equal(cal.parseWhen('friday 10am standup', now).rest, 'standup');

  const added = cal.addEvent('kal 4pm meeting with sir', { file, now: () => now });
  assert.equal(added.ok, true);
  assert.match(added.reply, /meeting with sir/);
  cal.addEvent('aaj 5pm gym', { file, now: () => now });

  assert.match(cal.todayReply({ file, now }), /gym/);
  assert.match(cal.weekReply({ file, now }), /meeting with sir/);
  assert.match(cal.delEvent('gym', { file }), /hata diya/);
  assert.match(cal.todayReply({ file, now }), /koi event nahi/);
});

// ═══ 9. 🎯 Focus Mode ══════════════════════════════════════════════════════

test('focus: session blocks distractions, tracks minutes, weekly report', async () => {
  const fm = await import('../src/focus.js');
  const file = tmpFile('focus.json');
  const closed = [];
  let t = 1_000_000;
  const msg = await fm.startFocus({
    minutes: 25,
    blocks: ['youtube', 'steam'],
    closeApp: async (app) => { closed.push(app); return true; },
    now: () => t,
    file,
  });
  assert.match(msg, /Focus ON — 25 min/);
  assert.deepEqual(closed, ['youtube', 'steam'], 'initial sweep closed both');
  assert.match(fm.focusStatus({ file, now: () => t }), /ON/);

  const again = await fm.startFocus({ minutes: 25, blocks: [], now: () => t, file });
  assert.match(again, /pehle se ON/, 'no double sessions');

  t += 26 * 60_000;
  const stop = fm.stopFocus({ file, now: () => t });
  assert.match(stop, /Focus session done/);
  assert.match(stop, /25 min|26 min/);
  assert.match(fm.focusStatus({ file, now: () => t }), /OFF/);
  assert.match(fm.weeklyReport({ file, now: () => t }), /last 7 days/);
});

// ═══ 10. 🔋 Power Guardian ═════════════════════════════════════════════════

test('pguard: battery/temp thresholds warn once, recover, re-arm', async () => {
  const pg = await import('../src/powerguard.js');
  const file = tmpFile('pg.json');
  const state = { enabled: true, battery: 15, temp: 85, warnedLevels: [], lastTempWarn: 0 };

  // battery 12% → one warn; same band again → silent
  let acts = pg.evaluate({ battery: 12, temp: 50 }, state, 1000);
  assert.equal(acts.length, 1);
  assert.match(acts[0].message, /Battery 12%/);
  acts = pg.evaluate({ battery: 11, temp: 50 }, state, 2000);
  assert.equal(acts.length, 0, 'warned band not repeated');

  // recovery above threshold+10 resets bands
  pg.evaluate({ battery: 40, temp: 50 }, state, 3000);
  acts = pg.evaluate({ battery: 9, temp: 50 }, state, 4000);
  assert.equal(acts.length, 1, 'new band warns again');

  // temp: one warn per 15 min
  acts = pg.evaluate({ battery: 90, temp: 92 }, state, 5000);
  assert.equal(acts.length, 1);
  assert.match(acts[0].message, /92°C|92/);
  acts = pg.evaluate({ battery: 90, temp: 95 }, state, 6000);
  assert.equal(acts.length, 0, 'temp warn throttled');

  // thresholds settable
  assert.match(pg.setThreshold('battery', 25, { file }), /25%/);
  assert.match(pg.setThreshold('temp', 90, { file }), /90°C/);
  assert.match(pg.pgStatus({ file, read: () => ({ battery: 80, temp: 45 }) }), /battery 80%/);
});
