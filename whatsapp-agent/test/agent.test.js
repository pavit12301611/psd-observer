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
import * as files from '../src/files.js';
import * as finder from '../src/elementfinder.js';
import * as reach from '../src/reach.js';
import * as grounding from '../src/grounding.js';
import * as hands from '../src/hands.js';
import * as nlp from '../src/nlp.js';
import * as guests from '../src/guests.js';
import * as location from '../src/location.js';
import * as actionrecorder from '../src/actionrecorder.js';
import * as vocab from '../src/vocab.js';
import * as accuracy from '../src/accuracy.js';
import * as bilingual from '../src/bilingual.js';
import * as quality15 from '../src/quality15.js';
import * as ai from '../src/ai.js';
import { createModelRouter } from '../src/router.js';
import { archiveDeadAuthDir, createWhatsApp } from '../src/whatsapp.js';

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

test('files: protected folders are blocked for writes too, not just reads', () => {
  const home = os.homedir();
  const inside = fs.mkdtempSync(path.join(home, 'wa-write-guard-'));

  // Regression: the block list only ran for existing paths, so
  // `/write ~/.ssh/authorized_keys | <key>` silently worked and added an SSH key.
  for (const target of [
    '~/.ssh/authorized_keys',
    '~/.ssh/config',
    '~/.gnupg/gpg.conf',
    path.join(home, 'auth_info', 'creds.json'),
    '~/.local/share/keyrings/login.keyring',
  ]) {
    assert.equal(files.resolvePath(target, { mustExist: false }).ok, false, target);
    assert.throws(() => files.writeTextFile(target, 'x'), /blocked on purpose/, target);
  }

  // Normal writes still work, including brand-new nested folders.
  const fresh = path.join(inside, 'a', 'b', 'note.txt');
  assert.match(files.writeTextFile(fresh, 'hello'), /Saved/);
  assert.equal(fs.readFileSync(fresh, 'utf8'), 'hello');
  assert.match(files.makeDir(path.join(inside, 'newdir')), /Created folder/);
  assert.match(files.copyPath(fresh, path.join(inside, 'copy.txt')), /Copied/);

  // Escapes are still refused.
  assert.equal(files.resolvePath('~/../../etc/passwd', { mustExist: false }).ok, false);
  assert.equal(files.resolvePath('/etc/passwd', { mustExist: false }).ok, false);
  fs.rmSync(inside, { recursive: true, force: true });
});

