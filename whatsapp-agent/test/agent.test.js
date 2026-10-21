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



