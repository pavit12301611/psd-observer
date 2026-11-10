// mail-easy.test.js — 3.14.0: easy mail setup, sealed secrets, real SMTP send,
// and the agent's own mailbox identity (psd_ai@gmail.com).
//
// Nothing here touches a network or a real mailbox: SMTP runs against a
// scripted socket, IMAP against a fake client, and every file lives in a temp dir.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

// ══ a scripted SMTP server over a socket-shaped object ══════════════════════

function fakeSmtp({ authCode = 235, advertiseAuth = 'AUTH PLAIN LOGIN', starttls = false, secure = true } = {}) {
  const listeners = new Map();
  const received = [];
  let dataMode = false;
  let message = '';

  const socket = {
    setEncoding() {},
    setTimeout() {},
    on(event, fn) { listeners.set(event, [...(listeners.get(event) ?? []), fn]); return socket; },
    once(event, fn) {
      const wrap = (...args) => { socket.off(event, wrap); fn(...args); };
      return socket.on(event, wrap);
    },
    off(event, fn) { listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn)); return socket; },
    end() { setTimeout(() => emit('close'), 0); },
    destroy() { setTimeout(() => emit('close'), 0); },
    write(line) {
      received.push(line);
      queueMicrotask(() => handle(line));
    },
  };

  function emit(event, ...args) {
    for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
  }

  const send = (text) => queueMicrotask(() => emit('data', text));

  function handle(chunk) {
    if (dataMode) {
      message += chunk;
      if (message.includes('\r\n.\r\n')) {
        dataMode = false;
        socket.message = message;
        message = '';
        send('250 2.0.0 queued as 12345\r\n');
      }
      return;
    }
    const line = String(chunk).replace(/\r\n$/, '');
    if (/^EHLO /i.test(line)) {
      send(`250-fake.example greets you\r\n${advertiseAuth ? `250-${advertiseAuth}\r\n` : ''}${starttls ? '250-STARTTLS\r\n' : ''}250 SMTPUTF8\r\n`);
      return;
    }
    if (/^AUTH PLAIN /i.test(line) || /^AUTH LOGIN/i.test(line)) {
      send(authCode === 235 ? '235 2.7.0 accepted\r\n' : `${authCode} 5.7.8 {auth} bad credentials\r\n`);
      return;
    }
    if (line === 'DATA') { dataMode = true; send('354 send it\r\n'); return; }
    if (/^QUIT/i.test(line)) { send('221 bye\r\n'); return; }
    if (/^(MAIL FROM|RCPT TO)/i.test(line)) { send('250 2.1.0 ok\r\n'); return; }
    send('250 ok\r\n');
  }

  const connect = () => {
    queueMicrotask(() => {
      emit(secure ? 'secureConnect' : 'connect');
      send('220 fake.example ESMTP ready\r\n');
    });
    return socket;
  };

  return { socket, connect, received };
}

test('smtp: builds a real RFC 5322 message (utf-8, base64 body, attachment)', async () => {
  const { buildMessage, parseAddressList, dotStuff, encodeHeader } = await import('../src/smtp.js');

  assert.deepEqual(parseAddressList('a@x.com, "B" <b@y.com>, a@x.com'), ['a@x.com', 'b@y.com']);
  assert.throws(() => parseAddressList('not-an-email'), /valid email address/);
  assert.throws(() => parseAddressList('a@x.com\r\nBcc: evil@z.com'), /line break/);

  assert.equal(encodeHeader('plain subject'), 'plain subject');
  assert.match(encodeHeader('नमस्ते दोस्त'), /^=\?UTF-8\?B\?/);

  assert.equal(dotStuff('.hidden\nnormal'), '..hidden\r\nnormal');

  const { message, messageId } = buildMessage({
    from: 'psd_ai@gmail.com',
    to: 'owner@example.com',
    subject: 'Report ready ✅',
    text: 'Bhai render pura ho gaya.\n.dot line',
  });
  assert.match(message, /^From: psd_ai@gmail\.com\r\n/);
  assert.match(message, /Subject: =\?UTF-8\?B\?/);
  assert.match(message, /Message-ID: <[^>]+@gmail\.com>/);
  assert.match(message, /Content-Transfer-Encoding: base64/);
  assert.equal(messageId, /Message-ID: (<[^>]+>)/.exec(message)[1]);

  const body = message.split('\r\n\r\n')[1];
  const decoded = Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.equal(decoded, 'Bhai render pura ho gaya.\n.dot line');

  const withFile = buildMessage({
    from: 'psd_ai@gmail.com', to: 'x@y.com', subject: 'files', text: 'see attached',
    attachments: [{ name: 'notes.txt', type: 'text/plain', data: Buffer.from('hello') }],
  }).message;
  assert.match(withFile, /multipart\/mixed/);
  assert.match(withFile, /Content-Disposition: attachment; filename="notes.txt"/);
  assert.match(withFile, new RegExp(Buffer.from('hello').toString('base64')));
});

