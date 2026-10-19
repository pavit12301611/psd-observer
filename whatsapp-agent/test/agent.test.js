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
import * as pcctl from '../src/pccontrol.js';
import * as finder from '../src/elementfinder.js';
import { archiveDeadAuthDir } from '../src/whatsapp.js';

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

test('fedora/linux helpers: os-release parsing + sysfs battery', () => {
  const parsed = tools.parseOsRelease('NAME="Fedora Linux"\nPRETTY_NAME="Fedora Linux 42 (Workstation Edition)"\nID=fedora\n');
  assert.equal(parsed.ID, 'fedora');
  assert.equal(parsed.PRETTY_NAME, 'Fedora Linux 42 (Workstation Edition)');

  const sysfs = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-power-supply-'));
  if (process.platform === 'linux') {
    fs.mkdirSync(path.join(sysfs, 'BAT1'), { recursive: true });
    fs.writeFileSync(path.join(sysfs, 'BAT1', 'capacity'), '73\n');
    fs.writeFileSync(path.join(sysfs, 'BAT1', 'status'), 'Discharging\n');
    fs.writeFileSync(path.join(sysfs, 'BAT1', 'energy_now'), '30000000\n');
    fs.writeFileSync(path.join(sysfs, 'BAT1', 'power_now'), '10000000\n');
    const line = tools.batteryStatus(sysfs);
    assert.match(line, /73%/);
    assert.match(line, /discharging/);
    assert.match(line, /3h/); // 30Wh / 10W
  }
  assert.equal(tools.batteryStatus(path.join(sysfs, 'nope')), null);
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

test('pc control: output parsers + ydotool/xdotool key mapping', () => {
  assert.deepEqual(pcctl.parseWpctlVolume('Volume: 0.45'), { percent: 45, muted: false });
  assert.deepEqual(pcctl.parseWpctlVolume('Volume: 1.00 [MUTED]'), { percent: 100, muted: true });
  assert.equal(pcctl.parsePactlVolume('Volume: front-left: 65536 / 100% / 0.00 dB'), 100);
  assert.equal(pcctl.parseBrightnessMachine('intel_backlight,backlight,937,47%,2000'), 47);
  assert.deepEqual(pcctl.ydotoolKeyArgs('ctrl+l'), ['29:1', '38:1', '38:0', '29:0']);
  assert.deepEqual(pcctl.ydotoolKeyArgs('alt+f4'), ['56:1', '62:1', '62:0', '56:0']);
  assert.throws(() => pcctl.ydotoolKeyArgs('banana+x'));
  assert.equal(pcctl.normalizeKeyForXdotool('ctrl+enter'), 'ctrl+Return');
  assert.equal(pcctl.normalizeKeyForXdotool('alt+tab'), 'alt+Tab');
});

test('pc control: home-file guard blocks escapes and secrets', async () => {
  const home = os.homedir();
  const inside = fs.mkdtempSync(path.join(home, 'wa-test-'));
  try {
    const file = path.join(inside, 'note.txt');
    fs.writeFileSync(file, 'hello');
    assert.equal(pcctl.resolveHomeFile(file).ok, true);
    assert.equal(pcctl.resolveHomeFile('~/../../etc/passwd').ok, false);
    assert.equal(pcctl.resolveHomeFile('/etc/passwd').ok, false);
    assert.equal(pcctl.resolveHomeFile(path.join(home, '.ssh', 'id_ed25519')).reason.length > 0, true);
    assert.equal(pcctl.resolveHomeFile(path.join(inside, 'missing.txt')).ok, false);
    const found = await pcctl.findFiles('note.txt', { maxDepth: 1 });
    assert.ok(found.some((f) => f.endsWith('note.txt')));
  } finally {
    fs.rmSync(inside, { recursive: true, force: true });
  }
});

test('pc control: tier-2 input/power is gated off by default, tier-1 works', async () => {
  const off = makeAgent();
  assert.match(await off.agent.handle('/pc type hello'), /ALLOW_PC_CONTROL=false/);
  assert.match(await off.agent.handle('/pc shutdown'), /ALLOW_PC_CONTROL=false/);
  assert.match(await off.agent.handle('/pc status'), /CPU:/);
  assert.match(await off.agent.handle('/pc top'), /Top processes/);
  assert.match(await off.agent.handle('/status'), /input\+power off/);

  const on = makeAgent({ allowPcControl: true });
  const ask = await on.agent.handle('/pc suspend');
  assert.match(ask, /confirm/); // asks first, does NOT suspend immediately
  assert.match(await on.agent.handle('/pc cancel'), /Cancelled/);
  assert.match(await on.agent.handle('/pc confirm'), /Nothing is waiting/);

  const pinned = makeAgent({ allowPcControl: true, controlPin: '1234' });
  assert.match(await pinned.agent.handle('/pc key ctrl+l'), /needs your PIN/);
  assert.match(await pinned.agent.handle('/pc key 9999 ctrl+l'), /needs your PIN/);
});

test('element finder: OCR TSV parsing + label matching + vision point parsing', () => {
  const tsv = [
    'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
    '5\t1\t1\t1\t1\t1\t900\t40\t60\t24\t96\tSign',
    '5\t1\t1\t1\t1\t2\t965\t40\t25\t24\t95\tin',
    '5\t1\t2\t1\t1\t1\t100\t200\t80\t30\t92\tLogin',
    '5\t1\t3\t1\t1\t1\t100\t300\t120\t30\t88\tSearch',
    '4\t1\t3\t1\t1\t0\t100\t300\t120\t30\t-1\t',
  ].join('\n');
  const words = finder.parseOcrTsv(tsv);
  assert.equal(words.length, 4); // level-4 row dropped
  // Headerless TSV (some tesseract builds) parses via the canonical order.
  const headerless = finder.parseOcrTsv('5\t1\t1\t1\t1\t1\t124\t118\t106\t41\t96.3\tLogin');
  assert.equal(headerless.length, 1);
  assert.equal(headerless[0].x, undefined); // words carry boxes, centres come from matching
  assert.equal(headerless[0].text, 'Login');
  const login = finder.findTextTarget(words, 'Login');
  assert.equal(login.matched, 'Login');
  assert.equal(login.x, 140); // centre of 100..180
  assert.equal(login.y, 215);
  const signIn = finder.findTextTarget(words, 'sign in');
  assert.equal(signIn.matched, 'Sign in'); // multi-word phrase across one OCR line
  assert.equal(finder.findTextTarget(words, 'the login button').matched, 'Login');
  assert.equal(finder.findTextTarget(words, ' NonexistentXYZ '), null);
  assert.deepEqual(finder.parseVisionPoint('{"x": 250, "y": 750}'), { x: 250, y: 750 });
  assert.deepEqual(finder.parseVisionPoint('Sure: {"x": 0.5, "y": 0.25}'), { x: 500, y: 250 });
  assert.equal(finder.parseVisionPoint('{"found": false}'), null);
  // PNG size from a synthetic IHDR
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(1920, 16);
  png.writeUInt32BE(1080, 20);
  assert.deepEqual(finder.pngSize(png), { width: 1920, height: 1080 });
  assert.equal(finder.pngSize(Buffer.from('not png')), null);
});

test('element finder: /pc tap is tier-2 gated (off by default, PIN enforced)', async () => {
  const off = makeAgent();
  assert.match(await off.agent.handle('/pc tap Login'), /ALLOW_PC_CONTROL=false/);
  const pinned = makeAgent({ allowPcControl: true, controlPin: '1234' });
  assert.match(await pinned.agent.handle('/pc tap Login'), /needs your PIN/);
  // Correct PIN passes the gate and fails later, honestly, on "no graphical
  // session" in this headless test environment — never a phantom click.
  assert.match(await pinned.agent.handle('/pc tap 1234 Login'), /graphical session|screenshot/i);
});

test('relink: a dead login is archived timestamped, lossless, repeat-safe (phone-unlink recovery)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-relink-'));
  try {
    const authDir = path.join(dir, 'auth_info');
    const when = new Date('2026-10-19T10:11:12.000Z');
    assert.equal(archiveDeadAuthDir(authDir, when), null); // nothing to archive yet

    fs.mkdirSync(authDir);
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{"registered":true}');
    const backup = archiveDeadAuthDir(authDir, when);
    assert.match(backup, /auth_info_loggedout_2026-10-19_10-11-12-000$/); // sibling, timestamped
    assert.equal(fs.existsSync(authDir), false);                            // original moved away
    assert.equal(JSON.parse(fs.readFileSync(path.join(backup, 'creds.json'), 'utf8')).registered, true); // lossless

    // Unlinked AGAIN in the same second: a second, distinct backup — the
    // first one must not be overwritten or swallowed (the classic
    // `mv auth_info auth_info_old` folder-inside-folder bug).
    fs.mkdirSync(authDir);
    fs.writeFileSync(path.join(authDir, 'creds.json'), '{"registered":true,"second":true}');
    const backup2 = archiveDeadAuthDir(authDir, when);
    assert.notEqual(backup2, backup);
    assert.ok(fs.existsSync(path.join(backup, 'creds.json')));
    assert.equal(JSON.parse(fs.readFileSync(path.join(backup2, 'creds.json'), 'utf8')).second, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