test('tts: text is handed to the engine directly, never through a shell', async () => {
  const src = fs.readFileSync(new URL('../src/tts.js', import.meta.url), 'utf8');
  // Command substitution ($(…), backticks) survives sanitizeForTTS, so a
  // `sh -c` anywhere near the message text is a command-injection hole.
  assert.ok(!/spawn\(\s*['"]sh['"]/.test(src), 'no shell for TTS');
  assert.ok(!/['"]-c['"]/.test(src), 'no shell -c for TTS');
  assert.ok(src.includes("spawn('text2wave'"), 'festival gets argv + stdin');
});

test('bridge: the token is compared in constant time', async () => {
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.ok(!/=== config\.bridgeToken/.test(src), 'no plain === on the token');
  assert.ok(/safeEqual\(candidate, config\.bridgeToken\)/.test(src), 'safeEqual used');
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

test('memory: natural-language name save, recall, and overwrite of pre-existing facts', async () => {
  const { agent, store } = makeAgent();
  // Seed a legacy raw-slice fact ("pehle se save hai") to verify canonical overwrite removes stale conflicting entries
  store.data.facts['my name is Aman'] = 'my name is Aman';
  store.save();

  // Owner states their name in natural Hinglish
  const r1 = await agent.handle('mera naam Pavit hai');
  assert.match(r1, /Pavit/);
  assert.match(r1, /Aman/); // confirms overwrite of old saved value
  // Legacy duplicate key must be purged so AI/recall never sees two names
  assert.equal(store.data.facts['my name is Aman'], undefined);
  assert.equal(store.data.factValues.name, 'Pavit');

  // Recall works offline in Hinglish & English
  assert.match(await agent.handle('mera naam kya hai?'), /Pavit/);
  assert.match(await agent.handle('what is my name?'), /Pavit/);
  assert.match(await agent.handle('main kaun hoon?'), /Pavit/);

  // Greeting uses remembered owner name
  assert.match(await agent.handle('namaste'), /Pavit/);

  // Owner updates name again via correction phrasing ("nahi mera naam X hai")
  const r2 = await agent.handle('nahi mera naam Pavit nahi, Rudra hai');
  assert.match(r2, /Rudra/);
  assert.equal(store.data.factValues.name, 'Rudra');
  assert.match(await agent.handle('mera naam kya hai'), /Rudra/);

  // Other personal facts (city, bike) also canonicalize and overwrite cleanly
  await agent.handle('main Dehradun me rehta hoon');
  assert.match(await agent.handle('main kahan rehta hoon?'), /Dehradun/);
  await agent.handle('mera shehar ab Bengaluru hai');
  assert.match(await agent.handle('where do I live?'), /Bengaluru/);
  assert.equal(Object.values(store.data.facts).filter((f) => /Dehradun/i.test(f)).length, 0);
});

test('memory: custom trigger->action rules and owner overrides beat pre-saved/default behavior', async () => {
  const { agent } = makeAgent();
  await agent.handle('/todo add Buy milk');

  // Pre-save a learned command
  await agent.handle('/learn morning /notes');
  assert.match(await agent.handle('morning'), /No notes yet/i);

  // Owner overrides "morning" in natural Hinglish: "agar main morning kahun to /todo list"
  const savedRule = await agent.handle('agar main morning kahun to /todo list');
  assert.match(savedRule, /morning/i);

  // Now saying "morning" executes what the owner newly instructed (/todo list), NOT the old /notes
  const out = await agent.handle('morning');
  assert.match(out, /Buy milk/);

  // Owner can even override a built-in phrase ("gaana chalao" normally runs media play)
  await agent.handle('jab main gaana chalao bolun to /todo list');
  assert.match(await agent.handle('gaana chalao'), /Buy milk/);

  // Immediate correction ("pehle wala chhodo, /note Fresh note") runs the new command directly
  assert.match(await agent.handle('pehle wala chhodo, /note Fresh note'), /Saved note/);
  assert.match(await agent.handle('/notes'), /Fresh note/);
});

test('memory: voice call remembers owner name & honorific in Hindi/Hinglish and uses it live', async () => {
  const { agent } = makeAgent();
  const heard1 = await agent.voice.say('call-1', 'मेरा नाम पवित है');
  assert.match(heard1.text, /Pavit/);

  const who = await agent.voice.say('call-1', 'mera naam kya hai');
  assert.match(who.text, /Pavit/);

  // Owner asks to be addressed as Boss
  const addr = await agent.voice.say('call-1', 'mujhe Boss bulao');
  assert.match(addr.text, /Boss/);

  // Next greeting / smalltalk on the voice call addresses the owner as Boss
  const hi = await agent.voice.say('call-1', 'hello jarvis');
  assert.match(hi.spoken, /Boss/);
});

test('PSD_Ai identity + turbo offline power (multi-command chains, Hinglish math, instant queries)', async () => {
  const { agent } = makeAgent();

  // Default identity is PSD_Ai in chat, greetings, help, and voice calls
  assert.match(await agent.handle('tumhara naam kya hai?'), /PSD_Ai/);
  assert.match(await agent.handle('what is your name?'), /PSD_Ai/);
  assert.match(await agent.handle('tum kaun ho?'), /PSD_Ai/);
  assert.match(await agent.handle('hi'), /PSD_Ai/);
  assert.match(await agent.handle('/help'), /PSD_Ai/);
  const vWho = await agent.voice.say('call-psd', 'who are you');
  assert.match(vWho.spoken, /PSD_Ai/);

  // Multi-command chain in typed WhatsApp chat executes both steps offline in < 5ms
  const chainOut = await agent.handle('todo add Turbo task aur note: Turbo note');
  assert.match(chainOut, /Added #1: Turbo task/);
  assert.match(chainOut, /Saved note #1/);

  // Hinglish math & percentages & unit conversions work offline
  assert.match(await agent.handle('500 ka 18 percent kitna hai?'), /90/);
  assert.match(await agent.handle('45 guna 12'), /540/);
  assert.match(await agent.handle('10 km in mi'), /6\.21/);

  // Natural Hinglish queries for tasks/notes/time/date work offline
  assert.match(await agent.handle('mere tasks dikhao'), /Turbo task/);
  assert.match(await agent.handle('mere notes dikhao'), /Turbo note/);
  assert.match(await agent.handle('time kya hua hai?'), /\d/);
  assert.match(await agent.handle('aaj kya date hai?'), /20\d\d/);
});

test('Agent-Reach: URL normalization, SSRF blocking, anti-bot detection, VTT/RSS/DDG parsers & multi-channel routing', async () => {
  // Public URL normalization + SSRF protection
  assert.equal(reach.normalizePublicHttpUrl('example.com/docs'), 'https://example.com/docs');
  assert.throws(() => reach.normalizePublicHttpUrl('http://127.0.0.1:8080/secret'), /Refusing private\/local host/);
  assert.throws(() => reach.normalizePublicHttpUrl('http://192.168.1.1/admin'), /Refusing private\/local host/);
  assert.throws(() => reach.normalizePublicHttpUrl('https://user:pass@example.com/'), /embedded username\/password/);

  // Credential scrubbing
  assert.equal(
    reach.scrubUrlCredentials('https://alice:secret123@example.com/api?api_key=xyz987'),
    'https://***:***@example.com/api?api_key=***',
  );

  // Anti-bot challenge page detection
  assert.equal(reach.isAntibotPage('Title: Just a moment...\nWarning: target page requiring captcha\n## Performing security verification'), true);
  assert.equal(reach.isAntibotPage('# Real Article Title\nHere is normal markdown content.'), false);

  // Platform detection across 16 channels
  assert.equal(reach.detectPlatform('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'youtube');
  assert.equal(reach.detectPlatform('https://youtu.be/dQw4w9WgXcQ'), 'youtube');
  assert.equal(reach.detectPlatform('https://github.com/pavit12301611/psd-observer'), 'github');
  assert.equal(reach.detectPlatform('https://x.com/elonmusk/status/1234567890'), 'twitter');
  assert.equal(reach.detectPlatform('https://www.reddit.com/r/LocalLLaMA/comments/abc/test'), 'reddit');
  assert.equal(reach.detectPlatform('https://news.ycombinator.com/item?id=1'), 'hackernews');
  assert.equal(reach.detectPlatform('https://example.com/feed.xml'), 'rss');
  assert.equal(reach.detectPlatform('https://example.com/blog/post'), 'web');

  // YouTube VTT rolling subtitle deduplication
  const vtt = [
    'WEBVTT',
    'Kind: captions',
    'Language: en',
    '',
    '00:00:01.000 --> 00:00:03.000',
    '<c>Hello</c> world',
    '',
    '00:00:03.000 --> 00:00:05.000',
    'Hello world from PSD_Ai',
    '',
    '00:00:05.000 --> 00:00:07.000',
    'Deterministic computer control!',
  ].join('\n');
  assert.equal(reach.parseVttTranscript(vtt), 'Hello world from PSD_Ai Deterministic computer control!');
  assert.equal(reach.extractYoutubeId('https://youtu.be/dQw4w9WgXcQ?t=10'), 'dQw4w9WgXcQ');

  // DuckDuckGo HTML parser & RSS parser
  const ddgHtml = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fpavit12301611%2Fpsd-observer">PSD Observer Repo</a><a class="result__snippet">Full Linux control</a>`;
  const ddgItems = reach.parseDuckDuckGoHtml(ddgHtml);
  assert.equal(ddgItems.length, 1);
  assert.equal(ddgItems[0].url, 'https://github.com/pavit12301611/psd-observer');

  const rssXml = `<rss><channel><item><title>Release 3.2.0</title><link>https://example.com/r32</link><description>Agent-Reach + Agent-S</description></item></channel></rss>`;
  const rssItems = reach.parseRssXml(rssXml);
  assert.equal(rssItems.length, 1);
  assert.equal(rssItems[0].title, 'Release 3.2.0');

  // Offline mock fetch test for readWebUrl & twitterLookup (FxTwitter)
  const mockFetch = async (url) => {
    if (String(url).includes('api.fxtwitter.com')) {
      return {
        ok: true,
        json: async () => ({
          tweet: {
            text: 'Agent-Reach + Agent-S gives PSD_Ai real deterministic control!',
            likes: 420,
            retweets: 69,
            replies: 12,
            views: 9000,
            author: { name: 'Pavit', screen_name: 'pavit' },
          },
        }),
      };
    }
    return {
      ok: true,
      headers: { get: () => 'text/markdown' },
      text: async () => '# Clean Page Title\n\nThis is clean structured content read via Agent-Reach without opening a browser.',
    };
  };

  const page = await reach.readWebUrl('https://example.com/article', { fetchImpl: mockFetch });
  assert.equal(page.ok, true);
  assert.match(page.content, /Clean Page Title/);

  const tweet = await reach.twitterLookup('https://x.com/pavit/status/1234567890', { fetchImpl: mockFetch });
  assert.equal(tweet.ok, true);
  assert.equal(tweet.backend, 'FxTwitter API');
  assert.match(tweet.text, /real deterministic control/);

  const doc = await reach.reachDoctor();
  assert.equal(doc.ok, true);
  assert.match(doc.text, /Agent-Reach Doctor/);
});

test('Agent-S Grounding: AT-SPI widget tree, phrase alignment, Set-of-Marks (SoM), and deterministic Hands resolution', async () => {
  const sampleAtspi = [
    { id: 0, role: 'push button', name: 'Sign in', description: '', left: 800, top: 40, width: 100, height: 36, x: 850, y: 58, focused: false },
    { id: 1, role: 'entry', name: 'Search or type URL', description: '', left: 200, top: 40, width: 400, height: 36, x: 400, y: 58, focused: true },
  ];
  const sampleWords = [
    { id: 0, text: 'Submit', left: 300, top: 400, width: 80, height: 24, conf: 95, lineKey: '1/1/1', wordNum: 1 },
  ];
  const size = { width: 1920, height: 1080 };

  // 1. AT-SPI widget matching hits exact widget center (even when query says "the sign in button")
  const hit = grounding.findElementInTree(sampleAtspi, 'the Sign in button');
  assert.ok(hit);
  assert.equal(hit.source, 'atspi');
  assert.equal(hit.x, 850);
  assert.equal(hit.y, 58);

  // 2. Phrase-aligned coordinates (start / center / end) like Agent-S generate_text_coords
  assert.deepEqual(grounding.alignTargetCoords(hit, 'center'), { x: 850, y: 58 });
  assert.deepEqual(grounding.alignTargetCoords(hit, 'start'), { x: 806, y: 58 });
  assert.deepEqual(grounding.alignTargetCoords(hit, 'end'), { x: 894, y: 58 });

  // 3. Set-of-Marks combines AT-SPI + OCR without duplicates
  const marks = grounding.buildSetOfMarks({ atspiElements: sampleAtspi, ocrWords: sampleWords, size });
  assert.equal(marks.length, 3);
  assert.equal(marks[0].source, 'atspi');
  assert.equal(marks[2].source, 'ocr');

  // 4. Hands action parser & target resolver supports `mark`, AT-SPI `target`, `align`, `overwrite`, and `hotkey`
  const markClick = hands.parseHandsAction('{"action":"click","mark":0}');
  assert.equal(markClick.ok, true);
  assert.equal(markClick.action.mark, 0);

  const ctx = { size, words: sampleWords, atspi: sampleAtspi, marks, config: {}, log: console };
  const resolvedMark = await hands.resolveTarget(markClick.action, ctx);
  assert.equal(resolvedMark.x, 850);
  assert.equal(resolvedMark.y, 58);
  assert.match(resolvedMark.how, /AT-SPI #0 "Sign in"/);

  const resolvedNamed = await hands.resolveTarget({ target: 'Search or type URL', align: 'start' }, ctx);
  assert.equal(resolvedNamed.x, 206);
  assert.equal(resolvedNamed.y, 58);
  assert.match(resolvedNamed.how, /AT-SPI \[entry\]/);

  const hotkeyAct = hands.parseHandsAction('{"action":"hotkey","keys":"ctrl+l"}');
  assert.equal(hotkeyAct.ok, true);
  assert.equal(hotkeyAct.action.action, 'key');
  assert.equal(hotkeyAct.action.keys, 'ctrl+l');

  const overwriteType = hands.parseHandsAction('{"action":"type","target":"Search or type URL","text":"psd-observer","overwrite":true,"submit":true}');
  assert.equal(overwriteType.ok, true);
  assert.equal(overwriteType.action.overwrite, true);
  assert.equal(overwriteType.action.target, 'Search or type URL');

  // 5. NLP intents for Agent-Reach & Agent-S
  assert.deepEqual(nlp.parseIntent('reach doctor'), { cmd: 'reach', args: 'doctor' });
  assert.deepEqual(nlp.parseIntent('ui elements'), { cmd: 'ui', args: '' });
  assert.deepEqual(nlp.parseIntent('deep research linux accessibility'), { cmd: 'reach', args: 'research linux accessibility' });
  assert.deepEqual(nlp.parseIntent('youtube pe kesariya play karo'), { cmd: 'yt', args: 'play kesariya' });
});

test('Multi-User Command Firewall: ALL slash (/) and plain-language (baaki bhi) commands are strictly blocked for non-owners', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-firewall-'));
  const store = new Store(path.join(tmp, 'store.json'));
  const config = {
    dryRun: true,
    ownerNumber: OWNER,
    agentNumber: AGENT,
    timezone: 'Asia/Kolkata',
    aiProvider: 'none',
    guestMode: 'all',
    guestNotifyBlocked: true,
    guestNotifyMessages: false,
    guestRateLimitPerMinute: 100,
    outboundRateLimitPerMinute: 12,
    downloadsDir: tmp,
    sharedDir: tmp,
  };
  const agent = createAgent({ config, store, log: { info() {}, warn() {}, error() {} } });
  const wa = createWhatsApp({ config, store, agent, log: { info() {}, warn() {}, error() {} } });

  // Owner sets up a custom learned keyword and a pending confirmation
  await agent.handle('/learn work open chrome | screenshot');
  await agent.handle('/remember my secret pin is 7788');
  store.data.pending = { name: 'delete_file', args: { path: 'important.txt' }, ts: Date.now(), text: 'Delete important.txt' };

  const GUEST = '919876543210';

  // 1. Every slash command from a non-owner must be blocked
  const slashAttempts = [
    '/help',
    '/status',
    '/screenshot',
    '/open chrome',
    '/run rm -rf /',
    '/todo add hack owner',
    '/note injected note',
    '/remember my name is Hacker',
    '/msg 919999888877 spam',
    '/contact add Eve 919999888877',
    '/guest off',
    '/dsh ls -la',
    '/solve 2+2',
    'hello\n/screenshot', // multi-line hidden slash command
  ];
  for (const cmdText of slashAttempts) {
    const res = await wa.simulate(cmdText, GUEST, { senderName: 'Rahul' });
    assert.equal(res.ignored, false, `Expected reply for ${cmdText}`);
    assert.equal(res.blocked, true, `Expected slash command to be blocked: ${cmdText}`);
    assert.match(res.sent[0].text, /Command Blocked/i);
  }

  // 2. Every plain-language / Hinglish command ("baaki bhi") from a non-owner must be blocked
  const plainCommandAttempts = [
    'chrome kholo',
    'open calculator',
    'close firefox',
    'screenshot bhej do',
    'screen pe kya hai',
    'volume 50 karo',
    'awaaz kam karo',
    'wifi off karo',
    'pc shutdown karo',
    'lock screen',
    'type hello world',
    'click on Sign in',
    'remind me in 10m to call',
    '10 minute baad yaad dilana pani peena',
    'note: hacked note',
    'add todo: steal files',
    'remember my name is Intruder',
    'mera naam Intruder hai',
    'tumhara malik kaun hai',
    'what do you know about the owner',
    'read ~/.bashrc',
    'delete file test.txt',
    'terminal me ls -la chalao',
    '9988776655 ko whatsapp message bhejo hello',
    'send whatsapp message to Rahul hi',
    'work', // owner's learned keyword!
    'haan', // trying to confirm owner's parked destructive action!
    'yes',
    'nahi',
  ];
  for (const text of plainCommandAttempts) {
    const res = await wa.simulate(text, GUEST, { senderName: 'Rahul' });
    assert.equal(res.blocked, true, `Expected plain-language command to be blocked for guest: "${text}"`);
    assert.match(res.sent[0].text, /Command Blocked/i);
  }

  // Verify owner state was 100% untouched by all guest command attempts:
  assert.equal(store.data.todos.length, 0);
  assert.equal(store.data.notes.length, 0);
  assert.equal(store.data.reminders.length, 0);
  assert.ok(store.data.pending, 'Owner pending confirmation must not be consumed or cancelled by guest');
  assert.equal(Object.keys(store.data.contacts).length, 0);

  // Direct calls to agent.handle() or actions.execute() with non-owner context are also blocked
  const directHandle = await agent.handle('screenshot bhej do', { isOwner: false, senderNumber: GUEST });
  assert.match(directHandle, /Command Blocked/i);
  const directAction = await agent.actions.execute('screenshot', {}, { isOwner: false });
  assert.equal(directAction.ok, false);
  assert.equal(directAction.blocked, true);
});

test('Controlled Multi-User Messaging: Owner outbound /msg, /reply, /broadcast, /contact, NLP intents & Guest modes', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guest-messaging-'));
  const store = new Store(path.join(tmp, 'store.json'));
  const config = {
    dryRun: true,
    ownerNumber: OWNER,
    agentNumber: AGENT,
    timezone: 'Asia/Kolkata',
    aiProvider: 'none',
    guestMode: 'all',
    guestNotifyBlocked: false,
    guestNotifyMessages: true,
    guestRateLimitPerMinute: 3,
    outboundRateLimitPerMinute: 10,
    downloadsDir: tmp,
    sharedDir: tmp,
  };
  const agent = createAgent({ config, store, log: { info() {}, warn() {}, error() {} } });
  const wa = createWhatsApp({ config, store, agent, log: { info() {}, warn() {}, error() {} } });

  const RAHUL = '919876543210';
  const PRIYA = '919123456789';
  const STRANGER = '919000011111';

  // 1. Safe guest conversation works in 'all' mode and stays isolated from owner history
  const chat1 = await wa.simulate('Namaste', RAHUL, { senderName: 'Rahul' });
  assert.equal(chat1.ignored, false);
  assert.equal(chat1.blocked, false);
  assert.equal(chat1.sent[0].to, RAHUL);
  assert.match(chat1.sent[0].text, /Namaste \*Rahul\*/);
  // Owner also received notification because guestNotifyMessages=true
  assert.equal(chat1.sent[1].to, OWNER);
  assert.match(chat1.sent[1].text, /Guest Message/);

  const mathChat = await wa.simulate('25% of 400', RAHUL, { senderName: 'Rahul' });
  assert.equal(mathChat.blocked, false);
  assert.match(mathChat.sent[0].text, /100/);

  // Isolated guest history vs clean owner history
  assert.equal(store.data.history.length, 0);
  assert.ok(store.data.guestChats[RAHUL].history.length >= 2);

  // 2. Owner can reply to the last guest with /reply
  const replyOut = await wa.simulate('/reply Haan Rahul bhai, main 5 baje free hoon', OWNER);
  assert.equal(replyOut.ignored, false);
  // First message in simulated batch is the outbound WhatsApp message to RAHUL, second is confirmation to OWNER
  assert.equal(replyOut.sent[0].to, RAHUL);
  assert.equal(replyOut.sent[0].text, 'Haan Rahul bhai, main 5 baje free hoon');
  assert.equal(replyOut.sent[1].to, OWNER);
  assert.match(replyOut.sent[1].text, /WhatsApp Message Sent/);

  // 3. Owner saves contacts via /contact and Hinglish NLP, then messages by name
  const save1 = await agent.handle('/contact add Rahul 9876543210');
  assert.match(save1, /Contact Saved:\* \*Rahul\* → `\+919876543210`/);

  const save2 = await agent.handle('Priya ka number 9123456789 contact me save kar lo');
  assert.match(save2, /Contact Saved:\* \*Priya\* → `\+919123456789`/);

  const listReply = await agent.handle('/contacts');
  assert.match(listReply, /Rahul/);
  assert.match(listReply, /Priya/);

  // Owner sends outbound message using Hinglish natural language
  const beforeNlpSend = wa.state.simulated.length;
  const nlpMsgReply = await agent.handle('Rahul ko whatsapp message bhejo ki meeting 6 baje hai');
  assert.match(nlpMsgReply, /WhatsApp Message Sent/);
  const sentViaNlp = wa.state.simulated.slice(beforeNlpSend);
  assert.equal(sentViaNlp[0].to, RAHUL);
  assert.equal(sentViaNlp[0].text, 'meeting 6 baje hai');

  // Owner broadcasts to both Rahul and Priya
  const beforeBcast = wa.state.simulated.length;
  const bcastReply = await agent.handle('/broadcast Rahul, Priya | Dinner at 8pm!');
  assert.match(bcastReply, /Broadcast Summary \(2\)/);
  const bcastSent = wa.state.simulated.slice(beforeBcast);
  assert.equal(bcastSent.length, 2);
  assert.equal(bcastSent[0].to, RAHUL);
  assert.equal(bcastSent[1].to, PRIYA);

  // 4. Guest Mode: CONTACTS ONLY (/guest contacts)
  await agent.handle('/guest contacts');
  const strangerInContactsMode = await wa.simulate('Hello!', STRANGER);
  assert.equal(strangerInContactsMode.ignored, true);
  assert.equal(strangerInContactsMode.reason, 'not_in_contacts');

  // Saved contact (Priya) is allowed in contacts mode
  const priyaInContactsMode = await wa.simulate('Hello!', PRIYA, { senderName: 'Priya' });
  assert.equal(priyaInContactsMode.ignored, false);
  assert.equal(priyaInContactsMode.blocked, false);

  // Explicitly /allow Stranger in contacts mode
  await agent.handle(`/allow ${STRANGER}`);
  const strangerAfterAllow = await wa.simulate('Hello!', STRANGER);
  assert.equal(strangerAfterAllow.ignored, false);

  // 5. Block / Unblock (/block, /unblock)
  await agent.handle('/block Priya');
  const priyaBlocked = await wa.simulate('Hello again', PRIYA);
  assert.equal(priyaBlocked.ignored, true);
  assert.equal(priyaBlocked.reason, 'blocked');

  await agent.handle('/unblock Priya');
  const priyaUnblocked = await wa.simulate('Back again', PRIYA);
  assert.equal(priyaUnblocked.ignored, false);

  // 6. Per-guest rate limit (configured at 3 msgs/min in this test)
  // Rahul already sent 2 messages above; 3rd succeeds, 4th is rate-limited
  const rahul3 = await wa.simulate('Question 3', RAHUL);
  assert.equal(rahul3.ignored, false);
  const rahul4 = await wa.simulate('Question 4 flood', RAHUL);
  assert.equal(rahul4.ignored, true);
  assert.equal(rahul4.reason, 'rate_limited');

  // 7. Guest Mode: OFF (/guest off) ignores everyone except owner, but owner can still /msg others
  await agent.handle('/guest off');
  const priyaWhenOff = await wa.simulate('Are you there?', PRIYA);
  assert.equal(priyaWhenOff.ignored, true);
  assert.equal(priyaWhenOff.reason, 'guest_mode_off');

  const ownerStillSends = await agent.handle('/msg Priya | Still reachable from owner');
  assert.match(ownerStillSends, /WhatsApp Message Sent/);
});

test('Owner Approval Gate (yes / no / no send this instead) + Owner Location Access & Guest Location Lock', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-approval-loc-'));
  const store = new Store(path.join(tmp, 'store.json'));
  const config = {
    dryRun: true,
    ownerNumber: OWNER,
    agentNumber: AGENT,
    timezone: 'Asia/Kolkata',
    aiProvider: 'none',
    // Default mode is 'approval' (Owner Approval Gate)
    guestMode: 'approval',
    guestRateLimitPerMinute: 20,
    outboundRateLimitPerMinute: 12,
    downloadsDir: tmp,
    sharedDir: tmp,
  };
  const agent = createAgent({ config, store, log: { info() {}, warn() {}, error() {} } });
  const wa = createWhatsApp({ config, store, agent, log: { info() {}, warn() {}, error() {} } });

  const RAHUL = '919876543210';

  // ── 1. Non-owner message is held for approval; Owner gets Who + Time + Proposed AI Reply ──
  const incoming1 = await wa.simulate('Namaste', RAHUL, { senderName: 'Rahul' });
  assert.equal(incoming1.ignored, false);
  assert.equal(incoming1.heldForApproval, true);
  // Nothing was sent to Rahul yet — only the approval card was sent to OWNER!
  assert.equal(incoming1.sent.length, 1);
  assert.equal(incoming1.sent[0].to, OWNER);
  assert.match(incoming1.sent[0].text, /Waiting for Your Approval/);
  assert.match(incoming1.sent[0].text, /Who Sent:\* \*Rahul\* \(`\+919876543210`\)/);
  assert.match(incoming1.sent[0].text, /Time:\* .*Asia\/Kolkata/);
  assert.match(incoming1.sent[0].text, /AI Thinking of Sending:/);

  // Owner says "yes" -> sends the AI's proposed reply to Rahul!
  const approve1 = await wa.simulate('yes', OWNER);
  assert.equal(approve1.sent.length, 2);
  assert.equal(approve1.sent[0].to, RAHUL);
  assert.match(approve1.sent[0].text, /Namaste \*Rahul\*/);
  assert.equal(approve1.sent[1].to, OWNER);
  assert.match(approve1.sent[1].text, /Approved & Sent AI Reply/);

  // ── 2. Second message from non-owner -> Owner says "no" -> Nothing sent to Rahul ──
  const incoming2 = await wa.simulate('25% of 800', RAHUL, { senderName: 'Rahul' });
  assert.equal(incoming2.heldForApproval, true);
  assert.equal(incoming2.sent.length, 1);
  assert.equal(incoming2.sent[0].to, OWNER);
  assert.match(incoming2.sent[0].text, /200/);

  const reject2 = await wa.simulate('no', OWNER);
  // Only confirmation to OWNER, zero messages to RAHUL!
  assert.equal(reject2.sent.length, 1);
  assert.equal(reject2.sent[0].to, OWNER);
  assert.match(reject2.sent[0].text, /Not Sent/);

  // ── 3. Third message from non-owner -> Owner says "no send this instead: ..." ──
  const incoming3 = await wa.simulate('Hello', RAHUL, { senderName: 'Rahul' });
  assert.equal(incoming3.heldForApproval, true);

  const custom3 = await wa.simulate('no send this instead: Bhai main abhi meeting me hoon, 6 baje call karta hoon', OWNER);
  assert.equal(custom3.sent.length, 2);
  assert.equal(custom3.sent[0].to, RAHUL);
  assert.equal(custom3.sent[0].text, 'Bhai main abhi meeting me hoon, 6 baje call karta hoon');
  assert.equal(custom3.sent[1].to, OWNER);
  assert.match(custom3.sent[1].text, /Sent Your Custom Reply/);

  // Also test Hinglish "nahi yeh bhejo: ..."
  const incoming4 = await wa.simulate('Hey', RAHUL, { senderName: 'Rahul' });
  assert.equal(incoming4.heldForApproval, true);
  const custom4 = await wa.simulate('nahi yeh bhejo: Kal subah 10 baje milte hain!', OWNER);
  assert.equal(custom4.sent[0].to, RAHUL);
  assert.equal(custom4.sent[0].text, 'Kal subah 10 baje milte hain!');

  // ── 4. Owner Location Access & Guest Location Lock ──
  await location.setOwnerLocation(
    store,
    config,
    { lat: 30.3165, lon: 78.0322, city: 'Dehradun', region: 'Uttarakhand', country: 'India', source: 'gps_pin' },
    { skipNetwork: true },
  );
  const locCard = await agent.handle('meri location kya hai');
  assert.match(locCard, /Your Current Location \(Owner-Only 🔒\)/);
  assert.match(locCard, /Dehradun/);
  assert.match(locCard, /30\.31650, 78\.03220/);

  const promptLine = location.formatLocationForOwnerPrompt(store, config);
  assert.match(promptLine, /Dehradun/);
  assert.match(promptLine, /30\.3165/);

  // Non-owner trying to ask for location via slash or natural language is strictly blocked!
  for (const locProbe of ['/location', 'meri location kya hai', 'apni location bhejo', 'where are you located', 'tum abhi kahan ho', 'owner ki location kya hai']) {
    const det = guests.detectGuestCommandAttempt(locProbe, store, config);
    assert.equal(det.blocked, true, `Expected guest location probe to be blocked: "${locProbe}"`);
  }
});

test('Natural-Language Dynamic Command Creation: inline, Hinglish, "create this as a command" from previous message, execution & guest firewall', async () => {
  const { agent, store, config } = makeAgent();

  // 1. Create a multi-step command from natural English description
  const createRes1 = await agent.handle(
    'create a command /study_prep that adds a todo: finish calculus and saves a note: formula sheet page 12',
  );
  assert.match(createRes1, /Custom Command Created:\* `\/study_prep`/);
  assert.equal(store.getLearned('study_prep')?.commands?.length, 2);

  // Execute the newly created command via `/study_prep`
  const exec1 = await agent.handle('/study_prep');
  assert.match(exec1, /\/study_prep \(2 steps\)/);
  assert.match(exec1, /Added #1: finish calculus/);
  assert.match(exec1, /Saved note #1/);

  // 2. Create a command in Hinglish ("/<name> naam ka command banao jo ...")
  const createRes2 = await agent.handle(
    '/my_digest naam ka command banao jo mere todos dikhaye aur mere notes dikhaye',
  );
  assert.match(createRes2, /Custom Command Created:\* `\/my_digest`/);

  // Execute via bare keyword `my_digest` AND via natural language `"run /my_digest command"`
  const exec2Bare = await agent.handle('my_digest');
  assert.match(exec2Bare, /finish calculus/);
  assert.match(exec2Bare, /formula sheet page 12/);

  const exec2Natural = await agent.handle('run /my_digest command');
  assert.match(exec2Natural, /finish calculus/);
  assert.match(exec2Natural, /formula sheet page 12/);

  // 3. Retrospective command creation: owner sends a task first, then says "create this as a command /<name>"
  const taskOut = await agent.handle('25% of 800');
  assert.match(taskOut, /200/);
  assert.equal(store.getLastOwnerTask(), '25% of 800');

  const retroCreate = await agent.handle('create this as a command /calc200');
  assert.match(retroCreate, /Custom Command Created:\* `\/calc200`/);
  assert.match(retroCreate, /Created from your previous message: "25% of 800"/);

  // Now invoke `/calc200` — it executes the remembered natural step ("25% of 800")!
  const retroExec = await agent.handle('/calc200');
  assert.match(retroExec, /\/calc200/);
  assert.match(retroExec, /200/);

  // 4. Inline "<task> — create this as a command /<name> and run it"
  const inlineAndRun = await agent.handle(
    'todo: revise chapter 9 — create this as a command /rev9 and run it',
  );
  assert.match(inlineAndRun, /Custom Command Created:\* `\/rev9`/);
  assert.match(inlineAndRun, /Added #2: revise chapter 9/);

  // 5. AI Tool actions (`create_custom_command`, `list_custom_commands`, `delete_custom_command`)
  const toolCreate = await agent.actions.execute(
    'create_custom_command',
    { name: 'quick_status', task: '/ping | /todo list' },
    { isOwner: true },
  );
  assert.equal(toolCreate.ok, true);
  assert.match(toolCreate.text, /\/quick_status/);

  const toolList = await agent.actions.execute('list_custom_commands', {}, { isOwner: true });
  assert.equal(toolList.ok, true);
  assert.match(toolList.text, /\/study_prep/);
  assert.match(toolList.text, /\/quick_status/);

  // 6. Non-owner is strictly blocked from creating, running, or deleting custom commands
  for (const guestAttempt of [
    '/study_prep',
    'study_prep',
    'run /study_prep command',
    'create a command /hack that opens terminal',
    'delete command /study_prep',
  ]) {
    const det = guests.detectGuestCommandAttempt(guestAttempt, store, config);
    assert.equal(det.blocked, true, `Expected guest command attempt to be blocked: "${guestAttempt}"`);
  }

  // 7. Delete custom command via natural language
  const delRes = await agent.handle('delete command /calc200');
  assert.match(delRes, /\/calc200 deleted/);
  assert.equal(store.getLearned('calc200'), null);
});

test('Live PC Action Recorder, Learner & Replayer: "mere actions record karo", desktop events, save as command & repeat N times', async () => {
  const { agent, store, config } = makeAgent();

  // 1. Owner starts recording PC actions in Hinglish
  const startMsg = await agent.handle('jo main computer me kar raha hoon wo record karo');
  assert.match(startMsg, /PC Action Recording Started!/);
  assert.ok(actionrecorder.getActiveRecording(store));

  // 2. Simulate live PC actions performed by the owner on the desktop + WhatsApp commands
  //    a) Typing keystrokes within 4s coalesces into one `type` event
  const now = Date.now();
  actionrecorder.recordDesktopEvent(store, { type: 'type', text: 'git ', field: 'Terminal', ts: now });
  actionrecorder.recordDesktopEvent(store, { type: 'type', text: 'status', field: 'Terminal', ts: now + 300 });
  assert.equal(actionrecorder.getActiveRecording(store).events.length, 1);
  assert.equal(actionrecorder.getActiveRecording(store).events[0].text, 'git status');

  //    b) Now record deterministic offline-runnable steps (todo + note) for end-to-end replay verification
  store.data.activeActionRecording.events = []; // reset to clean deterministic steps for replay test
  await agent.handle('/todo add review PR');
  await agent.handle('/note build passed');

  // Check status while recording
  const statusMsg = await agent.handle('/watchme status');
  assert.match(statusMsg, /Live PC Action Recording ON/);
  assert.match(statusMsg, /2 step\(s\)/);

  // 3. Owner stops recording in Hinglish and names it `/pr_check`
  const stopMsg = await agent.handle('recording band karo aur /pr_check command bana do');
  assert.match(stopMsg, /PC Actions Learned & Saved as `\/pr_check`!/);
  assert.equal(actionrecorder.getActiveRecording(store), null);
  assert.ok(store.getLearned('pr_check'));

  // 4. Owner asks to repeat their actions ("mere actions repeat karo")
  const repeat1 = await agent.handle('mere actions repeat karo');
  assert.match(repeat1, /Repeated PC Actions: `\/pr_check`/);
  assert.match(repeat1, /Added #2: review PR/);
  assert.match(repeat1, /Saved note #2/);

  // 5. Owner asks to repeat `/pr_check` 2 times ("repeat /pr_check 2 times")
  const repeat2x = await agent.handle('repeat /pr_check 2 times');
  assert.match(repeat2x, /× 2 times/);
  assert.match(repeat2x, /Pass 1\/2:/);
  assert.match(repeat2x, /Pass 2\/2:/);
  assert.equal(store.data.todos.length, 4);

  // 6. Owner can also invoke `/pr_check` directly as a learned slash command
  const directSlash = await agent.handle('/pr_check');
  assert.match(directSlash, /\/pr_check \(2 steps\)/);
  assert.equal(store.data.todos.length, 5);

  // 7. Non-owners are strictly blocked from recording, stopping, or repeating PC actions
  for (const guestProbe of [
    '/watchme start',
    'mere actions record karo',
    'jo main computer me kar raha hoon wo record karo',
    'stop recording',
    'mere actions repeat karo',
    'repeat /pr_check 2 times',
  ]) {
    const det = guests.detectGuestCommandAttempt(guestProbe, store, config);
    assert.equal(det.blocked, true, `Expected guest action-recorder attempt to be blocked: "${guestProbe}"`);
  }
});

test('High-Precision Micro-Action & Button-Click Recognition: widget hit-testing, XI2 stream, sensor fusion, double-click, right-click, drag, scroll & Backspace', async () => {
  const { store } = makeAgent();

  // 1. Widget bounding-box hit-testing resolves the smallest inner button inside a parent container
  const widgets = [
    { role: 'panel', name: 'Main Toolbar', x: 0, y: 0, w: 1200, h: 80, cx: 600, cy: 40 },
    { role: 'push button', name: 'Save File', x: 120, y: 15, w: 90, h: 36, cx: 165, cy: 33 },
    { role: 'check box', name: 'Auto Format', x: 240, y: 18, w: 110, h: 30, cx: 295, cy: 33 },
  ];
  const hitSave = actionrecorder.matchWidgetAtPoint(150, 30, widgets);
  assert.ok(hitSave);
  assert.equal(hitSave.label, 'Save File');
  assert.equal(hitSave.role, 'push button');

  const hitCheck = actionrecorder.matchWidgetAtPoint(260, 28, widgets);
  assert.ok(hitCheck);
  assert.equal(hitCheck.label, 'Auto Format');
  assert.equal(hitCheck.role, 'check box');

  // 2. XInput2 (XI2) raw event block parser recognizes ButtonPress, ButtonRelease, wheel scroll & KeyPress
  const xi2LeftPress = actionrecorder.parseXi2EventBlock(
    'EVENT type 15 (RawButtonPress)\n    detail: 1\n    root: 420.00/310.00\n',
    { mouseX: 0, mouseY: 0 },
  );
  assert.equal(xi2LeftPress.kind, 'button_press');
  assert.equal(xi2LeftPress.button, 'left');
  assert.equal(xi2LeftPress.x, 420);
  assert.equal(xi2LeftPress.y, 310);

  const xi2RightPress = actionrecorder.parseXi2EventBlock(
    'EVENT type 4 (ButtonPress)\n    detail: 3\n    root: 500.00/220.00\n',
    { mouseX: 0, mouseY: 0 },
  );
  assert.equal(xi2RightPress.kind, 'button_press');
  assert.equal(xi2RightPress.button, 'right');

  const xi2ScrollDown = actionrecorder.parseXi2EventBlock(
    'EVENT type 4 (ButtonPress)\n    detail: 5\n    root: 500.00/220.00\n',
    { mouseX: 500, mouseY: 220 },
  );
  assert.equal(xi2ScrollDown.kind, 'scroll');
  assert.equal(xi2ScrollDown.direction, 'down');

  const xi2Backspace = actionrecorder.parseXi2EventBlock(
    'EVENT type 2 (KeyPress)\n    detail: 22\n',
    {},
  );
  assert.equal(xi2Backspace.kind, 'key_press');
  assert.equal(xi2Backspace.key, 'BackSpace');

  // 3. Start recording and test sensor fusion + micro-actions
  await actionrecorder.startActionRecording(store, { name: 'micro_flow' });
  const t0 = 1_700_000_000_000;

  // 3a. Raw X11 left click at (420, 310) followed 120ms later by AT-SPI push-button event -> fuses into 1 labeled button click
  actionrecorder.recordDesktopEvent(store, {
    type: 'click',
    button: 'left',
    clicks: 1,
    x: 420,
    y: 310,
    ts: t0,
  });
  actionrecorder.recordDesktopEvent(store, {
    type: 'click',
    button: 'left',
    clicks: 1,
    label: 'Submit Order',
    role: 'push button',
    app: 'Firefox',
    ts: t0 + 120,
  });
  let evs = actionrecorder.getActiveRecording(store).events;
  assert.equal(evs.length, 1, 'Raw coordinate click + AT-SPI button press should fuse into 1 event');
  assert.equal(evs[0].label, 'Submit Order');
  assert.equal(evs[0].role, 'push button');
  assert.equal(evs[0].x, 420);
  assert.equal(evs[0].y, 310);

  // 3b. Rapid second left click at (800, 500) within 300ms upgrades to `double_click`
  actionrecorder.recordDesktopEvent(store, {
    type: 'click',
    button: 'left',
    clicks: 1,
    x: 800,
    y: 500,
    label: 'Project Folder',
    role: 'icon',
    ts: t0 + 1000,
  });
  actionrecorder.recordDesktopEvent(store, {
    type: 'click',
    button: 'left',
    clicks: 1,
    x: 802,
    y: 499,
    label: 'Project Folder',
    role: 'icon',
    ts: t0 + 1250,
  });
  evs = actionrecorder.getActiveRecording(store).events;
  assert.equal(evs.length, 2);
  assert.equal(evs[1].type, 'double_click');
  assert.equal(evs[1].clicks, 2);
  assert.equal(evs[1].label, 'Project Folder');

  // 3c. Right-click, middle-click, drag, coalesced scroll, Backspace text editing, and shortcut key
  actionrecorder.recordDesktopEvent(store, {
    type: 'right_click',
    x: 610,
    y: 410,
    label: 'index.js',
    role: 'tree item',
    ts: t0 + 2000,
  });
  actionrecorder.recordDesktopEvent(store, {
    type: 'drag',
    fromX: 100,
    fromY: 120,
    toX: 340,
    toY: 280,
    ts: t0 + 3000,
  });
  actionrecorder.recordDesktopEvent(store, {
    type: 'scroll',
    direction: 'down',
    amount: 3,
    ts: t0 + 4000,
  });
  actionrecorder.recordDesktopEvent(store, {
    type: 'scroll',
    direction: 'down',
    amount: 4,
    ts: t0 + 4300,
  });
  // Typing with Backspace correction: "git stats" + Backspace + "us" => "git status"
  actionrecorder.recordDesktopEvent(store, { type: 'type', text: 'git stats', ts: t0 + 5000 });
  actionrecorder.recordDesktopEvent(store, { type: 'backspace', count: 1, ts: t0 + 5200 });
  actionrecorder.recordDesktopEvent(store, { type: 'type', text: 'us', ts: t0 + 5400 });
  actionrecorder.recordDesktopEvent(store, { type: 'key', key: 'Return', ts: t0 + 5700 });

  evs = actionrecorder.getActiveRecording(store).events;
  const scrollEv = evs.find((e) => e.type === 'scroll');
  assert.equal(scrollEv.amount, 7, 'Consecutive scrolls in the same direction should coalesce');
  const typeEv = evs.find((e) => e.type === 'type');
  assert.equal(typeEv.text, 'git status', 'Backspace should edit the active typed text buffer');

  // 4. Stop recording and verify compiled steps preserve every micro-action
  const saved = await actionrecorder.stopActionRecording(store, { name: 'micro_flow', saveAsCommand: true });
  assert.equal(saved.ok, true);
  const types = saved.steps.map((s) => s.actionType);
  assert.deepEqual(types, [
    'click',
    'double_click',
    'right_click',
    'drag',
    'scroll',
    'type',
    'key',
  ]);
  assert.equal(saved.steps[0].target, 'Submit Order');
  assert.match(saved.steps[0].label, /Submit Order/);
  assert.equal(saved.steps[0].x, 420);
  assert.equal(saved.steps[1].clicks, 2);
  assert.equal(saved.steps[2].button, 'right');
  assert.equal(saved.steps[3].args, 'drag 100 120 340 280');
  assert.equal(saved.steps[4].args, 'scroll down 7');
  assert.equal(saved.steps[5].text, 'git status');
  assert.equal(saved.steps[6].key, 'Return');
});

test('Advanced Vocabulary Intelligence & Turbo Speed: Hinglish/Slang/Typo NLP, Fuzzy Slash Commands, Trilingual Word-Power, Hedged Racing & EMA Latency Routing', async () => {
  const { agent } = makeAgent();

  // 1. Hinglish / SMS shorthand / Slang / Typo intent resolution (< 0.5ms offline)
  assert.deepEqual(nlp.parseIntent('chrone kholdo'), { cmd: 'open', args: 'chrome' });
  assert.deepEqual(nlp.parseIntent('ss bhjde'), { cmd: 'screenshot', args: '' });
  assert.deepEqual(nlp.parseIntent('awaz kam krdo'), { cmd: 'pc', args: 'volume down' });
  assert.deepEqual(nlp.parseIntent('pump up the volume'), { cmd: 'pc', args: 'volume up' });
  assert.deepEqual(nlp.parseIntent('shant kardo'), { cmd: 'pc', args: 'volume mute' });
  assert.deepEqual(nlp.parseIntent('btry kitni hai'), { cmd: 'pc', args: 'battery' });
  assert.deepEqual(nlp.parseIntent('mosam kaisa hai'), { cmd: 'weather', args: '' });
  assert.deepEqual(nlp.parseIntent('fire up spotify'), { cmd: 'open', args: 'spotify' });
  assert.deepEqual(nlp.parseIntent('dim the screen'), { cmd: 'pc', args: 'brightness down' });

  // 2. Fuzzy Slash-Command Typo Auto-Correction (Damerau-Levenshtein <= 2)
  assert.equal(vocab.fuzzyMatchSlashCommand('screnshot'), 'screenshot');
  assert.equal(vocab.fuzzyMatchSlashCommand('wether'), 'weather');
  assert.equal(vocab.fuzzyMatchSlashCommand('loction'), 'location');
  assert.equal(vocab.fuzzyMatchSlashCommand('watcme'), 'watchme');
  const typoRem = await agent.handle('/remnders');
  assert.match(typoRem, /No reminders set/);

  // 3. Trilingual Word-Power Lexicon (English + Hindi + Hinglish + Synonyms + Antonyms)
  const wordReply = await agent.handle('ephemeral ka matlab kya hai');
  assert.match(wordReply, /\*ephemeral\*/i);
  assert.match(wordReply, /English/);
  assert.match(wordReply, /Hindi/);
  assert.match(wordReply, /Hinglish/);
  assert.match(wordReply, /transient/);

  const slashVocab = await agent.handle('/vocab pragmatic');
  assert.match(slashVocab, /\*pragmatic\*/i);
  assert.match(slashVocab, /practical/);

  const wodReply = await agent.handle('word of the day');
  assert.match(wodReply, /Power Word of the Day/);

  // 4. Parallel Hedged Model Racing (`raceModels`) picks the fast backup when primary lags
  const slowModel = { id: 'slow:1', label: 'Slow' };
  const fastModel = { id: 'fast:2', label: 'Fast' };
  const winner = await ai.raceModels(
    [slowModel, fastModel],
    async (m) => {
      if (m.id === 'slow:1') {
        await new Promise((r) => setTimeout(r, 120));
        return { text: 'from slow' };
      }
      await new Promise((r) => setTimeout(r, 10));
      return { text: 'from fast' };
    },
    { hedgeDelayMs: 20 },
  );
  assert.equal(winner.model.id, 'fast:2');
  assert.equal(winner.result.text, 'from fast');

  // 5. Adaptive EMA Latency Routing promotes the faster proven brain
  const router = createModelRouter({
    config: {
      localApiUrl: 'http://127.0.0.1:8080/v1',
      localModel: 'qwen2.5-7b',
      ollamaModel: 'qwen2.5:7b',
      aiProvider: 'auto',
    },
    log: { info() {}, warn() {}, error() {} },
  });
  router.record('local:qwen2.5-7b', { ok: true, ms: 2200, tier: 1 });
  router.record('ollama:qwen2.5:7b', { ok: true, ms: 140, tier: 1 });
  const plan = router.plan({ text: 'hi', needsTools: false });
  assert.equal(plan.candidates[0].id, 'ollama:qwen2.5:7b', 'Lower EMA latency brain should be promoted first');
});

test('100% Answer Accuracy Engine: Deterministic Algebra/Systems/NumberTheory/Stats/Finance/Base/Calendar/Science, Pre-Flight Grounding, Low-Temp Precision & /verify', async () => {
  const { agent, config } = makeAgent();

  // 1. Quadratic, Linear & 2x2 System Solvers with plug-back proof
  const quadReply = await agent.handle('solve x^2 - 5x + 6 = 0');
  assert.match(quadReply, /100% Verified Quadratic Solution/);
  assert.match(quadReply, /x₁ = 3/);
  assert.match(quadReply, /x₂ = 2/);
  assert.match(quadReply, /Plug-Back Proof/);

  const linReply = await agent.handle('solve 3x + 7 = 22');
  assert.match(linReply, /x = 5/);

  const sysReply = await agent.handle('solve 2x + 3y = 12 and x - y = 1');
  assert.match(sysReply, /x = 3/);
  assert.match(sysReply, /y = 2/);

  // 2. Number Theory (GCD/HCF, LCM, Factorial, nCr, nPr, Prime Factorization, Fibonacci)
  assert.match(await agent.handle('gcd of 48 and 180'), /\*12\*/);
  assert.match(await agent.handle('12 aur 18 ka lcm'), /\*36\*/);
  assert.match(await agent.handle('factorial of 10'), /3628800/);
  assert.match(await agent.handle('10C3'), /\*120\*/);
  assert.match(await agent.handle('8P2'), /\*56\*/);
  assert.match(await agent.handle('is 97 prime?'), /Prime Number/);
  assert.match(await agent.handle('prime factors of 360'), /2\^3 × 3\^2 × 5/);
  assert.match(await agent.handle('15th fibonacci number'), /\*610\*/);

  // 3. Statistics, Compound Interest, Multi-term Percentages & Discounts
  const statsReply = await agent.handle('stats of 10, 20, 20, 40, 50');
  assert.match(statsReply, /Mean \(Average\)\*: \*28\*/);
  assert.match(statsReply, /Median\*: \*20\*/);
  assert.match(statsReply, /Mode\*: \*20\*/);

  const ciReply = await agent.handle('compound interest on 10000 at 10% for 2 years');
  assert.match(ciReply, /2100/);

  assert.match(await agent.handle('what is 15% of 240 + 35% of 600?'), /\*246\*/);
  assert.match(await agent.handle('20% discount on 1500'), /\*1200\*/);

  // 4. Base Conversions, Roman Numerals & Historical Proleptic Calendar
  assert.match(await agent.handle('255 in binary'), /11111111/);
  assert.match(await agent.handle('255 in hex'), /FF/);
  assert.match(await agent.handle('2026 in roman numerals'), /MMXXVI/);
  assert.match(await agent.handle('roman numeral MCMXCIV to number'), /\*1994\*/);
  assert.match(await agent.handle('what day of the week was 15 August 1947'), /Friday/);
  assert.match(await agent.handle('15 August 1947 ko kaunsa din tha'), /Friday/);
  assert.match(await agent.handle('days between 2024-01-01 and 2024-12-31'), /365 days/);

  // 5. Verified Scientific Constants, Periodic Table Elements & Capitals
  assert.match(await agent.handle('what is the speed of light?'), /299,792,458/);
  assert.match(await agent.handle('atomic number of gold'), /\*79\*/);
  assert.match(await agent.handle('capital of Australia'), /Canberra/);
  assert.match(await agent.handle('Uttarakhand ki rajdhani kya hai'), /Dehradun/);

  // 6. Pre-Flight Ground-Truth Injection & Low-Temperature Precision Selection
  assert.equal(accuracy.selectOptimalTemperature('solve x^2 - 5x + 6 = 0'), 0.05);
  assert.equal(accuracy.selectOptimalTemperature('what is the capital of France?'), 0.12);
  const directive = accuracy.buildAccuracyDirective('If a server costs 2400 and gets 15% of 2400 discount, and 45 * 18 extra, explain.', config);
  assert.match(directive, /VERIFIED GROUND-TRUTH FACTS/);
  assert.match(directive, /15% of 2400 = 360/);
  assert.match(directive, /45 \* 18 = 810/);

  // 7. Post-Generation Consistency Auditor fixes missing exact values & strips <think> tags
  const cleaned = accuracy.postProcessAiAnswer('<think>internal reasoning</think>The answer is around three hundred.', {
    userText: '15% of 2400',
    config,
  });
  assert.doesNotMatch(cleaned, /<think>/);
  assert.match(cleaned, /Verified Exact Ground-Truth.*360/);

  // 8. `/accuracy`, `/accuracy test`, `/verify`, and Hinglish NLP triggers
  const benchOut = await agent.handle('/accuracy test');
  assert.match(benchOut, /10\/10 \(100%\)/);

  const accStatus = await agent.handle('accuracy status');
  assert.match(accStatus, /100% Answer Accuracy Engine/);

  const verifyOut = await agent.handle('100% sahi answer batao: solve x^2 - 7x + 12 = 0');
  assert.match(verifyOut, /x₁ = 4/);
  assert.match(verifyOut, /x₂ = 3/);
});

test('34. Strict Question-Scope Precision ("Jo Pucha Uska Hi Answer") + Deep Hinglish & Impeccable English Mastery', async () => {
  const { agent } = makeAgent();

  // 1. Strict Question-Scope Precision: return ONLY what was asked, zero unasked extra dumps
  // Asking for GCD/HCF only -> must NOT dump LCM
  const gcdOnly = await agent.handle('bhai यार mujhe ek baat bata gcd of 48 and 180');
  assert.match(gcdOnly, /\*12\*/);
  assert.doesNotMatch(gcdOnly, /LCM/i);

  // Asking for LCM only -> must NOT dump GCD
  const lcmOnly = await agent.handle('hey bro can you tell me lcm of 12 and 18');
  assert.match(lcmOnly, /\*36\*/);
  assert.doesNotMatch(lcmOnly, /GCD/i);

  // Asking for Mean only -> must NOT dump Median / Mode / Variance / StdDev
  const meanOnly = await agent.handle('mean of 10, 20, 30, 40');
  assert.match(meanOnly, /\*25\*/);
  assert.doesNotMatch(meanOnly, /Median|Variance|Std Dev/i);

  // Asking for Binary only -> must NOT dump Hex / Octal
  const binOnly = await agent.handle('42 in binary');
  assert.match(binOnly, /101010/);
  assert.doesNotMatch(binOnly, /Hex:|Octal:/i);

  // Asking for Synonyms only -> must NOT dump full dictionary card with Antonyms/Examples
  const synOnly = await agent.handle('synonyms of resilient');
  assert.match(synOnly, /Synonyms of resilient/i);
  assert.doesNotMatch(synOnly, /Antonyms \(Vilom\)/i);

  // 2. Bilingual Language Classifier & Core Question Preamble Stripping
  assert.equal(bilingual.detectBilingualMode('bhai == aur === me kya farak hai?'), 'hinglish');
  assert.equal(bilingual.detectBilingualMode('What is the difference between == and === in JavaScript?'), 'english');
  assert.equal(
    bilingual.extractCoreQuestion('bhai yaar mujhe ek baat bata what is the speed of light?'),
    'what is the speed of light?',
  );

  // 3. Instant Hinglish vs English Corpus Mastery (language-mirrored answers in <1ms)
  const hinglishJs = await agent.handle('== aur === me kya farak hai');
  assert.match(hinglishJs, /type coercion/i);
  assert.match(hinglishJs, /dono check karta hai/i);

  const englishJs = await agent.handle('What is the difference between == and === in JavaScript?');
  assert.match(englishJs, /Loose Equality/);
  assert.match(englishJs, /Strict Equality/);

  const hinglishTcp = await agent.handle('TCP aur UDP me kya farak hai');
  assert.match(hinglishTcp, /connection-oriented/i);
  assert.match(hinglishTcp, /gaming/i);

  const englishTcp = await agent.handle('difference between TCP and UDP');
  assert.match(englishTcp, /Transmission Control Protocol/);
  assert.match(englishTcp, /User Datagram Protocol/);

  const hinglishCheckin = await agent.handle('kya haal hai bhai');
  assert.match(hinglishCheckin, /mast|set|bata/i);

  const englishCheckin = await agent.handle("how's it going?");
  assert.match(englishCheckin, /All systems are running smoothly/i);

  // 4. Bilingual Mastery Benchmark & `/train`, `/hinglish`, `/english` commands
  const biBench = bilingual.runBilingualMasteryBenchmark();
  assert.equal(biBench.pct, 100);

  const hinglishCmd = await agent.handle('/hinglish');
  assert.match(hinglishCmd, /Hinglish Mastery Mode: AT ITS BEST/);

  const englishCmd = await agent.handle('/english');
  assert.match(englishCmd, /Impeccable English Mastery Mode: ACTIVE/);

  const trainOut = await agent.handle('hinglish ki practice kar aur english bhi perfect kar');
  assert.match(trainOut, /Self-Training Complete! \(Bilingual Mastery Active\)/);
  assert.match(trainOut, /100%/);
});

test('35. All 15 Next-Gen Quality Features: Multi-Turn Follow-Up, Code Sandbox, DocQA, LiveFact, Format Selector, Self-Healing Macro, Error Watch, Clipboard Bridge, Conditional Workflow, Workspaces, Voice Summary, Guest Urgency/VIP Triage, Brief 2.0, Recall & Doctor Fix', async () => {
  const { agent, store } = makeAgent();

  // Feature 1: Multi-Turn Follow-Up Context Resolver ("isme 50 add karo", "usme 20% aur add kar", "iska 10% kitna hoga")
  assert.match(await agent.handle('200 + 50'), /\*250\*/);
  assert.match(await agent.handle('isme 50 add karo'), /\*300\*/);
  assert.match(await agent.handle('usme 20% aur add kar'), /\*360\*/);
  assert.match(await agent.handle('iska 10% kitna hoga'), /\*36\*/);
  assert.match(await agent.handle('multiply that by 3'), /\*108\*/);

  // Feature 2: Instant Code & Command Sandbox Runner (`/runjs`, `/runpy`, `/sql` + natural Hinglish)
  const jsOut = await agent.handle('/runjs [1, 2, 3, 4].map(x => x * x).join(",")');
  assert.match(jsOut, /JAVASCRIPT Sandbox Output/);
  assert.match(jsOut, /1,4,9,16/);

  const pyOut = await agent.handle('ye python code chala ke output dikha: sum([i*i for i in range(1, 6)])');
  assert.match(pyOut, /PYTHON Sandbox Output/);
  assert.match(pyOut, /55/);

  const sqlOut = await agent.handle('/sql SELECT 12 * 15 AS total;');
  assert.match(sqlOut, /SQL Sandbox Output/);
  assert.match(sqlOut, /180/);

  // Feature 3: Smart Document & Notes Q&A Brain (`/docqa` + natural language)
  await agent.handle('/note Invoice Total Amount is Rs 48,500 due on 30 Nov');
  const docAns = await agent.handle('mere notes me se Invoice Total Amount bata');
  assert.match(docAns, /Document & Notes Q&A/);
  assert.match(docAns, /48,500/);

  // Feature 4: Hallucination-Free Live Fact Verifier (`/livefact`)
  const factOut = await agent.handle('/livefact what is the speed of light');
  assert.match(factOut, /299,792,458/);
  assert.match(factOut, /Verified via Offline Deterministic Ground-Truth/);

  // Feature 5: Adaptive Answer Format Selector (`1 word me bata`, `1 line me bata`)
  const oneWord = await agent.handle('1 word me bata capital of Australia');
  assert.equal(oneWord, '*Canberra*');

  const oneLine = await agent.handle('1 line me bata TCP aur UDP me kya farak hai');
  assert.ok(!oneLine.includes('\n'));

  // Feature 6: Self-Healing PC Macro Replayer (`selfHealRecordedStep`)
  const healed = actionrecorder.selfHealRecordedStep(
    { type: 'click', target: 'Submit', x: 100, y: 100, args: 'click 100 100' },
    [{ label: 'Submit Button', x: 420, y: 680 }],
  );
  assert.equal(healed.healed, true);
  assert.deepEqual(healed.to, [420, 680]);
  assert.equal(healed.step.x, 420);
  assert.equal(healed.step.y, 680);

  // Feature 7: Live Screen Error Auto-Watcher (`/watch error` + `scanTextForScreenErrors`)
  const watchErr = await agent.handle('/watch error');
  assert.match(watchErr, /Live Screen Error Auto-Watcher: ON/);
  const errScan = quality15.scanTextForScreenErrors('Traceback (most recent call last):\n  File "app.py", line 4\nZeroDivisionError: division by zero');
  assert.equal(errScan.found, true);
  assert.match(errScan.alert, /ZeroDivisionError/);

  // Feature 8: Smart Clipboard Bridge (`parseClipboardBridgeIntent`)
  const clipSetIntent = nlp.parseIntent('pc pe copy kar de: https://github.com/pavit12301611/psd-observer');
  assert.equal(clipSetIntent?.cmd, 'pc');
  assert.match(clipSetIntent?.args ?? '', /^clipset https:\/\/github\.com/);
  const clipGetIntent = nlp.parseIntent('pc pe jo copy hai bhej');
  assert.equal(clipGetIntent?.cmd, 'pc');
  assert.equal(clipGetIntent?.args, 'clipboard');

  // Feature 9: Multi-Step Conditional Workflow Engine (`/if`, `"agar battery < 25 ..."`)
  const condOut = await agent.handle('/if battery < 25 then /ping else /status', { liveMetrics: { battery: 18 } });
  assert.match(condOut, /battery=18 < 25 → TRUE/);
  assert.match(condOut, /Pong!/);

  // Feature 10: Instant Workspace Switcher (`/workspace`, `"coding mode chalu kar"`)
  const wsList = await agent.handle('/workspace');
  assert.match(wsList, /Coding & Dev Workspace/);
  const wsStudy = await agent.handle('study mode chalu kar');
  assert.match(wsStudy, /Deep Study & Exam Prep Workspace Activated/);

  // Feature 11: Voice Note Hinglish-to-Action & Smart Summary (`/voicesummary`)
  const vSum = await agent.handle('/voicesummary Bhai aaj shaam 6 baje client meeting hai. Uske baad project report submit karni hai urgent.');
  assert.match(vSum, /Smart Voice\/Text Summary/);
  assert.match(vSum, /Action Items/);

  // Feature 12: Smart Guest Auto-Triage & VIP Contact Priority (`[🚨 URGENT]` + `[⭐ VIP]`)
  await agent.handle('/contact add Mom 919888777666');
  await agent.handle('/guest approval');
  const urgentGuest = await agent.handleGuest('Beta urgent hospital me call uthao jaldi', {
    senderNumber: '919888777666',
    senderName: 'Mom',
  });
  assert.equal(urgentGuest.heldForApproval, true);
  assert.match(urgentGuest.notifyOwnerText, /URGENT \+ VIP CONTACT/);

  // Feature 13: Proactive Daily Briefing 2.0 (`/brief` includes location, pending approvals & goals)
  await agent.handle('/location set Dehradun');
  await agent.handle('/persona goal Launch PSD_Ai v4');
  const brief2 = await agent.handle('/brief');
  assert.match(brief2, /Dehradun/);
  assert.match(brief2, /Pending Guest Approvals/);
  assert.match(brief2, /Launch PSD_Ai v4/);

  // Feature 14: Offline Fuzzy Recall Search Across All Memory (`/recall`, `"maine ... ke baare me kya bataya tha"`)
  const recallOut = await agent.handle('maine Invoice ke baare me kya bataya tha');
  assert.match(recallOut, /Instant Memory Recall/);
  assert.match(recallOut, /48,500/);

  // Feature 15: Zero-Downtime Self-Doctor & Auto-Repair (`/doctor fix`, `"doctor fix karo"`)
  const docFix = await agent.handle('doctor fix karo');
  assert.match(docFix, /Zero-Downtime Self-Doctor & Auto-Repair Complete/);
  assert.match(docFix, /AI Router Cooldowns Cleared/);
  assert.ok(store.data.turnContext);
});

test('36. All 15 Additional Quality Features (#16–#30): Expense Tracker, Habit & Streak Coach, Git Autopilot, Smart Grabber, Converter, Live Scribe, NetCheck, USB Guard, Vault, Tone Rewriter, Pomodoro, Ports, Guardian, Quizzer & Time-Machine Backup', async () => {
  const { agent } = makeAgent();

  // Feature 16: Smart Expense & UPI/Bill Tracker (`/expense` + Hinglish `"aaj 250 Zomato pe kharch hue"`)
  await agent.handle('/expense budget 1000');
  const exp1 = await agent.handle('aaj 250 Zomato pe kharch hue');
  assert.match(exp1, /Expense Recorded/);
  assert.match(exp1, /Food & Dining/);
  const exp2 = await agent.handle('80 rs auto me lage');
  assert.match(exp2, /Transport & Travel/);
  const expSum = await agent.handle('mera kharcha kitna hua');
  assert.match(expSum, /Total Spent\*: \*₹330/);
  assert.match(expSum, /Within Budget/);

  // Feature 17: Intelligent Habit & Streak Coach (`/habit`, `"gym done"`, `"meri habits dikhao"`)
  await agent.handle('/habit add Gym');
  const habDone = await agent.handle('aaj gym kar liya');
  assert.match(habDone, /Habit Completed Today\*: \*Gym\*/i);
  assert.match(habDone, /1 day\(s\)/);
  const habList = await agent.handle('meri habits dikhao');
  assert.match(habList, /Daily Habit & Streak Tracker/);

  // Feature 18: Git & Dev Repo Autopilot (`/gitstatus`, `"mera git status dikhao"`)
  const gitSt = await agent.handle('mera git status dikhao');
  assert.match(gitSt, /Git & Dev Repo Autopilot/);
  assert.match(gitSt, /Recent Commits/);

  // Feature 19: Smart Download & Media Grabber (SSRF guard verification)
  const grabLocal = await agent.handle('/grab http://127.0.0.1:8080/secret');
  assert.match(grabLocal, /SSRF Guard Blocked/);

  // Feature 20: Automated File / Data / Doc Converter (`/convert json2csv`, `/convert md2html`)
  const csvOut = await agent.handle('/convert json2csv [{"name":"Pavit","score":100},{"name":"Observer","score":99}]');
  assert.match(csvOut, /name,score/);
  assert.match(csvOut, /Pavit,100/);
  const htmlOut = await agent.handle('/convert md2html # PSD_Ai Heading');
  assert.match(htmlOut, /<h1>PSD_Ai Heading<\/h1>/);

  // Feature 21: Smart Meeting / Lecture Live Scribe (`/scribe start|note|stop`)
  await agent.handle('/scribe start DBMS Lecture');
  await agent.handle('/scribe note ACID stands for Atomicity, Consistency, Isolation, Durability');
  await agent.handle('/scribe note Todo: Submit B-Tree indexing assignment by Friday');
  const scribeSum = await agent.handle('/scribe stop');
  assert.match(scribeSum, /Live Scribe Summary — DBMS Lecture/);
  assert.match(scribeSum, /Atomicity, Consistency/);
  assert.match(scribeSum, /Revision Questions/);

  // Feature 22: Wi-Fi & Network Health Optimizer (`/netcheck`, `"wifi slow chal raha hai"`)
  const netOut = await agent.handle('wifi slow chal raha hai');
  assert.match(netOut, /Wi-Fi & Network Health Optimizer/);

  // Feature 23: USB & External Device Intrusion Guard (`/usbguard`, `"kaunse usb connected hain"`)
  const usbOut = await agent.handle('kaunse usb connected hain');
  assert.match(usbOut, /USB & External Device Intrusion Guard/);
  assert.match(usbOut, /All devices match trusted baseline/);

  // Feature 24: Encrypted Secret Vault & Masked Auto-Typer (`/vault set|list|get|type`)
  const vSet = await agent.handle('/vault set github_pat ghp_SuperSecretToken98765');
  assert.match(vSet, /Secret Stored in AES-256 Vault/);
  assert.doesNotMatch(vSet, /SuperSecretToken/);
  const vList = await agent.handle('/vault list');
  assert.match(vList, /github_pat/);
  assert.doesNotMatch(vList, /SuperSecretToken/);
  const vType = await agent.handle('/vault type github_pat');
  assert.match(vType, /Auto-Typed Masked Vault Secret/);
  const vGet = await agent.handle('/vault get github_pat');
  assert.match(vGet, /ghp_SuperSecretToken98765/);

  // Feature 25: Multi-Language Instant Translator & Tone Rewriter (`"isko professional email bana de: ..."`)
  const emailOut = await agent.handle('isko professional email bana de: bhai kal chutti chahiye tabiyat kharab hai');
  assert.match(emailOut, /Leave Application/);
  assert.match(emailOut, /Dear Sir\/Madam/);

  // Feature 26: Smart Pomodoro & Deep-Work Timer (`/pomo`, `"45 min pomo lagao DSA ke liye"`)
  const pomoStart = await agent.handle('45 min pomo lagao DSA ke liye');
  assert.match(pomoStart, /Pomodoro Timer Started\*: \*45 mins\*/);
  const pomoDone = await agent.handle('/pomo done');
  assert.match(pomoDone, /Pomodoro Session Completed\*: \*DSA\*/);
  assert.match(pomoDone, /Total: \*45 mins\*/);

  // Feature 27: Local Port & Dev-Server Manager (`/ports`, `"port 3000 pe kya chal raha hai"`)
  const portCheck = await agent.handle('port 59999 pe kya chal raha hai');
  assert.match(portCheck, /Port 59999/);

  // Feature 28: Smart Battery & Thermal Guardian (`/guardian`, `"battery aur temp check karo"`)
  const guardOut = await agent.handle('battery aur temp check karo');
  assert.match(guardOut, /Smart Battery & Thermal Guardian/);
  assert.match(guardOut, /CPU Thermal/);

  // Feature 29: Flashcard & Spaced-Repetition Quizzer (`/quiz`, `"mere notes se quiz puch"`)
  await agent.handle('/note Server cluster port is 8787');
  const quizQ = await agent.handle('mere notes se quiz puch');
  assert.match(quizQ, /Flashcard & Spaced-Repetition Quizzer/);
  assert.match(quizQ, /8787/);
  const quizAns = await agent.handle('quiz answer A');
  assert.match(quizAns, /Correct Answer \(A\)!/);

  // Feature 30: Time-Machine File Backup & Instant Undo (`/backup`, `"undo file <path>"`)
  const tmpFile = path.join(os.tmpdir(), `psd-timemachine-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, 'Original Safe Content v1', 'utf8');
  const bkSnap = await agent.handle(`/backup ${tmpFile}`);
  assert.match(bkSnap, /Time-Machine Snapshot #1 Created/);
  fs.writeFileSync(tmpFile, 'Corrupted Accidental Edit v2', 'utf8');
  assert.equal(fs.readFileSync(tmpFile, 'utf8'), 'Corrupted Accidental Edit v2');
  const undoFileRes = await agent.handle(`undo file ${tmpFile}`);
  assert.match(undoFileRes, /Time-Machine Restore Complete/);
  assert.equal(fs.readFileSync(tmpFile, 'utf8'), 'Original Safe Content v1');
  fs.unlinkSync(tmpFile);
});