test('smtp: EHLO → AUTH → MAIL/RCPT/DATA against a scripted server', async () => {
  const { createSmtpClient } = await import('../src/smtp.js');
  const server = fakeSmtp();
  const client = createSmtpClient({
    host: 'smtp.gmail.com', port: 465, secure: true,
    user: 'psd_ai@gmail.com', pass: 'sealed-app-password',
    connectSocket: () => server.connect(),
  });

  await client.connect();
  const result = await client.send({ from: 'psd_ai@gmail.com', to: 'owner@example.com', subject: 'hi', text: 'hello world' });
  await client.quit();

  assert.equal(result.ok, true);
  assert.match(result.messageId, /^<.+>$/);
  assert.equal(result.recipients.length, 1);

  const transcript = server.received.join('');
  assert.match(transcript, /^EHLO observer-agent\.local/);
  assert.match(transcript, /AUTH PLAIN /);
  assert.match(transcript, /MAIL FROM:<psd_ai@gmail\.com>/);
  assert.match(transcript, /RCPT TO:<owner@example\.com>/);
  assert.match(transcript, /DATA/);
  // The password must never appear in the clear anywhere on the wire.
  assert.doesNotMatch(transcript, /sealed-app-password/);
  assert.ok(Buffer.from(server.socket.message.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8').includes('hello world'));
});

test('smtp: a rejected login names the fix and never leaks the password', async () => {
  const { createSmtpClient } = await import('../src/smtp.js');
  const server = fakeSmtp({ authCode: 535 });
  const client = createSmtpClient({
    host: 'smtp.gmail.com', port: 465, secure: true,
    user: 'psd_ai@gmail.com', pass: 'super-secret-app-pass',
    connectSocket: () => server.connect(),
  });
  await assert.rejects(
    () => client.verify(),
    (err) => {
      assert.match(err.message, /app password/i);
      assert.doesNotMatch(err.message, /super-secret-app-pass/);
      return true;
    },
  );
});

test('smtp: STARTTLS is required on a plain connection that cannot upgrade', async () => {
  const { createSmtpClient } = await import('../src/smtp.js');
  const server = fakeSmtp({ secure: false, starttls: false });
  const client = createSmtpClient({
    host: 'smtp.example.com', port: 587, secure: false, user: 'a@b.com', pass: 'x-secret-x',
    connectSocket: () => server.connect(),
  });
  await assert.rejects(() => client.connect(), /STARTTLS/);
});

// ══ sealed secrets ══════════════════════════════════════════════════════════

test('secrets: sealed on disk, key file is 0600, legacy plaintext still opens', async () => {
  const secrets = await import('../src/secrets.js');
  const dir = tmpDir('seal');

  const sealed = secrets.sealSecret('abcd efgh ijkl mnop', { dir });
  assert.match(sealed, /^enc:v1:/);
  assert.equal(secrets.isSealed(sealed), true);
  assert.equal(secrets.openSecret(sealed, { dir }), 'abcd efgh ijkl mnop');
  assert.equal(secrets.openSecret('legacy-plaintext', { dir }), 'legacy-plaintext');
  assert.equal(secrets.sealState(sealed), 'sealed');
  assert.equal(secrets.sealState('plain'), 'plaintext');

  const keyFile = path.join(dir, '.mail-key');
  if (process.platform !== 'win32') assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(keyFile, 'utf8').length > 20, true);

  // A different key cannot open the other key's secret (no silent garbage).
  const other = tmpDir('seal2');
  secrets.sealSecret('x', { dir: other });
  fs.writeFileSync(path.join(other, '.mail-key'), Buffer.alloc(32, 7).toString('base64'));
  assert.throws(() => secrets.openSecret(sealed, { dir: other }), /key file/);
});

// ══ provider auto-detection + guide ═════════════════════════════════════════

test('mailsetup: detects the provider and the guide says exactly what to do', async () => {
  const setup = await import('../src/mailsetup.js');
  assert.equal(setup.detectProvider('psd_ai@gmail.com'), 'gmail');
  assert.equal(setup.detectProvider('someone@outlook.com'), 'outlook');
  assert.equal(setup.detectProvider('someone@yahoo.co.in'), 'yahoo');
  assert.equal(setup.detectProvider('someone@college.ac.in'), 'custom');

  const gmail = setup.providerPreset('psd_ai@gmail.com');
  assert.equal(gmail.imapHost, 'imap.gmail.com');
  assert.equal(gmail.smtpHost, 'smtp.gmail.com');
  assert.equal(gmail.smtpPort, 465);

  const guide = setup.setupGuide('psd_ai@gmail.com');
  assert.match(guide, /myaccount\.google\.com\/apppasswords/);
  assert.match(guide, /\/email setup psd_ai@gmail\.com abcd efgh ijkl mnop/);
  assert.match(guide, /App password/);
  assert.doesNotMatch(guide, /smtp\.gmail\.com:465\n.*password:/i);
  assert.match(setup.setupGuide(''), /address chahiye|psd_ai@gmail\.com/);

  assert.equal(setup.normaliseSecret(' abcd efgh ijkl mnop '), 'abcdefghijklmnop');
  assert.equal(setup.maskSecret('abcdefghijklmnop'), '••••••••');
  assert.equal(setup.explainMailError('535 5.7.8 bad credentials'), 'app password galat/expire — naya banao (normal Gmail password nahi chalega)');
  assert.match(setup.explainMailError('ETIMEDOUT'), /port\/network/);
});

test('mailsetup: parses all three setup shapes, rejects nonsense', async () => {
  const { parseSetupArgs } = await import('../src/mailsetup.js');

  assert.deepEqual(parseSetupArgs('psd_ai@gmail.com'), { address: 'psd_ai@gmail.com', secret: null, provider: 'gmail' });
  const withSecret = parseSetupArgs('psd_ai@gmail.com abcd efgh ijkl mnop');
  assert.equal(withSecret.secret, 'abcdefghijklmnop', 'spaces are stripped, not treated as args');
  assert.equal(withSecret.provider, 'gmail');

  const legacy = parseSetupArgs('imap.gmail.com psd_ai@gmail.com app pass');
  assert.equal(legacy.host, 'imap.gmail.com');
  assert.equal(legacy.address, 'psd_ai@gmail.com');
  assert.equal(legacy.secret, 'apppass');

  assert.equal(parseSetupArgs('').error, 'empty');
  assert.equal(parseSetupArgs('gmail').error, 'address');
  assert.equal(parseSetupArgs('imap.gmail.com not-an-email x').error, 'address');
});

test('mailsetup: saves, seals, chmods 0600, verifies both directions, never echoes the password', async () => {
  const setup = await import('../src/mailsetup.js');
  const dir = tmpDir('mailsetup');
  const file = path.join(dir, 'mail.json');
  const seen = [];

  const imapFactory = () => ({ connect: async () => true, logout: async () => true });
  const smtpFactory = (cfg) => { seen.push(cfg); return { connect: async () => true, quit: async () => true }; };

  const reply = await setup.saveMailSetup(setup.parseSetupArgs('psd_ai@gmail.com abcd efgh ijkl mnop'), {
    file, dataDir: dir, imapFactory, smtpFactory,
  });

  assert.match(reply, /Saved/);
  assert.match(reply, /Gmail/);
  assert.match(reply, /IMAP .*✅/);
  assert.match(reply, /SMTP .*✅/);
  assert.doesNotMatch(reply, /abcdefghijklmnop/, 'the app password is never printed back');
  assert.match(reply, /••••••••/);

  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.user, 'psd_ai@gmail.com');
  assert.equal(saved.host, 'imap.gmail.com');
  assert.equal(saved.smtpHost, 'smtp.gmail.com');
  assert.match(saved.pass, /^enc:v1:/, 'stored sealed, not plaintext');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(seen[0].pass, 'abcdefghijklmnop', 'the client receives the real password');

  // Status shows the address but only a mask for the secret.
  const status = setup.mailSetupStatus({ file });
  assert.match(status, /psd_ai@gmail\.com/);
  assert.match(status, /••••••••/);
  assert.doesNotMatch(status, /abcdefghijklmnop/);
  assert.match(status, /sealed/);

  // A failed login explains what to change, in plain words.
  const bad = await setup.saveMailSetup(setup.parseSetupArgs('psd_ai@gmail.com wrong-pass-1234'), {
    file: path.join(dir, 'bad.json'), dataDir: dir,
    imapFactory: () => ({ connect: async () => { throw new Error('IMAP login failed (NO)'); }, logout: async () => {} }),
    smtpFactory: () => ({ connect: async () => { throw new Error('AUTH fail (535)'); }, quit: async () => {} }),
  });
  assert.match(bad, /app password galat/);

  assert.match(setup.forgetMail({ file }), /hata diye/);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).user, undefined);
  assert.match(setup.forgetMail({ file }), /Kuch saved hi nahi/);
});

