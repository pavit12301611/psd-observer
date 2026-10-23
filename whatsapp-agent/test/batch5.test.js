// batch5.test.js — 3.7.0: mail monitor (IMAP), /make deliverables, PII
// classifier, Google Calendar sync (ICS), topic channels, fastcache speed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'b5-')), name);

// ══ 🔐 PII classifier ══════════════════════════════════════════════════════

test('pii: detects cards (Luhn), aadhaar, PAN, api keys; redacts; refuses strict', async () => {
  const pii = await import('../src/pii.js');
  const scan = pii.scanPII('pay via 4111 1111 1111 1111 now');
  assert.equal(scan.safe, false);
  assert.equal(scan.found[0].type, 'card');
  assert.doesNotMatch(scan.found[0].sample, /4111 1111/, 'sample is masked');

  assert.equal(pii.scanPII('otp: 445566').found[0].type, 'otp');
  assert.equal(pii.scanPII('my PAN ABCDE1234F ok').found[0].type, 'pan');
  assert.equal(pii.scanPII('key gsk_abcdefghijklmnopqrstuvwxyz1234').found[0].type, 'api_key');
  assert.equal(pii.scanPII('aadhaar 1234 5678 9012').found[0].type, 'aadhaar');
  assert.equal(pii.scanPII('hello world 42').safe, true, 'plain text clean');

  // Luhn: 4111111111111111 valid; 4111111111111112 invalid → not a card
  assert.equal(pii.scanPII('4111 1111 1111 1112').safe, true, 'bad checksum ignored');

  const red = pii.redactPII('card 4111111111111111 and otp: 123456');
  assert.doesNotMatch(red, /4111111111111111/);
  assert.doesNotMatch(red, /123456/);
  assert.match(red, /card/);

  const guard = pii.guardOutbound('here is 4111 1111 1111 1111');
  assert.equal(guard.allow, false, 'strict PII refused outbound');
  assert.match(guard.reply, /Blocked/);
  const soft = pii.guardOutbound('otp: 445566', { mode: 'redact' });
  assert.equal(soft.allow, true);
  assert.doesNotMatch(soft.text, /445566/);
});

// ══ ⚡ FastCache ═══════════════════════════════════════════════════════════

test('fastcache: LRU eviction, TTL expiry, memoize wrapper', async () => {
  const { FastCache, memoize } = await import('../src/fastcache.js');
  const c = new FastCache({ max: 2, ttlMs: 60_000 });
  c.set('a', 1);
  c.set('b', 2);
  assert.equal(c.get('a'), 1);
  c.set('c', 3); // evicts LRU 'b' (a was refreshed)
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('c'), 3);
  assert.equal(c.get('miss'), undefined);

  const t = new FastCache({ max: 5, ttlMs: 1 });
  t.set('x', 9);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(t.get('x'), undefined, 'TTL expired');

  let calls = 0;
  const f = memoize((n) => { calls++; return n * 2; }, { max: 10 });
  assert.equal(f(21), 42);
  assert.equal(f(21), 42);
  assert.equal(calls, 1, 'cached');
  assert.equal(f.cache.stats().hits, 1);
});

// ══ 📧 IMAP + Mail ═════════════════════════════════════════════════════════

test('imap: parses FETCH headers + decodes MIME subjects', async () => {
  const im = await import('../src/imap.js');
  const raw = [
    '* 1 FETCH (UID 101 BODY[HEADER.FIELDS (FROM SUBJECT DATE)] {120}',
    'From: Papa <papa@x.com>',
    'Subject: Hello beta',
    'Date: Thu, 22 Oct 2026 10:00:00 +0530',
    ')',
    'A3 OK done',
  ].join('\r\n');
  const msgs = im.parseFetches(raw);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].uid, 101);
  assert.match(msgs[0].from, /Papa/);
  assert.equal(im.decodeMime('=?UTF-8?B?SGVsbG8=?='), 'Hello');
});

test('mail: setup + digest priority-first + redaction + fake-client check', async () => {
  const mail = await import('../src/mail.js');
  const file = tmpFile('mail.json');
  assert.match(mail.setupMail('', { file }), /Usage/);
  assert.match(mail.setupMail('imap.gmail.com me@gmail.com app-pass-123', { file }), /setup done/);
  assert.match(mail.mailStatus({ file }), /me@gmail\.com/);
  assert.match(mail.setMonitor(true, { file }), /ON/);

  const digest = mail.mailDigest([
    { from: 'newsletter@x.com', subject: 'Weekly roundup' },
    { from: 'alerts@bank.com', subject: 'URGENT: invoice due' },
    { from: 'otp@y.com', subject: 'Your OTP is 445566' },
  ]);
  assert.match(digest, /2 priority/);
  const firstLine = digest.split('\n')[1];
  assert.match(firstLine, /🔴/, 'priority mails lead');
  assert.doesNotMatch(digest, /445566/, 'OTP redacted in digest');

  const out = await mail.checkMail({
    file,
    createClient: () => ({
      connect: async () => true,
      fetchUnseen: async () => [{ from: 'a@b.c', subject: 'hi' }],
      logout: async () => {},
    }),
  });
  assert.match(out, /Mail digest/);
  assert.match(out, /1 new/);

  const bad = await mail.checkMail({
    file,
    createClient: () => ({ connect: async () => { throw new Error('auth fail'); }, logout: async () => {} }),
  });
  assert.match(bad, /auth fail/);
});

