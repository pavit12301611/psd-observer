// Offline tests: owner-only rule, number/JID handling, safe calc, reminder
// parsing, and the full command pipeline with no AI brain and no WhatsApp.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as allow from '../src/allowlist.js';
import * as tools from '../src/tools.js';
import { Store } from '../src/store.js';
import { createAgent } from '../src/commands.js';
import { Mailbox } from '../src/mailbox.js';

const OWNER = '919528923866';
const AGENT = '918859555795';

test('numbers: Indian 10-digit, +91, spaces all normalise the same', () => {
  assert.equal(allow.normalizeNumber('9528923866'), OWNER);
  assert.equal(allow.normalizeNumber('+91 95289 23866'), OWNER);
  assert.equal(allow.normalizeNumber('09528923866'), OWNER);
  assert.equal(allow.normalizeNumber('8859555795'), AGENT);
});

test('owner gate: PN jid, device jid and LID-with-alt all identify the owner', () => {
  assert.ok(allow.isOwner(allow.candidateNumbers({ remoteJid: `${OWNER}@s.whatsapp.net` }), OWNER));
  assert.ok(allow.isOwner(allow.candidateNumbers({ remoteJid: `${OWNER}:4@s.whatsapp.net` }), OWNER));
  // WhatsApp's newer LID addressing: number is only in remoteJidAlt
  assert.ok(allow.isOwner(allow.candidateNumbers({ remoteJid: '100200300@lid', remoteJidAlt: `${OWNER}@s.whatsapp.net` }), OWNER));
});

test('owner gate: everyone else is rejected (silence in whatsapp.js)', () => {
  assert.ok(!allow.isOwner(allow.candidateNumbers({ remoteJid: '919999999999@s.whatsapp.net' }), OWNER));
  assert.ok(!allow.isOwner(allow.candidateNumbers({ remoteJid: '100200300@lid' }), OWNER)); // bare LID ≠ owner
  assert.ok(!allow.isOwner(allow.candidateNumbers({ remoteJid: `${AGENT}@s.whatsapp.net` }), OWNER)); // agent ≠ owner
  assert.ok(!allow.jidToNumber('12345@lid')); // a LID must never be treated as a phone number
  assert.ok(allow.isGroupJid('123@g.us') && allow.isBroadcastJid('status@broadcast') && allow.isNewsletterJid('x@newsletter'));
});

test('calc: arithmetic works, code injection does not', () => {
  assert.equal(tools.calc('45*12'), 540);
  assert.equal(tools.calc('(10+5)*2^3'), 120);
  assert.equal(tools.calc('-5 + sqrt(81)'), 4);
  assert.equal(tools.calc('15% * 200'), 30);
  assert.throws(() => tools.calc('process.exit(1)'));
  assert.throws(() => tools.calc('1; rm -rf /'));
  assert.throws(() => tools.calc('hello'));
  assert.ok(tools.looksLikeCalc('45*12+3'));
  assert.ok(!tools.looksLikeCalc('hello there'));
});

test('parseWhen understands the reminder phrasings users actually type', () => {
  const now = new Date('2026-10-19T10:00:00');
  const in10 = tools.parseWhen('in 10m drink water', now);
  assert.equal(in10.rest, 'drink water');
  assert.equal(in10.dueTs, now.getTime() + 10 * 60_000);
  assert.equal(tools.parseWhen('in 1 hour 30 minutes stretch', now).dueTs, now.getTime() + 90 * 60_000);
  assert.equal(tools.parseWhen('in 5 minutes to stretch', now).rest, 'stretch');
  assert.equal(tools.parseWhen('buy milk in 20 minutes', now).rest, 'buy milk');
  const at = tools.parseWhen('at 18:30 gym', now);
  assert.equal(new Date(at.dueTs).getHours(), 18);
  const past = tools.parseWhen('at 9:00 call', now); // 9am already passed → tomorrow
  assert.ok(past.dueTs > now.getTime() + 12 * 3600_000);
  const tomorrow = tools.parseWhen('tomorrow 9am standup', now);
  assert.equal(new Date(tomorrow.dueTs).getDate(), 20);
  assert.equal(tools.parseWhen('whenever lol', now), null);
});

test('units + password helpers', () => {
  assert.match(tools.convertUnit(10, 'km', 'mi'), /6\.21/);
  assert.match(tools.convertUnit(100, 'c', 'f'), /212/);
  assert.throws(() => tools.convertUnit(1, 'km', 'kg'));
  assert.equal(tools.generatePassword(16).length, 16);
});

function makeAgent(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-agent-test-'));
  const store = new Store(path.join(dir, 'store.json'));
  const config = {
    ownerNumber: OWNER, agentNumber: AGENT, timezone: 'Asia/Kolkata',
    aiProvider: 'none', // no brain: exercises the offline fallbacks
    allowShell: false, shellPin: '',
    dataDir: dir, sharedDir: path.join(dir, 'shared'), downloadsDir: path.join(dir, 'dl'),
    forwardToObserver: false,
    ...overrides,
  };
  fs.mkdirSync(config.sharedDir, { recursive: true });
  return { agent: createAgent({ config, store, log: { error() {}, warn() {}, info() {} } }), store, config };
}

test('commands: todos, notes, reminders, memory round-trip', async () => {
  const { agent, store } = makeAgent();
  assert.match(await agent.handle('/todo add buy milk'), /Added #1/);
  assert.match(await agent.handle('/todo'), /buy milk/);
  assert.match(await agent.handle('/todo done 1'), /Done/);
  assert.equal(store.data.todos[0].done, true);

  assert.match(await agent.handle('/note gate code is 4321'), /Saved note/);
  assert.match(await agent.handle('note: wifi is on the fridge'), /Saved note/);
  assert.match(await agent.handle('/notes'), /4321/);

  assert.match(await agent.handle('remind me in 1 minute to stretch'), /remind you about \*stretch\*/);
  assert.equal(store.data.reminders.length, 1);
  assert.equal(store.popDueReminders(Date.now() + 70_000).length, 1);

  assert.match(await agent.handle('/remember my bike is UK04 AB 1234'), /Remembered/);
  assert.match(await agent.handle('/memory'), /UK04/);

  assert.match(await agent.handle('45*12'), /540/);
  assert.match(await agent.handle('/help'), /Observer WhatsApp Agent/);
  assert.match(await agent.handle('/run ls'), /Shell is OFF/); // safety default holds
});

test('no AI brain → helpful offline hint, never a crash or a paid call', async () => {
  const { agent } = makeAgent();
  const reply = await agent.handle('write me a poem about rains');
  assert.match(reply, /Ollama/);
  assert.match(await agent.handle('/model'), /Provider mode/);
});

test('mailbox: message is offered to Observer, reply resolves the waiter once', async () => {
  const mailbox = new Mailbox({ waitMs: 5_000 });
  const waiting = mailbox.forwardToObserver('what is on my screen?');
  const heard = await mailbox.listen(1_000);
  assert.equal(heard[0].text, 'what is on my screen?');
  assert.equal(mailbox.deliverReply({ text: 'Your editor is open.' }), 'pending');
  assert.deepEqual(await waiting, { text: 'Your editor is open.', images: undefined });
  assert.equal(mailbox.deliverReply({ text: 'late stray reply' }), 'direct'); // nobody waiting → server sends
  assert.ok(mailbox.observerOnline());
});