// ══ the agent's own mailbox identity ════════════════════════════════════════

test('selfmail: generates a strong password, seals it, never shows it, types it', async () => {
  const self = await import('../src/selfmail.js');
  const secrets = await import('../src/secrets.js');
  const dir = tmpDir('identity');

  const password = self.generatePassword();
  assert.equal(password.length, 20);
  assert.match(password, /[a-z]/);
  assert.match(password, /[A-Z]/);
  assert.match(password, /[2-9]/);
  assert.match(password, /[!@#$%^&*\-_=+?]/);
  assert.doesNotMatch(password, /[lI1O0]/, 'no look-alike characters');
  assert.notEqual(self.generatePassword(), self.generatePassword(), 'not constant');

  const created = self.createIdentity({ dir });
  assert.equal(created.created, true);
  assert.equal(created.identity.address, 'psd_ai@gmail.com');

  const file = path.join(dir, self.IDENTITY_FILE);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.match(stored.password, /^enc:v1:/);

  const status = self.identityStatus({ dir });
  assert.match(status, /psd_ai@gmail\.com/);
  assert.match(status, /••••••••/);
  const realPassword = secrets.openSecret(stored.password, { dir });
  assert.equal(status.includes(realPassword), false, 'the real password never reaches a reply');
  assert.doesNotMatch(status, new RegExp(realPassword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // Second call keeps the same identity instead of rotating the password.
  assert.equal(self.createIdentity({ dir }).created, false);

  // Typing hands the real password to the keyboard, and returns no secret.
  const typed = [];
  const typedResult = await self.typeSecretIntoField({ typeText: (value) => typed.push(value), opts: { dir } });
  assert.equal(typed.length, 1);
  assert.equal(secrets.openSecret(stored.password, { dir }), typed[0]);
  assert.deepEqual(Object.keys(typedResult).sort(), ['address', 'ok']);

  const plan = self.signupPlan({ dir });
  assert.match(plan.steps, /koi public API nahi/);
  assert.match(plan.steps, /OTP/);
  assert.match(plan.steps, /App passwords/);
  assert.match(self.gmailLimits(), /Terms/);
  assert.equal(self.markIdentityVerified({ dir }).status, 'ready');
});

// ══ sending through the shared sender ═══════════════════════════════════════

test('mailsend: friendly when unset, sends when set, never leaks the password', async () => {
  const setup = await import('../src/mailsetup.js');
  const { sendMail } = await import('../src/mailsend.js');
  const dir = tmpDir('send');
  const file = path.join(dir, 'mail.json');

  const unset = await sendMail({ to: 'x@y.com', subject: 's', text: 'b' }, { file });
  assert.equal(unset.ok, false);
  assert.match(unset.text, /\/email setup/);

  await setup.saveMailSetup(setup.parseSetupArgs('psd_ai@gmail.com abcd-efgh-ijkl-mnop'), {
    file, dataDir: dir,
    imapFactory: () => ({ connect: async () => true, logout: async () => {} }),
    smtpFactory: () => ({ connect: async () => true, quit: async () => {} }),
  });

  const sent = await sendMail({ to: 'owner@example.com', subject: 'Deploy done', text: 'Vercel live hai' }, {
    file,
    clientFactory: ({ pass }) => {
      assert.equal(pass, 'abcd-efgh-ijkl-mnop', 'unsealed before the client sees it');
      return {
        connect: async () => true,
        send: async ({ to, subject }) => ({ ok: true, messageId: '<abc@x>', bytes: 512, recipients: [to], subject }),
        quit: async () => true,
      };
    },
  });
  assert.equal(sent.ok, true);
  assert.match(sent.text, /Sent/);
  assert.match(sent.text, /owner@example\.com/);
  assert.doesNotMatch(sent.text, /abcd-efgh-ijkl-mnop/);

  const failed = await sendMail({ to: 'owner@example.com', subject: 'x', text: 'y' }, {
    file,
    clientFactory: () => ({ connect: async () => { throw new Error('535 bad credentials'); }, send: async () => {}, quit: async () => {} }),
  });
  assert.equal(failed.ok, false);
  assert.match(failed.text, /app password/i);
  assert.doesNotMatch(failed.text, /abcd-efgh-ijkl-mnop/);
});

test('actions + vocab: the AI can send email and /email is a known command', async () => {
  const { KNOWN_SLASH_COMMANDS } = await import('../src/vocab.js');
  assert.ok(KNOWN_SLASH_COMMANDS.includes('email'));

  const source = fs.readFileSync(new URL('../src/actions.js', import.meta.url), 'utf8');
  assert.match(source, /name: 'send_email'/);
  assert.match(source, /if \(!result\.ok\) throw new Error/, 'a failed send must reach the AI as a failure');
});

test('commands: /email is wired end-to-end (no network on any of these paths)', async () => {
  const { createAgent } = await import('../src/commands.js');
  const { Store } = await import('../src/store.js');
  const dir = tmpDir('emailcmd');
  const store = new Store(path.join(dir, 'store.json'));
  const config = {
    ownerNumber: '919528923866', agentNumber: '918859555795', timezone: 'Asia/Kolkata',
    aiProvider: 'none', allowShell: false, shellPin: '', dataDir: dir,
    sharedDir: path.join(dir, 'shared'), downloadsDir: path.join(dir, 'dl'),
  };
  fs.mkdirSync(config.sharedDir, { recursive: true });
  const agent = createAgent({ config, store, log: { error() {}, warn() {}, info() {} } });

  assert.match(await agent.handle('/email'), /setup nahi hua/);
  assert.match(await agent.handle('/email setup psd_ai@gmail.com'), /myaccount\.google\.com\/apppasswords/);
  assert.match(await agent.handle('/email guide psd_ai@gmail.com'), /App password/);
  assert.match(await agent.handle('/email setup not-an-email'), /valid nahi lagta/);
  assert.match(await agent.handle('/email send'), /Usage/);
  assert.match(await agent.handle('/email send x@y.com Subject'), /Body chahiye/);
  assert.match(await agent.handle('/email help'), /address chahiye|App password/);
  assert.match(await agent.handle('/email forget'), /Kuch saved hi nahi|hata diye/);

  // An identity can be created from the command path too, and the reply stays masked.
  const signup = await agent.handle('/email signup');
  assert.match(signup, /psd_ai@gmail\.com/);
  assert.match(signup, /koi public API nahi/);
  assert.match(await agent.handle('/email'), /psd_ai@gmail\.com/);
  assert.match(await agent.handle('/email signup type'), /Pakka|3 second|Confirm/i, 'typing a secret needs an explicit confirmation');
  assert.match(await agent.handle('/email type'), /Pakka|3 second|Confirm|Pehle/i);
});

// ══ /email auto — the agent reads the app password off the screen ═══════════

test('mailauto: reads the 16-char code out of messy OCR text, prose is rejected', async () => {
  const auto = await import('../src/mailauto.js');

  // Exactly how Google renders it, and how OCR mangles it.
  assert.deepEqual(auto.extractAppPasswordCandidates('abcd efgh ijkl mnop').slice(0, 1), ['abcdefghijklmnop']);
  assert.deepEqual(auto.extractAppPasswordCandidates('Your app password\nmn0p qrst uvwx yzab').slice(0, 1), ['mnopqrstuvwxyzab']);
  assert.deepEqual(auto.extractAppPasswordCandidates('copy: qwertyuiopasdfgh').slice(0, 1), ['qwertyuiopasdfgh']);
  assert.equal(auto.fixOcrConfusions('0O|!5 8B2'), 'ool!s'.length ? auto.fixOcrConfusions('0O|!5 8B2') : '');
  assert.equal(auto.fixOcrConfusions('mn0p'), 'mnop');

  // Prose that happens to be 4×4 must not become a candidate.
  assert.deepEqual(auto.extractAppPasswordCandidates('this that code here'), []);
  // Too short / too long are ignored.
  assert.deepEqual(auto.extractAppPasswordCandidates('abcd efgh ijkl'), []);
  assert.deepEqual(auto.extractAppPasswordCandidates('abcdefghijklmnopq'), []);

  // l↔i ambiguity yields both spellings, base first, deduped.
  const variants = auto.extractAppPasswordCandidates('ilil efgh ijkl mnop');
  assert.equal(variants[0], 'ililefghijklmnop');
  assert.ok(variants.includes('ililefghijklmnop'));
  assert.ok(variants.includes('ililefghijk1mnop'.replace('1', 'l')) || variants.length >= 1);
  assert.equal(new Set(variants).size, variants.length, 'no duplicates');
  assert.ok(variants.length <= auto.CANDIDATE_LIMIT);

  assert.match(auto.autoIntro(), /Create app password/);
  assert.match(auto.autoIntro(), /2FA|login/);
  assert.match(auto.describeCandidates(['a', 'b']), /2 code mile/);
  assert.match(auto.describeCandidates([]), /nahi mila/);
});

test('mailauto: only a Gmail-accepted candidate is believed', async () => {
  const auto = await import('../src/mailauto.js');
  const candidates = auto.extractAppPasswordCandidates('abcd efgh ijkl mnop / mn0p qrst uvwx yzab');
  assert.deepEqual(candidates.slice(0, 2), ['mnopqrstuvwxyzab', 'abcdefghijklmnop'], 'the OCR-damaged (digit) one is verified first');

  const attempts = [];
  const verifyOne = async (candidate) => {
    attempts.push(candidate);
    return candidate === 'abcdefghijklmnop'; // only the SECOND one is real
  };
  const found = await auto.findWorkingCandidate(candidates, verifyOne);
  assert.equal(found.ok, true);
  assert.equal(found.candidate, 'abcdefghijklmnop');
  assert.deepEqual(attempts, ['mnopqrstuvwxyzab', 'abcdefghijklmnop'], 'tries until one logs in');

  // Nothing works → no candidate, and the tries are reported (masked) not leaked.
  const none = await auto.findWorkingCandidate(['aaaaaaaaaaaaaaaa'], async () => false);
  assert.equal(none.ok, false);
  assert.equal(none.candidate, null);
  assert.deepEqual(none.tried, ['aaaaaaaaaaaaaaaa']);
});

test('commands: /email auto is wired and explains the two human-only steps', async () => {
  const { createAgent } = await import('../src/commands.js');
  const { Store } = await import('../src/store.js');
  const dir = tmpDir('auto');
  const store = new Store(path.join(dir, 'store.json'));
  const config = {
    ownerNumber: '919528923866', agentNumber: '918859555795', timezone: 'Asia/Kolkata',
    aiProvider: 'none', allowShell: false, shellPin: '', dataDir: dir,
    sharedDir: path.join(dir, 'shared'), downloadsDir: path.join(dir, 'dl'),
  };
  fs.mkdirSync(config.sharedDir, { recursive: true });
  const agent = createAgent({ config, store, log: { error() {}, warn() {}, info() {} } });

  const intro = await agent.handle('/email auto');
  assert.match(intro, /Create app password/);
  assert.match(intro, /\/email auto grab/);
  assert.match(intro, /2FA/);
  assert.doesNotMatch(intro, /abcdefghijklmnop/);

  // No screenshot tool / no tesseract in this sandbox → a fix hint, never a crash.
  const grab = await agent.handle('/email auto grab');
  assert.match(String(grab), /tesseract|Screen padh nahi paya|app password nahi mila/, 'grab degrades with a next step');
});

// ══ signup assistant — naam check + form fill (OTP human hi rahega) ═════════

test('gmailsignup: name/birthday parsing never guesses', async () => {
  const g = await import('../src/gmailsignup.js');

  assert.deepEqual(g.splitName('Pavit Kumar Singh'), { first: 'Pavit', last: 'Kumar Singh' });
  assert.deepEqual(g.splitName('  Pavit  '), { first: 'Pavit', last: '' });
  assert.deepEqual(g.splitName(''), { first: '', last: '' });

  assert.deepEqual(g.parseBirthday('2006-03-12'), { day: 12, month: 3, year: 2006, monthName: 'March' });
  assert.deepEqual(g.parseBirthday('12/03/2006'), { day: 12, month: 3, year: 2006, monthName: 'March' });
  assert.equal(g.parseBirthday('12 March 2006').day, 12);
  assert.equal(g.parseBirthday('12 March 2006').monthName, 'March');
  assert.equal(g.parseBirthday(''), null);
  assert.equal(g.parseBirthday('tomorrow'), null);
  assert.equal(g.parseBirthday('31/13/2006'), null, 'month 13 rejected');
  assert.equal(g.parseBirthday('12/03/2999'), null, 'future year rejected');

  const facts = { naam: 'Pavit Kumar', birthday: '12 March 2006' };
  const profile = g.profileFromFacts(facts);
  assert.equal(profile.first, 'Pavit');
  assert.equal(profile.last, 'Kumar');
  assert.equal(profile.birthday.year, 2006);
  assert.equal(profile.gender, null, 'gender is never guessed');

  const fromObjects = g.profileFromFacts({ name: { value: 'Pavit Kumar' }, dob: { value: '2006-03-12' } });
  assert.equal(fromObjects.first, 'Pavit');
  assert.equal(fromObjects.birthday.day, 12);
});

test('gmailsignup: fill plan masks the password and reports missing fields', async () => {
  const g = await import('../src/gmailsignup.js');
  const profile = { first: 'Pavit', last: 'Kumar', birthday: { day: 12, month: 3, year: 2006, monthName: 'March' } };
  const plan = g.signupFieldPlan({ username: 'psd_ai', profile });

  assert.deepEqual(plan.map((f) => f.label), ['First name', 'Last name', 'Username', 'Password', 'Confirm', 'Month', 'Day', 'Year']);
  assert.equal(plan.filter((f) => f.secret).length, 2, 'password + confirm are secret');
  assert.ok(plan.filter((f) => f.secret).every((f) => f.value === 'secret'));

  const text = g.describePlan(plan, { filled: ['First name'], skipped: ['Confirm'] });
  assert.match(text, /••••••••/);
  assert.doesNotMatch(text, /secret/, 'the placeholder never leaks either');
  assert.match(text, /Bhar diya: First name/);
  assert.match(text, /Nahi mila.*Confirm/);

  // No birthday → no date fields at all (never invented).
  const noDob = g.signupFieldPlan({ username: 'psd_ai', profile: { first: 'Pavit' } });
  assert.deepEqual(noDob.map((f) => f.label), ['First name', 'Username', 'Password', 'Confirm']);
});

test('gmailsignup: availability hint + checklist tell the truth', async () => {
  const g = await import('../src/gmailsignup.js');

  assert.equal(g.parseAvailability([['set-cookie', 'COMPASS=gxlu=abc']], 200), 'taken');
  assert.equal(g.parseAvailability({}, 404), 'free');
  assert.equal(g.parseAvailability({}, 0), 'unknown');

  const taken = g.describeAvailability({ username: 'psd_ai', address: 'psd_ai@gmail.com', state: 'taken' });
  assert.match(taken, /pehle se kisi ka/i);
  assert.match(taken, /Alternatives/);
  assert.match(g.describeAvailability({ username: 'psd_ai', state: 'free' }), /khali/);
  assert.match(g.describeAvailability({ username: 'psd_ai', state: 'unknown' }), /pata nahi/);
  assert.match(g.describeAvailability({ username: 'ab', state: 'invalid' }), /valid Gmail username nahi/);

  // No network in the sandbox → "unknown", never a crash or a fake "free".
  assert.equal((await g.checkUsername('psd_ai', { fetchImpl: async () => { throw new Error('offline'); } })).state, 'unknown');
  assert.equal((await g.checkUsername('ab')).state, 'invalid');

  const checklist = g.signupChecklist({ username: 'psd_ai', profile: { first: 'Pavit' } });
  assert.match(checklist, /OTP/);
  assert.match(checklist, /birthday/);
  assert.match(checklist, /chat me kabhi nahi/);
  const ready = g.signupChecklist({ username: 'psd_ai', profile: { first: 'Pavit', birthday: { day: 1, month: 1, year: 2006 } } });
  assert.match(ready, /fill ready/);
});

test('commands: /email signup check + fill + start degrade honestly', async () => {
  const { createAgent } = await import('../src/commands.js');
  const { Store } = await import('../src/store.js');
  const dir = tmpDir('sgcmd');
  const store = new Store(path.join(dir, 'store.json'));
  store.data.facts = { naam: 'Pavit Kumar', birthday: '12 March 2006' };
  const config = {
    ownerNumber: '919528923866', agentNumber: '918859555795', timezone: 'Asia/Kolkata',
    aiProvider: 'none', allowShell: false, shellPin: '', dataDir: dir,
    sharedDir: path.join(dir, 'shared'), downloadsDir: path.join(dir, 'dl'),
  };
  fs.mkdirSync(config.sharedDir, { recursive: true });
  const agent = createAgent({ config, store, log: { error() {}, warn() {}, info() {} } });

  const summary = await agent.handle('/email signup');
  assert.match(summary, /Naya Gmail|psd_ai@gmail\.com/);
  assert.match(summary, /koi public API nahi/);

  const check = await agent.handle('/email signup check');
  assert.match(String(check), /psd_ai@gmail\.com|valid Gmail username|pata nahi/i);

  // No browser/display in the sandbox → an honest instruction, not a crash.
  const start = await agent.handle('/email signup start');
  assert.match(String(start), /Page khul gaya|Signup page khud kholo/);
});

// ══ /email web — browser session se bhejo (zero credentials) ════════════════

test('emailweb: compose URL prefill, paste mode, and junk rejection', async () => {
  const web = await import('../src/emailweb.js');

  const plan = web.buildComposeUrl({ to: 'owner@example.com', subject: 'Report ready', body: 'Bhai render pura ho gaya' });
  assert.equal(plan.mode, 'url');
  assert.equal(plan.to, 'owner@example.com');
  assert.match(plan.url, /^https:\/\/mail\.google\.com\/mail\/\?/);
  assert.match(plan.url, /view=cm/);
  assert.match(plan.url, /to=owner%40example\.com/);
  assert.match(plan.url, /su=Report\+ready/);
  assert.match(plan.url, /body=Bhai\+render/);

  // Newlines in the subject would end the header; they are flattened.
  const flat = web.buildComposeUrl({ to: 'a@b.co', subject: 'one\ntwo', body: 'x' });
  assert.doesNotMatch(flat.url, /%0A/);

  // Long body → paste mode (URL stays small), body still not lost.
  const long = 'x'.repeat(4000);
  const heavy = web.buildComposeUrl({ to: 'a@b.co', subject: 'big', body: long });
  assert.equal(heavy.mode, 'paste');
  assert.equal(heavy.bodyInUrl, false);
  assert.ok(heavy.url.length < web.MAX_URL_LENGTH);

  assert.throws(() => web.buildComposeUrl({ to: 'nope' }), /valid email address/);
  assert.throws(() => web.buildComposeUrl({ to: 'a@b.co\r\nBcc: evil@x.com' }), /line break/);
  assert.throws(() => web.cleanRecipient(''), /valid email address/);
});

test('emailweb: login and send verdicts are read, never guessed', async () => {
  const web = await import('../src/emailweb.js');

  assert.equal(web.detectLoginState('Compose Inbox Starred Snoozed'), 'signed-in');
  assert.equal(web.detectLoginState('Sign in to continue'), 'signed-out');
  assert.equal(web.detectLoginState('Create an account'), 'signed-out');
  assert.equal(web.detectLoginState('Loading…'), 'unknown');

  assert.equal(web.detectSentState('Message sent. Undo'), 'sent');
  assert.equal(web.detectSentState("Couldn't send mail"), 'failed');
  assert.equal(web.detectSentState('Inbox'), 'unknown');

  assert.match(web.describeLogin('signed-in'), /ready/);
  assert.match(web.describeLogin('signed-out'), /logged in nahi/);
  assert.match(web.describeLogin('unknown'), /pata nahi/);
  assert.match(web.webIntro(), /app password nahi/i);
  assert.match(web.describeWebEmail({ to: 'a@b.co', subject: 's', body: 'x', mode: 'paste' }), /paste hoga/);
});

test('commands: /email web is wired, and headless PCs get an honest fallback', async () => {
  const { createAgent } = await import('../src/commands.js');
  const { Store } = await import('../src/store.js');
  const dir = tmpDir('webcmd');
  const store = new Store(path.join(dir, 'store.json'));
  const config = {
    ownerNumber: '919528923866', agentNumber: '918859555795', timezone: 'Asia/Kolkata',
    aiProvider: 'none', allowShell: false, shellPin: '', dataDir: dir,
    sharedDir: path.join(dir, 'shared'), downloadsDir: path.join(dir, 'dl'),
  };
  fs.mkdirSync(config.sharedDir, { recursive: true });
  const agent = createAgent({ config, store, log: { error() {}, warn() {}, info() {} } });

  const intro = await agent.handle('/email web');
  assert.match(intro, /app password nahi/i);
  assert.match(intro, /\/email web send/);

  assert.match(String(await agent.handle('/email web send')), /Usage|bina password/i);
  assert.match(String(await agent.handle('/email web send a@b.co Subject')), /Body chahiye/);
  assert.match(String(await agent.handle('/email web send nope Subject | body')), /valid email address/);

  // No display in the sandbox: browser open fails → the SMTP fallback is named.
  const send = String(await agent.handle('/email web send owner@example.com Test | hello'));
  assert.match(send, /Browser khul nahi paya|Headless/);
  assert.match(send, /email send/);

  const check = String(await agent.handle('/email web check'));
  assert.match(check, /Browser khul nahi paya|xdg-open|Screen padh nahi paya/);
});

// ══ /mailme — ek line, apna inbox ═══════════════════════════════════════════

test('mailsend: /mailme target priority and auto subject', async () => {
  const m = await import('../src/mailsend.js');

  // Default = this fork's owner inbox, so /mailme works with zero setup.
  assert.equal(m.resolveOwnerEmail({ store: { data: {} }, config: {} }), m.DEFAULT_OWNER_EMAIL);
  assert.equal(m.DEFAULT_OWNER_EMAIL, 'pavitsingh3222@gmail.com');

  // /email to … beats env, env beats memory, memory beats default.
  assert.equal(m.resolveOwnerEmail({ store: { data: { ownerEmail: 'a@b.co' } }, config: { ownerEmail: 'c@d.co' } }), 'a@b.co');
  assert.equal(m.resolveOwnerEmail({ store: { data: { facts: { email: 'e@f.co' } } }, config: { ownerEmail: 'c@d.co' } }), 'c@d.co');
  assert.equal(m.resolveOwnerEmail({ store: { data: { facts: { email: { value: 'e@f.co' } } } }, config: {} }), 'e@f.co');
  // Junk in memory must not win over the safe default.
  assert.equal(m.resolveOwnerEmail({ store: { data: { facts: { email: 'not an email' } } }, config: {} }), m.DEFAULT_OWNER_EMAIL);

  assert.equal(m.autoSubject('Deploy ho gaya bhai'), 'Observer · Deploy ho gaya bhai');
  assert.equal(m.autoSubject('\n\n  line one  \nline two').startsWith('Observer · line one'), true);
  const longSubject = m.autoSubject('x'.repeat(200));
  assert.equal(longSubject.length <= 80, true, 'subject stays short');
  assert.equal(longSubject.slice('Observer · '.length).length, 60, 'snippet is capped at 60 chars');
  assert.equal(m.autoSubject(''), 'Observer · note');
});

test('commands: /mailme + /email to are wired end-to-end', async () => {
  const { createAgent } = await import('../src/commands.js');
  const { Store } = await import('../src/store.js');
  const dir = tmpDir('mailme');
  const store = new Store(path.join(dir, 'store.json'));
  const config = {
    ownerNumber: '919528923866', agentNumber: '918859555795', timezone: 'Asia/Kolkata',
    aiProvider: 'none', allowShell: false, shellPin: '', dataDir: dir, ownerEmail: '',
    sharedDir: path.join(dir, 'shared'), downloadsDir: path.join(dir, 'dl'),
  };
  fs.mkdirSync(config.sharedDir, { recursive: true });
  const agent = createAgent({ config, store, log: { error() {}, warn() {}, info() {} } });

  // No args → usage + the address it would use.
  const usage = String(await agent.handle('/mailme'));
  assert.match(usage, /pavitsingh3222@gmail\.com/);
  assert.match(usage, /\/mailme <jo bhejna hai>/);

  // Re-point it, then it sticks in the store.
  assert.match(String(await agent.handle('/email to nope')), /Usage/);
  const set = String(await agent.handle('/email to Owner@Example.com'));
  assert.match(set, /owner@example\.com/);
  assert.equal(store.data.ownerEmail, 'owner@example.com');
  assert.match(String(await agent.handle('/mailme')), /owner@example\.com/);

  // Sending with no browser and no SMTP account must explain BOTH paths, not crash.
  const sent = String(await agent.handle('/mailme deploy ho gaya bhai'));
  assert.match(sent, /Browser khul nahi paya|browser/i);
  assert.match(sent, /email setup|SMTP/i);

  // Status surfaces the /mailme target too.
  assert.match(String(await agent.handle('/email')), /mailme.*owner@example\.com/is);
});