// ══ 🛠️ /make deliverables ══════════════════════════════════════════════════

test('make: report/slides/dashboard/csv render + save', async () => {
  const mk = await import('../src/make.js');
  assert.match(mk.buildReport('Sales', [{ heading: 'Q1', body: '₹5L' }]), /# Sales\n[\s\S]*## Q1\n\n₹5L/);
  assert.match(mk.buildSlides('Deck', [{ title: 'One', bullets: ['a'] }]), /<!doctype html>/);
  assert.match(mk.buildSlides('Deck', [{ title: 'One', bullets: ['a'] }]), /<li>a<\/li>/);
  assert.match(mk.buildDashboard('Ops', [{ label: 'Up', value: 99 }]), /<div class="value">99<\/div>/);
  assert.equal(mk.buildCSV([['a', 'b'], ['x,1', 'y"2']]), 'a,b\n"x,1","y""2"');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'make-'));
  const r = await mk.makeDeliverable('report', 'Q3 Sales', {
    dir,
    draft: async () => ({ sections: [{ heading: 'Sum', body: 'nice' }] }),
  });
  assert.match(r, /Report ready/);
  const file = r.match(/(\S+\.(?:md|html|csv))/)[1];
  assert.ok(fs.existsSync(file));
  assert.match(fs.readFileSync(file, 'utf8'), /## Sum/);

  const noBrain = await mk.makeDeliverable('slides', 'X', { dir });
  assert.match(noBrain, /Slides ready/, 'template fallback works without brain');
  assert.match(await mk.makeDeliverable('pdf', 'x', { dir }), /Usage/);
});

// ══ 🗓️ Google Calendar (ICS) ══════════════════════════════════════════════

test('gcal: ICS parse → export round-trip + sync dedupe', async () => {
  const gc = await import('../src/gcal.js');
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:ev1@google.com',
    'DTSTART:20261025T103000Z',
    'DTEND:20261025T113000Z',
    'SUMMARY:Team standup',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const events = gc.parseICS(ics);
  assert.equal(events.length, 1);
  assert.equal(events[0].title, 'Team standup');
  assert.equal(events[0].start, Date.UTC(2026, 9, 25, 10, 30));

  const exported = gc.exportICS([{ id: 'x1', at: events[0].start, title: 'Team standup' }]);
  const roundTrip = gc.parseICS(exported);
  assert.equal(roundTrip.length, 1);
  assert.equal(roundTrip[0].title, 'Team standup');
  assert.equal(roundTrip[0].start, events[0].start);

  const file = tmpFile('cal-sync.json');
  const r1 = await gc.syncFromICS('https://calendar.google.com/ical/secret', {
    file,
    fetchText: async () => ics,
  });
  assert.match(r1, /1 naye add hue/);
  const r2 = await gc.syncFromICS('https://calendar.google.com/ical/secret', {
    file,
    fetchText: async () => ics,
  });
  assert.match(r2, /0 naye add hue/, 'dedupe on second sync');
  assert.match(await gc.syncFromICS('u', { file, fetchText: async () => { throw new Error('404'); } }), /404/);
});

// ══ 🗂️ Topic channels ═════════════════════════════════════════════════════

test('topics: switch, pin, per-topic memory, isolation', async () => {
  const tp = await import('../src/topics.js');
  assert.equal(tp.currentTopic(), 'general');
  assert.equal(tp.topicContext(), '', 'general has no preamble');

  tp.switchTopic('work');
  tp.recordMessage('user', 'client report ready hai');
  tp.pinToTopic('deadline friday');
  const ctx = tp.topicContext();
  assert.match(ctx, /#channel:work/);
  assert.match(ctx, /client report/);
  assert.match(ctx, /deadline friday/);

  tp.switchTopic('study');
  tp.recordMessage('user', 'physics chapter 4');
  assert.doesNotMatch(tp.topicContext(), /client report/, 'channels isolated');
  assert.match(tp.topicContext(), /physics/);

  assert.match(tp.switchTopic('Work Project'), /#work-project/, 'normalized');
  assert.match(tp.listTopics(), /Channels/);
  assert.match(tp.deleteTopic('study'), /hata diya/);
});

// ══ ⚡ Speed: knowledge cache ══════════════════════════════════════════════

test('speed: lookupKnowledge serves repeats from cache (same result)', async () => {
  const kn = await import('../src/knowledge.js');
  const q = 'what is the capital of india';
  const a = kn.lookupKnowledge(q);
  assert.ok(a?.reply, 'first lookup answers');
  const t0 = process.hrtime.bigint();
  const b = kn.lookupKnowledge(q);
  const t1 = process.hrtime.bigint();
  assert.equal(b?.id, a.id, 'cached result identical');
  assert.ok(Number(t1 - t0) < 5_000_000, `repeat lookup <5ms (${Number(t1 - t0) / 1e6}ms)`);
  // no memory leak for garbage: long input still short-circuits
  assert.equal(kn.lookupKnowledge('x'.repeat(300)), null);
});
