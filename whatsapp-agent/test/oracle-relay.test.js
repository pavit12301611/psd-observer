import test from 'node:test';
import assert from 'node:assert/strict';
import { isSupportedPcCommand, createPcRelay, sendPcCommand, validateRelaySettings } from '../src/oracle-relay.js';
import { createOracleAgent } from '../src/oracle-agent.js';

const token = 'ab'.repeat(32);
test('PC validates single supported slash commands and rejects chat, AI, shell and stacks', () => {
  for (const text of ['/open chrome', '/screenshot', '/pc volume 40', '/wifi off', '/yes', '/close chrome', '/ls ~', '/send ~/a.pdf']) assert.equal(isSupportedPcCommand(text), true, text);
  for (const text of ['chrome kholo', 'hello', '/run rm -rf ~', '/ask hello', '/dsh hello', '/pc tap Delete', '/remind in 1m test', '/open chrome\n/run bad', '/', '/screenshot' + 'x'.repeat(4001)]) assert.equal(isSupportedPcCommand(text), false, text);
  assert.throws(() => validateRelaySettings('8.8.8.8', token));
  assert.throws(() => validateRelaySettings('localhost', token));
  assert.throws(() => validateRelaySettings('100.100.1.1', 'short'));
});

test('relay authenticates, rejects non-slash inputs, preserves media and serializes work', async () => {
  let resolve; const calls = [];
  const relay = createPcRelay({ host: '127.0.0.1', port: 0, token, execute: async text => {
    calls.push(text);
    if (text === '/open chrome') await new Promise(r => { resolve = r; });
    if (text === '/screenshot') return { text: 'screen', image: Buffer.from('image') };
    if (text === '/send ~/a') return { text: 'file', document: { buffer: Buffer.from('data'), fileName: 'a.txt', mimetype: 'text/plain' } };
    if (text === '/close chrome') return '⚠️ Confirm: close chrome\nReply *haan* / *yes* within 2 minutes';
    return 'done';
  } });
  await relay.start();
  const port = relay.server.address().port;
  const base = `http://127.0.0.1:${port}/command`;
  const send = text => sendPcCommand({ host: '127.0.0.1', port, token, text });
  try {
    let r = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${'ff'.repeat(32)}` }, body: JSON.stringify({ text: '/screenshot' }) });
    assert.equal(r.status, 401); assert.equal(calls.length, 0);
    for (const text of ['chrome kholo', '/run dangerous']) {
      r = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text }) });
      assert.equal(r.status, 400); assert.equal(calls.length, 0);
    }
    const image = await send('/screenshot'); assert.equal(image.text, 'screen'); assert.equal(image.image.toString(), 'image');
    const doc = await send('/send ~/a'); assert.equal(doc.document.buffer.toString(), 'data'); assert.equal(doc.document.fileName, 'a.txt');
    assert.match(await send('/close chrome'), /confirm with \/yes/);
    const pending = send('/open chrome');
    while (!resolve) await new Promise(r => setTimeout(r, 5));
    assert.match(await send('/screenshot'), /busy/);
    resolve(); assert.equal(await pending, 'done'); assert.equal(calls.length, 4);
  } finally { await relay.stop(); }
});

test('all slash messages go only to PC and every normal text goes only to model', async () => {
  let commands = [], questions = [];
  const agent = createOracleAgent({ sendCommand: async text => { commands.push(text); throw Error('offline'); }, askModel: async text => { questions.push(text); return 'AI reply'; } });
  for (const text of ['/pc shutdown', '/something-unknown', '/help', '/yes']) assert.match(await agent.handle(text), /may have run/);
  for (const text of ['chrome kholo', 'wifi off karo', 'haan', 'hello', 'what is /help']) assert.equal(await agent.handle(text), 'AI reply');
  assert.deepEqual(commands, ['/pc shutdown', '/something-unknown', '/help', '/yes']);
  assert.deepEqual(questions, ['chrome kholo', 'wifi off karo', 'haan', 'hello', 'what is /help']);
  assert.equal(await agent.handle(' '.repeat(5)), 'Send a message or /help.');
  const huge = 'a'.repeat(4001); assert.equal(await agent.handle(huge), 'AI reply'); assert.equal(questions.at(-1), huge);
  assert.match(await agent.handle('a'.repeat(16001)), /too long/);
});

test('owner gate refuses guests even with an old open policy', async () => {
  const { createWhatsApp } = await import('../src/whatsapp.js');
  let calls = 0;
  const agent = createOracleAgent({ sendCommand: async () => { calls++; }, askModel: async () => { calls++; } });
  assert.match(await agent.handle('/screenshot', { isOwner: false }), /Owner only/);
  const store = { data: { guestPolicy: { mode: 'all', allowlist: [], blocklist: [] }, stats: {} }, bump() {}, save() {} };
  const wa = createWhatsApp({ config: { dryRun: true, oracleTextOnly: true, ownerNumber: '919999999999' }, store, agent, log: {} });
  const result = await wa.simulate('/screenshot', '918888888888');
  assert.equal(result.ignored, true); assert.equal(calls, 0);
});

test('real local command dispatcher retains access controls and confirmation', { skip: !process.env.OBSERVER_TEST_SANDBOX }, async () => {
  const { loadConfig } = await import('../src/config.js');
  const { Store } = await import('../src/store.js');
  const { createAgent } = await import('../src/commands.js');
  const config = loadConfig({ dryRun: true, env: { AI_PROVIDER: 'none', ACCESS_LEVEL: 'standard', DATA_DIR: 'data' } });
  const store = new Store(config.storeFile);
  const local = createAgent({ config, store, log: {} });
  const relay = createPcRelay({ host: '127.0.0.1', port: 0, token, execute: text => local.handle(text, { isOwner: true }) });
  await relay.start();
  const port = relay.server.address().port;
  const send = text => sendPcCommand({ host: '127.0.0.1', port, token, text });
  try {
    assert.match(await send('/time'), /🕐/);
    const { createWhatsApp } = await import('../src/whatsapp.js');
    let modelInputs = [];
    const cloud = createOracleAgent({ sendCommand: send, askModel: async text => { modelInputs.push(text); return 'Oracle answer'; } });
    const wa = createWhatsApp({ config: { ...config, dryRun: true, oracleTextOnly: true, voiceCall: false }, store, agent: cloud, log: {} });
    assert.match((await wa.simulate('/ping', config.ownerNumber)).sent[0].text, /Pong/);
    assert.equal((await wa.simulate('chrome kholo', config.ownerNumber)).sent[0].text, 'Oracle answer');
    assert.deepEqual(modelInputs, ['chrome kholo']);
    assert.match(await send('/close nonexistent'), /confirm/i);
    assert.ok(store.data.pending);
    assert.match(await send('/no'), /cancel/i);
    assert.equal(store.data.pending, null);
  } finally { await relay.stop(); }
});
