// Tests for the 2.0 "full power" layer: offline Hinglish intents, the unified
// action registry (permissions, destructive confirmations, shell gate), the
// free AI tool-calling loop, the installable phone app and its HTTP API.
//
// Everything here is offline: no WhatsApp, no Ollama, no network beyond
// localhost fixtures.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';

// Tests must never touch the machine's real desktop: with a live session bus,
// xdg-desktop-portal would answer the screenshot checks and pop a dialog (and
// stall this file for ~20s). A dead bus address makes the portal genuinely
// unavailable, which is exactly the condition these tests are written for.
process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent-observer-test-bus';

import * as nlp from '../src/nlp.js';
import * as apps from '../src/apps.js';
import * as files from '../src/files.js';
import * as pc from '../src/pccontrol.js';
import { imageStats } from '../src/imaging.js';
import { createActions } from '../src/actions.js';
import { createAgentLoop } from '../src/agentloop.js';
import { createAgent } from '../src/commands.js';
import { Store } from '../src/store.js';
import { createBridgeServer, replyForApp } from '../src/server.js';
import { iconPng } from '../src/webapp.js';

const OWNER = '919528923866';
const AGENT = '918859555795';
const silent = { info() {}, warn() {}, error() {} };

const TEMP_DIRS = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.homedir(), 'wa-power-test-'));
  TEMP_DIRS.push(dir);
  return dir;
}
// Don't leave rubbish (or test files) in the owner's home folder.
after(() => {
  for (const dir of TEMP_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

function makeConfig(dir, overrides = {}) {
  return {
    ownerNumber: OWNER,
    agentNumber: AGENT,
    timezone: 'Asia/Kolkata',
    dataDir: dir,
    sharedDir: path.join(dir, 'shared'),
    downloadsDir: path.join(dir, 'downloads'),
    qrPngFile: path.join(dir, 'qr.png'),
    accessLevel: 'full',
    allowPcControl: true,
    allowShell: false,
    shellPin: '',
    shellTimeoutMs: 5_000,
    confirmTtlMs: 120_000,
    filesExtraRoots: [],
    aiProvider: 'none',
    ...overrides,
  };
}

// ── offline intents (works with zero AI) ────────────────────────────────────

test('nlp: English + Hinglish plain messages become real actions', () => {
  assert.deepEqual(nlp.parseIntent('chrome kholo'), { cmd: 'open', args: 'chrome' });
  assert.deepEqual(nlp.parseIntent('open vs code'), { cmd: 'open', args: 'vs code' });
  assert.deepEqual(nlp.parseIntent('please open spotify'), { cmd: 'open', args: 'spotify' });
  assert.deepEqual(nlp.parseIntent('screenshot bhej do'), { cmd: 'screenshot', args: '' });
  assert.deepEqual(nlp.parseIntent('volume 40'), { cmd: 'pc', args: 'volume 40' });
  assert.deepEqual(nlp.parseIntent('awaaz kam karo'), { cmd: 'pc', args: 'volume down' });
  assert.deepEqual(nlp.parseIntent('mute'), { cmd: 'pc', args: 'volume mute' });
  assert.deepEqual(nlp.parseIntent('wifi off karo'), { cmd: 'wifi', args: 'off' });
  assert.deepEqual(nlp.parseIntent('wifi connect HomeNet secret123'), { cmd: 'wifi', args: 'connect HomeNet secret123' });
  assert.deepEqual(nlp.parseIntent('battery kitni hai?'), { cmd: 'pc', args: 'battery' });
  assert.deepEqual(nlp.parseIntent('thesis.pdf dhundo'), { cmd: 'pc', args: 'find thesis.pdf' });
  assert.deepEqual(nlp.parseIntent('screen pe kya hai'), { cmd: 'look', args: '' });
  assert.deepEqual(nlp.parseIntent('type karo hello world'), { cmd: 'pc', args: 'type hello world' });
  assert.deepEqual(nlp.parseIntent('press ctrl+l'), { cmd: 'pc', args: 'key ctrl+l' });
  assert.deepEqual(nlp.parseIntent('download https://example.com/a.pdf'), { cmd: 'download', args: 'https://example.com/a.pdf' });
  assert.deepEqual(nlp.parseIntent('save ~/notes.txt me hello there'), { cmd: 'write', args: '~/notes.txt | hello there' });
  assert.deepEqual(nlp.parseIntent('rename a.txt to b.txt'), { cmd: 'mv', args: 'a.txt | b.txt' });
  assert.deepEqual(nlp.parseIntent('report.pdf bhejo'), { cmd: 'send', args: 'report.pdf' });
  assert.deepEqual(nlp.parseIntent('folder banao projects'), { cmd: 'mkdir', args: 'projects' });
  assert.deepEqual(nlp.parseIntent('file banao ~/a.txt me hello'), { cmd: 'write', args: '~/a.txt | hello' });
  assert.deepEqual(nlp.parseIntent('notes.txt me hello likho'), { cmd: 'write', args: 'notes.txt | hello' });
  assert.deepEqual(nlp.parseIntent('delete ~/old.txt'), { cmd: 'rm', args: '~/old.txt' });
  assert.deepEqual(nlp.parseIntent('old.txt hata do'), { cmd: 'rm', args: 'old.txt' });
  assert.deepEqual(nlp.parseIntent('app-smoke.txt padho'), { cmd: 'read', args: 'app-smoke.txt' });
  assert.deepEqual(nlp.parseIntent('ls ~/Downloads'), { cmd: 'ls', args: '~/Downloads' });
  assert.deepEqual(nlp.parseIntent('downloads folder me kya hai'), { cmd: 'ls', args: 'downloads' });
  assert.deepEqual(nlp.parseIntent('list files in ~/Desktop'), { cmd: 'ls', args: '~/Desktop' });
  assert.deepEqual(nlp.parseIntent('theek'), null); // chat, not a command
  assert.deepEqual(nlp.parseIntent('lock karo'), { cmd: 'pc', args: 'lock' });
  assert.deepEqual(nlp.parseIntent('pc band karo'), { cmd: 'pc', args: 'shutdown' });
});

test('nlp: real questions are never swallowed as app/file commands', () => {
  assert.equal(nlp.parseIntent('open source kya hai'), null);
  assert.equal(nlp.parseIntent('what is open source?'), null);
  assert.equal(nlp.parseIntent('write me a poem about rains'), null);
  assert.equal(nlp.parseIntent('explain javascript closures'), null);
  assert.equal(nlp.parseIntent('find meaning of life'), null); // 4 words, no file-ish target? still guarded
  assert.equal(nlp.parseIntent(''), null);
});

// ── desktop apps ────────────────────────────────────────────────────────────

test('apps: .desktop parsing, Exec quoting and fuzzy matching', () => {
  const entry = apps.parseDesktopEntry([
    '[Desktop Entry]',
    'Type=Application',
    'Name=Visual Studio Code',
    'Exec=/usr/share/code/code --unity-launch %F',
    'Keywords=code;editor;programming;',
    'StartupWMClass=Code',
  ].join('\n'));
  assert.equal(entry.name, 'Visual Studio Code');
  assert.deepEqual(apps.splitExec(entry.exec), ['/usr/share/code/code', '--unity-launch']);

  assert.deepEqual(apps.splitExec('env GTK_THEME=dark "/opt/My App/app" --flag %U'), ['/opt/My App/app', '--flag']);
  assert.equal(apps.parseDesktopEntry('[Desktop Entry]\nType=Application\nName=Hidden\nNoDisplay=true\nExec=x'), null);
  assert.equal(apps.parseDesktopEntry('[Desktop Entry]\nType=Link\nName=Link\nURL=https://x'), null);

  const list = [
    { id: 'code', name: 'Visual Studio Code', exec: 'code', keywords: 'editor' },
    { id: 'firefox', name: 'Firefox', exec: 'firefox', keywords: 'browser web' },
    { id: 'org.gnome.Nautilus', name: 'Files', exec: 'nautilus', keywords: 'file manager' },
  ];
  assert.equal(apps.matchApp('vs code', list).name, 'Visual Studio Code');
  assert.equal(apps.matchApp('code', list).name, 'Visual Studio Code');
  assert.equal(apps.matchApp('browser', list).name, 'Firefox');
  assert.equal(apps.matchApp('file manager', list).name, 'Files');
  assert.equal(apps.matchApp('definitely-not-installed-xyz', list), null);
});

test('apps: opening shell metacharacters is refused', async () => {
  await assert.rejects(() => apps.launchApp('chrome; rm -rf ~'), /shell characters/);
});

// ── file tools ──────────────────────────────────────────────────────────────

test('files: home-only, secrets blocked, read/write/list/search/send', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'hello.txt');
  try {
    assert.match(files.writeTextFile(file, 'first line'), /Saved/);
    files.writeTextFile(file, '\nsecond', { append: true });
    assert.equal(fs.readFileSync(file, 'utf8'), 'first line\nsecond');
    assert.match(files.readTextFile(file), /second/);
    assert.match(files.listDirectory(dir), /hello\.txt/);
    const found = await files.searchFiles('hello', { root: dir });
    assert.match(found, /hello\.txt/);

    const reply = files.fileReply(file);
    assert.equal(reply.document.fileName, 'hello.txt');
    assert.match(reply.document.mimetype, /text\/plain/);

    assert.equal(files.resolvePath('/etc/passwd', { mustExist: true }).ok, false);
    assert.equal(files.resolvePath('~/../../etc/passwd', { mustExist: true }).ok, false);
    assert.equal(files.resolvePath(path.join(os.homedir(), '.ssh', 'id_ed25519'), { mustExist: false }).ok, true); // resolves, blocked only when existing
    fs.mkdirSync(path.join(dir, '.ssh'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.ssh', 'id_rsa'), 'secret');
    // only the real home .ssh is blocked by relative path; ensure no crash on odd paths
    assert.ok(files.resolvePath(path.join(dir, '.ssh', 'id_rsa'), { mustExist: true }).ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── action registry: permissions + confirmations ────────────────────────────

test('actions: access levels gate dangerous capabilities', async () => {
  const dir = tempDir();
  try {
    const safe = createActions({ config: makeConfig(dir, { accessLevel: 'safe' }), store: new Store(path.join(dir, 'a.json')), log: silent });
    const blocked = await safe.execute('write_file', { path: path.join(dir, 'x.txt'), text: 'x' });
    assert.equal(blocked.ok, false);
    assert.match(blocked.text, /ACCESS_LEVEL=standard/);
    assert.doesNotMatch(blocked.text, /Done/);

    const standard = createActions({ config: makeConfig(dir, { accessLevel: 'standard' }), store: new Store(path.join(dir, 'b.json')), log: silent });
    const power = await standard.execute('power', { action: 'shutdown' });
    assert.match(power.text, /ACCESS_LEVEL=full/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('actions: destructive work is parked until the owner says haan', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'delete-me.txt');
  fs.writeFileSync(file, 'bye');
  const store = new Store(path.join(dir, 'store.json'));
  const config = makeConfig(dir);
  const actions = createActions({ config, store, log: silent });
  try {
    const first = await actions.execute('delete_path', { path: file });
    assert.equal(first.ok, false);
    assert.equal(first.needsConfirmation, true);
    assert.match(first.text, /Confirm/);
    assert.ok(fs.existsSync(file)); // nothing happened yet
    assert.ok(store.data.pending);

    const denied = await actions.runPending(); // simulate expiry separately below
    assert.equal(denied.ok, true);
    assert.ok(!fs.existsSync(file));

    // An expired confirmation does nothing.
    fs.writeFileSync(file, 'again');
    await actions.execute('delete_path', { path: file });
    store.data.pending.ts = Date.now() - 10 * 60_000;
    const expired = await actions.runPending();
    assert.match(expired.text, /expired/i);
    assert.ok(fs.existsSync(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('actions: shell stays off until ALLOW_SHELL + PIN, then runs', async () => {
  const dir = tempDir();
  try {
    const off = createActions({ config: makeConfig(dir), store: new Store(path.join(dir, 'c.json')), log: silent });
    const denied = await off.execute('run_shell', { command: 'echo hi' }, { confirmed: true });
    assert.match(denied.text, /Shell is OFF/);

    const on = createActions({
      config: makeConfig(dir, { allowShell: true, shellPin: '4321' }),
      store: new Store(path.join(dir, 'd.json')),
      log: silent,
    });
    const noPin = await on.execute('run_shell', { command: 'echo hi' }, { confirmed: true });
    assert.match(noPin.text, /needs your PIN/);

    const ran = await on.execute('run_shell', { command: 'echo hello-from-shell' }, { confirmed: true, shellPinOk: true });
    assert.equal(ran.ok, true);
    assert.match(ran.text, /hello-from-shell/);

    // Destructive + no confirmation → parked even with a valid shell context.
    const parked = await on.execute('run_shell', { command: 'touch /tmp/should-not-run' }, { shellPinOk: true });
    assert.equal(parked.needsConfirmation, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('actions: tool schemas are filtered by access level', () => {
  const dir = tempDir();
  try {
    const actions = createActions({ config: makeConfig(dir), store: new Store(path.join(dir, 'e.json')), log: silent });
    const names = actions.toolSchemas().map((t) => t.name);
    assert.ok(names.includes('open_app'));
    assert.ok(names.includes('screenshot'));
    assert.ok(names.includes('look_at_screen'));
    assert.ok(names.includes('send_file'));
    assert.ok(!names.includes('run_shell')); // ALLOW_SHELL=false
    const schema = actions.toolSchemas().find((t) => t.name === 'open_app');
    assert.ok(schema.parameters.required.includes('app'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── AI tool-calling loop (fake local Ollama) ────────────────────────────────

test('agentloop: free AI calls a tool, sees the result, then answers', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push(body);
      const hasToolResult = (body.messages ?? []).some((m) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'application/json' });
      if (!hasToolResult) {
        res.end(JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'open_app', arguments: '{"app":"chrome"}' } }],
          },
        }));
      } else {
        res.end(JSON.stringify({ message: { role: 'assistant', content: 'Chrome khul gaya ✅' } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const calls = [];
  const actions = {
    level: () => 'full',
    toolSchemas: () => [{ name: 'open_app', description: 'open', parameters: { type: 'object', properties: { app: { type: 'string' } }, required: ['app'] } }],
    execute: async (name, args) => { calls.push({ name, args }); return { ok: true, text: 'Opened chrome' }; },
  };
  const dir = tempDir();
  try {
    const config = makeConfig(dir, { aiProvider: 'auto', ollamaUrl: `http://127.0.0.1:${port}`, ollamaModel: 'llama3.2', agentTools: true, maxAgentSteps: 4 });
    const loop = createAgentLoop({ config, store: new Store(path.join(dir, 's.json')), actions, log: silent });
    assert.equal(loop.enabled, true);
    const selected = loop.toolsFor('open chrome and take a screenshot');
    assert.ok(selected.some((t) => t.name === 'open_app'));
    assert.ok(selected.length <= 20);
    const reply = await loop.run('chrome kholo', {});
    assert.equal(reply, 'Chrome khul gaya ✅');
    assert.deepEqual(calls, [{ name: 'open_app', args: { app: 'chrome' } }]);
    assert.equal(requests.length, 2);
    assert.ok(requests[1].messages.some((m) => m.role === 'tool' && /Opened chrome/.test(m.content)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agentloop: disabled with no brain, so offline commands still work', async () => {
  const dir = tempDir();
  try {
    const config = makeConfig(dir, { aiProvider: 'none' });
    const loop = createAgentLoop({ config, store: new Store(path.join(dir, 't.json')), actions: { toolSchemas: () => [], level: () => 'full' }, log: silent });
    assert.equal(loop.enabled, false);
    assert.equal(await loop.run('anything', {}), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── commands integration ────────────────────────────────────────────────────

test('commands: file write/read/send and confirm flow through WhatsApp text', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'note.txt');
  const store = new Store(path.join(dir, 'store.json'));
  const config = makeConfig(dir);
  fs.mkdirSync(config.sharedDir, { recursive: true });
  const agent = createAgent({ config, store, log: silent });
  try {
    assert.match(await agent.handle(`/write ${file} | namaste duniya`), /Saved/);
    assert.match(await agent.handle(`/read ${file}`), /namaste duniya/);
    const sent = await agent.handle(`/send ${file}`);
    assert.equal(sent.document.fileName, 'note.txt');
    assert.match(sent.document.buffer.toString(), /namaste/);

    const textOf = (reply) => (typeof reply === 'string' ? reply : reply?.text ?? '');
    const ask = await agent.handle(`/rm ${file}`);
    assert.match(textOf(ask), /Confirm/);
    assert.ok(fs.existsSync(file));
    const done = await agent.handle('haan');
    assert.match(textOf(done), /trash|deleted/i);
    assert.ok(!fs.existsSync(file));

    assert.match(await agent.handle(`/mkdir ${dir}/sub`), /Created folder/);
    assert.match(await agent.handle(`/cp ${dir}/sub | ${dir}/copy-of-sub`), /Copied/);
    assert.match(await agent.handle(`/mv ${dir}/copy-of-sub | ${dir}/moved-sub`), /Moved/);
    assert.ok(fs.existsSync(path.join(dir, 'moved-sub')));

    assert.match(await agent.handle('/access'), /Access/);
    assert.match(await agent.handle('/open definitely-not-an-app-xyz'), /couldn't find an app|find an app/i);
    assert.match(await agent.handle('/run echo hi'), /Shell is OFF/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── phone app + HTTP API ────────────────────────────────────────────────────

test('webapp: icon is a valid PNG, at the requested size', () => {
  for (const size of [192, 512]) {
    const png = iconPng(size);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
    assert.ok(png.length > 200);
  }
});

test('server: PIN login, token gate, app shell, chat, files', async () => {
  const dir = tempDir();
  const store = new Store(path.join(dir, 'store.json'));
  store.data.stats.received = 3;
  fs.mkdirSync(path.join(dir, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shared', 'share.txt'), 'hello');
  const config = makeConfig(dir, {
    port: 0,
    host: '127.0.0.1',
    bridgeToken: 'test-token',
    dashboardPin: '123456',
    allowSimulate: true,
    dryRun: true,
  });
  const sent = [];
  const whatsapp = {
    status: () => 'dry-run (test)',
    state: { lastQr: null, pairingCode: null },
    sendToOwner: async (m) => { sent.push(m); },
    simulate: async (text) => ({ ignored: false, sent: [{ text }] }),
    runOwner: async () => 'unused',
  };
  const mailbox = { observerOnline: () => false, listen: async () => [], deliverReply: () => 'direct', forwardToObserver: async () => null };
  const actions = createActions({ config, store, log: silent });
  const bridge = createBridgeServer({
    config, store, whatsapp, mailbox, actions,
    runOwner: async (text) => (text === 'screenshot' ? { text: 'here', image: Buffer.from([0x89, 0x50]) } : `echo: ${text}`),
    log: silent,
  });
  const server = await bridge.start();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // public shell
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Observer Agent/);
    const manifest = await fetch(`${base}/manifest.webmanifest`);
    assert.match(manifest.headers.get('content-type'), /manifest\+json/);
    const icon = await fetch(`${base}/icon-192.png`);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.deepEqual([...Buffer.from(await icon.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);

    // token gate
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '000000' }),
    })).status, 401);

    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '123456' }),
    });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    assert.equal(token, 'test-token');

    const auth = { 'x-bridge-token': token, 'content-type': 'application/json' };
    const status = await (await fetch(`${base}/api/status`, { headers: auth })).json();
    assert.equal(status.access.level, 'full');
    assert.equal(status.hasQr, false);

    const chat = await (await fetch(`${base}/api/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'hello' }) })).json();
    assert.equal(chat.text, 'echo: hello');

    const shot = await (await fetch(`${base}/api/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'screenshot' }) })).json();
    assert.match(shot.images[0], /^data:image\/png;base64,/);

    const files = await (await fetch(`${base}/api/files`, { headers: auth })).json();
    assert.equal(files.shared[0].name, 'share.txt');

    // authenticated download of a shared file (the app's "Send" link)
    const dl = await fetch(`${base}/api/download?path=${encodeURIComponent(files.shared[0].path)}`, { headers: auth });
    assert.equal(dl.status, 200);
    assert.equal(await dl.text(), 'hello');
    assert.match(dl.headers.get('content-disposition'), /share\.txt/);
    assert.equal((await fetch(`${base}/api/download?path=/etc/passwd`, { headers: auth })).status, 400);
    assert.equal((await fetch(`${base}/api/download?path=/etc/passwd`)).status, 401);

    // non-owner "from" is refused even with a valid token
    const notOwner = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: auth, body: JSON.stringify({ text: 'hi', from: '919999999999' }),
    });
    assert.equal(notOwner.status, 403);

    // bridge route still works for Observer alerts, owner-only on the way out
    const alert = await fetch(`${base}/tools/send-whatsapp`, {
      method: 'POST', headers: auth, body: JSON.stringify({ message: 'render done', to_number: OWNER }),
    });
    assert.equal(alert.status, 200);
    assert.equal(sent.at(-1), 'render done');
    const refused = await fetch(`${base}/tools/send-whatsapp`, {
      method: 'POST', headers: auth, body: JSON.stringify({ message: 'spam', to_number: '919999999999' }),
    });
    assert.equal(refused.status, 403);
  } finally {
    bridge.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('replyForApp: images become data URLs, documents keep their name', () => {
  const out = replyForApp({ text: 'shot', image: Buffer.from([1, 2, 3]), document: { fileName: 'a.pdf' } });
  assert.equal(out.text, 'shot');
  assert.match(out.images[0], /^data:image\/png;base64,/);
  assert.equal(out.documentName, 'a.pdf');
  assert.deepEqual(replyForApp(null), { ok: true, text: '' });
  assert.deepEqual(replyForApp('plain'), { ok: true, text: 'plain' });
});

// ── black-screenshot detection + Wayland plumbing ───────────────────────────

/** Tiny PNG writer so tests can build a black or white image with no deps. */
function makePng(size, rgb) {
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let offset = 0;
  for (let y = 0; y < size; y++) {
    raw[offset++] = 0;
    for (let x = 0; x < size; x++) {
      raw[offset++] = rgb[0];
      raw[offset++] = rgb[1];
      raw[offset++] = rgb[2];
    }
  }
  const chunk = (type, data) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const body = Buffer.concat([typeBuf, data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32 ? zlib.crc32(body) >>> 0 : 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('imaging: a black Wayland screenshot is detected as blank', () => {
  const black = imageStats(makePng(16, [0, 0, 0]));
  assert.equal(black.blank, true);
  assert.equal(black.mean, 0);
  assert.equal(black.width, 16);
  assert.equal(black.height, 16);

  const white = imageStats(makePng(16, [255, 255, 255]));
  assert.equal(white.blank, false);
  assert.ok(white.mean > 250);

  // Real PNGs from the icon generator must never be called blank.
  assert.equal(imageStats(iconPng(96)).blank, false);
  // Unknown/garbage input must not block a screenshot.
  assert.equal(imageStats(Buffer.from('not a png')).blank, false);
  assert.equal(imageStats(Buffer.from('not a png')).unknown, true);
});

test('pccontrol: xdg-desktop-portal Response parsing', () => {
  const ok = pc.parsePortalScreenshotResponse(
    "[.org.freedesktop.portal.Screenshot] Response (uint32 0, {'uri': <'file:///home/u/Pictures/Screenshot%20from%202026.png'>})",
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.path, '/home/u/Pictures/Screenshot from 2026.png');

  const cancelled = pc.parsePortalScreenshotResponse('Response (uint32 1, {})');
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.cancelled, true);
  assert.equal(pc.parsePortalScreenshotResponse('nothing useful'), null);
});

test('pccontrol: session + input diagnostics never throw and describe reality', () => {
  const session = pc.sessionInfo();
  assert.ok(['wayland', 'x11', 'headless'].includes(session.type));
  assert.equal(typeof session.graphical, 'boolean');
  // displayEnv must not point at a display that does not exist.
  const env = pc.displayEnv();
  if (!session.x11) assert.equal(env.DISPLAY, undefined);
  if (!session.wayland) assert.equal(env.WAYLAND_DISPLAY, undefined);

  const input = pc.inputDiagnostics();
  assert.equal(typeof input.ydotoolDaemon, 'boolean');
  assert.equal(typeof input.uinput, 'boolean');
});

test('actions: doctor + mouse move/scroll are registered', async () => {
  const dir = tempDir();
  try {
    const actions = createActions({ config: makeConfig(dir), store: new Store(path.join(dir, 'd.json')), log: silent });
    const names = actions.toolSchemas().map((t) => t.name);
    for (const name of ['doctor', 'move_mouse', 'scroll']) assert.ok(names.includes(name), `${name} missing`);
    const report = await actions.execute('doctor', {}, {});
    assert.equal(typeof report.text, 'string');
    assert.match(report.text, /Doctor/);
    assert.match(report.text, /session:/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pccontrol: a black capture is rejected and explained (Wayland reality)', async () => {
  const dir = tempDir();
  const shimDir = path.join(dir, 'bin');
  const runtimeDir = path.join(dir, 'run');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'wayland-0'), ''); // fake compositor socket

  const writePng = (file, rgb) => fs.writeFileSync(file, makePng(8, rgb));
  const shim = (name, body) => {
    const p = path.join(shimDir, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  // grim "succeeds" and hands back a black frame — exactly what Wayland does.
  shim('grim', `node -e "process.stdout.write('')" ; printf '%s' "${makePng(8, [0, 0, 0]).toString('base64')}" | base64 -d > "$1"`);

  const saved = {
    PATH: process.env.PATH,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  };
  process.env.PATH = `${shimDir}:${saved.PATH}`;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.XDG_SESSION_TYPE = 'wayland';
  // Point D-Bus at a dead socket: on a real desktop a working
  // xdg-desktop-portal would pop a screenshot dialog here and this test (which
  // is about the grim/black-frame path) would take the portal path instead.
  process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${path.join(dir, 'no-bus')}`;
  pc.detectSockets({ force: true });
  try {
    await assert.rejects(pc.captureScreenshot(), (err) => {
      assert.match(err.message, /black image/);
      assert.match(err.message, /xdg-desktop-portal/);
      return true;
    });

    // Swap in a shim that returns a real (white) screenshot: it must be accepted.
    shim('grim', `printf '%s' "${makePng(8, [255, 255, 255]).toString('base64')}" | base64 -d > "$1"`);
    const shot = await pc.captureScreenshot();
    assert.ok(shot.length > 0);
    assert.equal(imageStats(shot).blank, false);
    writePng(path.join(dir, 'unused.png'), [1, 2, 3]);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved.XDG_RUNTIME_DIR;
    if (saved.XDG_SESSION_TYPE === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = saved.XDG_SESSION_TYPE;
    if (saved.DBUS_SESSION_BUS_ADDRESS === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS;
    else process.env.DBUS_SESSION_BUS_ADDRESS = saved.DBUS_SESSION_BUS_ADDRESS;
    pc.detectSockets({ force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('portal: the D-Bus interface name is org.freedesktop.portal.Screenshot', async () => {
  // Regression: the method used to be sent as
  // org.freedesktop.portal.Desktop.Screenshot.Screenshot, which the portal
  // rejects with "UnknownMethod: No such interface … on object at path".
  const src = fs.readFileSync(new URL('../src/pccontrol.js', import.meta.url), 'utf8');
  assert.ok(src.includes('const PORTAL_SCREENSHOT_IFACE = \'org.freedesktop.portal.Screenshot\''));
  assert.ok(src.includes('`${PORTAL_SCREENSHOT_IFACE}.Screenshot`'));
  assert.ok(!src.includes('${PORTAL_DEST}.Screenshot.Screenshot'));

  // The monitor must NOT filter by object path: Response arrives on the
  // per-request handle path (/org/freedesktop/portal/desktop/request/...).
  const monitorLine = src.split('\n').find((l) => l.includes("'monitor'"));
  assert.ok(monitorLine && !monitorLine.includes('--object-path'), 'portal monitor must not filter on object-path');
});

test('portal: response signal from the request-handle path is parsed', () => {
  const line = "/org/freedesktop/portal/desktop/request/1_45/obsabc123: "
    + "org.freedesktop.portal.Request.Response (uint32 0, {'uri': <'file:///home/u/Pictures/Screenshot from 2026-10-19 15-20-00.png'>})";
  const parsed = pc.parsePortalScreenshotResponse(line);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.path, '/home/u/Pictures/Screenshot from 2026-10-19 15-20-00.png');

  // "denied" (code 2) and an empty options dict must be understood too.
  const denied = pc.parsePortalScreenshotResponse('… Request.Response (uint32 2, {})');
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 2);
});

test('portal: availability check reports a missing interface clearly', async () => {
  // In this sandbox there is no portal: the check must explain, not throw.
  const result = await pc.portalScreenshotAvailable();
  assert.equal(typeof result.available, 'boolean');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 10);
});

test('portal: finds the screenshot file even when the Response signal is missed', async () => {
  // The real-world failure: GNOME saves the PNG to Pictures, but the agent never
  // sees the D-Bus signal, so it reported a timeout while the file existed.
  const dir = tempDir();
  const pictures = path.join(dir, 'Pictures');
  fs.mkdirSync(pictures, { recursive: true });
  const saved = { XDG_PICTURES_DIR: process.env.XDG_PICTURES_DIR };
  process.env.XDG_PICTURES_DIR = pictures;

  try {
    const since = Date.now() - 5_000;
    assert.equal(pc.findNewScreenshot(since, [pictures]), null);

    const file = path.join(pictures, 'Screenshot from 2026-10-19 15-30-00.png');
    fs.writeFileSync(file, makePng(8, [10, 120, 200]));
    const hit = pc.findNewScreenshot(since, [pictures]);
    assert.equal(hit.path, file);
    assert.ok(hit.size > 0);

    // Old screenshots (before `since`) are ignored, small files too.
    const old = path.join(pictures, 'Screenshot from 2020-01-01 00-00-00.png');
    fs.writeFileSync(old, makePng(8, [1, 1, 1]));
    fs.utimesSync(old, new Date('2020-01-01'), new Date('2020-01-01'));
    assert.equal(pc.findNewScreenshot(since, [pictures]).path, file);

    // Non-screenshot images must not be picked up.
    fs.writeFileSync(path.join(pictures, 'cat.png'), makePng(8, [9, 9, 9]));
    assert.notEqual(pc.findNewScreenshot(since, [pictures]).path, path.join(pictures, 'cat.png'));

    // waitForCompleteFile: present + non-empty + stable size.
    assert.equal(await pc.waitForCompleteFile(file, { timeoutMs: 1_000 }), true);
    assert.equal(await pc.waitForCompleteFile(path.join(pictures, 'missing.png'), { timeoutMs: 300 }), false);
  } finally {
    if (saved.XDG_PICTURES_DIR === undefined) delete process.env.XDG_PICTURES_DIR;
    else process.env.XDG_PICTURES_DIR = saved.XDG_PICTURES_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('portal: response with @a{sv} spelling and extra keys still parses', () => {
  const line = "…: org.freedesktop.portal.Request.Response (uint32 0, @a{sv} "
    + "{'uri': <'file:///home/u/Pictures/Screenshot%20from%202026.png'>, 'width': <int32 1920>})";
  const parsed = pc.parsePortalScreenshotResponse(line);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.path, '/home/u/Pictures/Screenshot from 2026.png');

  const denied = pc.parsePortalScreenshotResponse('…: org.freedesktop.portal.Request.Response (uint32 2, {})');
  assert.equal(denied.denied, true);
  assert.equal(denied.ok, false);
});

// ── typing long text (no more 500-character ceiling) ────────────────────────

test('typing: long text is chunked without losing a single character', () => {
  const { splitForTyping } = pc;

  const essay = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(80); // ~4.5k
  const chunks = splitForTyping(essay, 180);
  assert.ok(chunks.length > 20);
  assert.ok(chunks.every((c) => c.length <= 181));
  assert.equal(chunks.join(''), essay, 'chunking must be lossless');

  // Newlines and emoji survive (clipboard/typing must not corrupt them).
  const mixed = 'line one\nline two\nनमस्ते दुनिया 🙂\n' + 'x'.repeat(300);
  assert.equal(splitForTyping(mixed, 100).join(''), mixed);

  // Degenerate input.
  assert.deepEqual(splitForTyping('', 180), []);
  assert.deepEqual(splitForTyping('short', 180), ['short']);
  // A single very long word still gets cut (no infinite loop).
  const word = 'a'.repeat(950);
  assert.equal(splitForTyping(word, 180).join(''), word);
});

test('typing: 500+ character payloads are no longer truncated', async () => {
  const dir = tempDir();
  const shimDir = path.join(dir, 'bin');
  const runtimeDir = path.join(dir, 'run');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'wayland-0'), '');

  // ydotool shim: append every argv it receives, one line per call.
  const log = path.join(dir, 'typed.log');
  fs.writeFileSync(path.join(shimDir, 'ydotool'), `#!/bin/sh\nshift\nprintf '%s\\n' "$*" >> ${log}\n`, { mode: 0o755 });

  const saved = { PATH: process.env.PATH, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, XDG_SESSION_TYPE: process.env.XDG_SESSION_TYPE };
  process.env.PATH = `${shimDir}:${saved.PATH}`;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.XDG_SESSION_TYPE = 'wayland';
  pc.detectSockets({ force: true });
  try {
    const text = 'A'.repeat(1200);
    const reply = await pc.typeText(text);
    assert.match(reply, /Typed 1200 characters/);
    assert.match(reply, /chunks/);
    const written = fs.readFileSync(log, 'utf8').trim().split('\n').join('');
    assert.equal(written.length, 1200, 'all typed characters must reach ydotool');
    assert.equal(written, text);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.XDG_RUNTIME_DIR === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved.XDG_RUNTIME_DIR;
    if (saved.XDG_SESSION_TYPE === undefined) delete process.env.XDG_SESSION_TYPE;
    else process.env.XDG_SESSION_TYPE = saved.XDG_SESSION_TYPE;
    pc.detectSockets({ force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('actions/commands: paste is available for long text', () => {
  const dir = tempDir();
  try {
    const actions = createActions({ config: makeConfig(dir), store: new Store(path.join(dir, 'p.json')), log: silent });
    const names = actions.toolSchemas().map((t) => t.name);
    assert.ok(names.includes('paste_text'));
    const typeSchema = actions.toolSchemas().find((t) => t.name === 'type_text');
    assert.ok(typeSchema.parameters.properties.method.enum.includes('paste'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
