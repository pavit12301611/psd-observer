import test from 'node:test';
import assert from 'node:assert/strict';
import { actionForText, createPcRelay, sendPcCommand, validateRelaySettings } from '../src/oracle-relay.js';

const token = 'ab'.repeat(32);
test('only explicit supported commands become structured actions', () => {
  assert.deepEqual(actionForText('chrome kholo'), { name: 'open_app', args: { app: 'chrome' } });
  assert.deepEqual(actionForText('screenshot bhej do'), { name: 'screenshot', args: {} });
  assert.deepEqual(actionForText('awaaz kam karo'), { name: 'volume', args: { action: 'down' } });
  assert.deepEqual(actionForText('/pc volume 40'), { name: 'volume', args: { action: 'set', value: 40 } });
  for (const text of ['/run rm -rf ~', '/pc shutdown', '/pc volume 101', '/open https://evil.test', '/open x; touch foo', '/yes', 'hello']) assert.equal(actionForText(text), null, text);
  assert.throws(() => validateRelaySettings('8.8.8.8', token));
  assert.throws(() => validateRelaySettings('localhost', token));
  assert.throws(() => validateRelaySettings('100.100.1.1', 'short'));
});

test('relay authenticates, validates on PC, serializes media and rejects busy requests', async () => {
  let resolve; let calls = 0;
  const relay = createPcRelay({ host: '127.0.0.1', port: 0, token, execute: async name => {
    calls++;
    if (name === 'open_app') await new Promise(r => { resolve = r; });
    return name === 'screenshot' ? { text: 'screen', image: Buffer.from('image') } : { text: 'done' };
  } });
  await relay.start();
  const port = relay.server.address().port;
  const base = `http://127.0.0.1:${port}/command`;
  try {
    let r = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${'ff'.repeat(32)}` }, body: JSON.stringify({ text: '/screenshot' }) });
    assert.equal(r.status, 401); assert.equal(calls, 0);
    r = await fetch(base, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: '/run dangerous' }) });
    assert.equal(r.status, 400); assert.equal(calls, 0);
    const image = await sendPcCommand({ host: '127.0.0.1', port, token, text: '/screenshot' });
    assert.equal(image.text, 'screen'); assert.equal(image.image.toString(), 'image');
    const pending = sendPcCommand({ host: '127.0.0.1', port, token, text: '/open chrome' });
    while (!resolve) await new Promise(r => setTimeout(r, 5));
    assert.match(await sendPcCommand({ host: '127.0.0.1', port, token, text: '/screenshot' }), /busy/);
    resolve(); assert.equal(await pending, 'done'); assert.equal(calls, 2);
  } finally { await relay.stop(); }
});

test('cloud routing never runs commands on the VM or falls back from PC to AI', async () => {
  const { createOracleAgent } = await import('../src/oracle-agent.js');
  let commands = [], questions = [];
  const agent = createOracleAgent({ sendCommand: async text => { commands.push(text); throw Error('offline'); }, askModel: async text => { questions.push(text); return 'hello'; } });
  assert.match(await agent.handle('chrome kholo'), /may have run/);
  assert.match(await agent.handle('/pc shutdown'), /Unsupported/);
  assert.match(await agent.handle('wifi off karo'), /Unsupported/);
  assert.match(await agent.handle('hello'), /AI chat only/);
  assert.deepEqual(commands, ['chrome kholo']); assert.deepEqual(questions, ['hello']);
});

test('oracle agent and WhatsApp gate reject non-owner even with an old open guest policy', async () => {
  const { createOracleAgent } = await import('../src/oracle-agent.js');
  const { createWhatsApp } = await import('../src/whatsapp.js');
  let calls = 0;
  const agent = createOracleAgent({ sendCommand: async () => { calls++; }, askModel: async () => { calls++; } });
  assert.match(await agent.handle('/screenshot', { isOwner: false }), /Owner only/);
  const store = { data: { guestPolicy: { mode: 'all', allowlist: [], blocklist: [] }, stats: {} }, bump() {}, save() {} };
  const wa = createWhatsApp({ config: { dryRun: true, oracleTextOnly: true, ownerNumber: '919999999999' }, store, agent, log: {} });
  const result = await wa.simulate('/screenshot', '918888888888');
  assert.equal(result.ignored, true); assert.equal(calls, 0);
});
