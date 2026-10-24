// End-to-end permission/privacy checks. Every file lives in a disposable dir;
// PC control is disabled and there are no configured external model endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Mailbox } from '../src/mailbox.js';
import { createAgent } from '../src/commands.js';
import { cancelPending } from '../src/safety.js';
import { learnExample, brainInfo } from '../src/neural/index.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-deep-command-'));
  const store = new Store(path.join(dir, 'state.json'));
  const config = { dataDir: dir, stateFile: store.file, ownerNumber: '919999999999', agentNumber: '918888888888', historyLimit: 12, allowPcControl: false, allowShell: false, dryRun: true, agentTag: false };
  const agent = createAgent({ config, store, mailbox: new Mailbox({ ttlMs: 30_000 }), log });
  t.after(() => { store.saveNow(); cancelPending(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, agent, config };
}

test('deep/commands: panic requires confirmation, clears scoped owner memory/model examples and does not revive data', async (t) => {
  const f = fixture(t); f.store.addNote('private fixture'); f.store.pushHistory('user', 'private fixture');
  f.store.data.facts.secret = 'private fixture';
  learnExample('owner secret phrase', 'personal', { dataDir: f.dir });
  assert.equal(brainInfo({ dataDir: f.dir }).approvedExamples, 1);
  const requested = await f.agent.handle('/panic');
  assert.match(requested, /Pakka/); assert.equal(f.store.data.notes.length, 1);
  const confirmed = await f.agent.handle(`/confirm ${requested.match(/\/confirm (\w+)/)[1]}`);
  assert.match(confirmed, /Owner history\/facts reset/); assert.match(confirmed, /PC control disabled/);
  assert.deepEqual(f.store.data.history, []); assert.deepEqual(f.store.data.facts, {}); assert.deepEqual(f.store.data.notes, []);
  assert.equal(brainInfo({ dataDir: f.dir }).approvedExamples, 0);
  f.store.saveNow(); assert.doesNotMatch(fs.readFileSync(f.store.file, 'utf8'), /private fixture/);
});

test('deep/commands: permanently emptying trash needs one-shot owner confirmation and uses the configured data directory', async (t) => {
  const f = fixture(t), file = path.join(f.dir, 'trash/fixture.txt');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'keep until confirmed');
  const requested = await f.agent.handle('/trash empty');
  assert.match(requested, /Pakka/); assert.equal(fs.existsSync(file), true);
  assert.match(await f.agent.handle('/confirm incorrect'), /Token galat/); assert.equal(fs.existsSync(file), true);
  assert.match(await f.agent.handle(`/confirm ${requested.match(/\/confirm (\w+)/)[1]}`), /empty kar diya/);
  assert.equal(fs.existsSync(file), false);
});

test('app/commands: approval tickets consume only the reviewed scoped trash operation and cannot replay', async (t) => {
  const f = fixture(t), file = path.join(f.dir, 'trash/fixture.txt');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, 'owned fixture');
  await f.agent.handle('/trash empty'); const pending = f.agent.app.state().pending[0];
  assert.equal(pending.kind, 'safety'); assert.equal(fs.existsSync(file), true);
  const decision = f.agent.app.decide(pending.id, true); assert.equal(decision.stale, false); assert.match(await decision.reply, /empty kar diya/);
  assert.equal(fs.existsSync(file), false); assert.equal(f.agent.app.decide(pending.id, true).stale, true);
});
test('app/commands: replaced registry actions cannot be approved with the previous visible ticket', async (t) => {
  const f = fixture(t); let ran = 0;
  const entry = f.agent.actions.registry.find((e) => e.name === 'close_app'); entry.run = async () => { ran++; return 'fixture only'; };
  await f.agent.actions.execute('close_app', { app: 'fixture one' }); const first = f.agent.app.state().pending[0].id;
  await f.agent.actions.execute('close_app', { app: 'fixture two' }); assert.equal(f.agent.app.decide(first, true).stale, true); assert.equal(ran, 0);
  const current = f.agent.app.state().pending[0].id; assert.equal((await f.agent.app.decide(current, true).reply).text, 'fixture only'); assert.equal(ran, 1);
});

test('app/commands: confirmed actions traverse the original busy barrier; no parallel approvals or PC writes', async (t) => {
  const f = fixture(t); let release, ran = 0; const gate = new Promise((r) => { release = r; });
  f.agent.actions.registry.find((e) => e.name === 'close_app').run = async () => { ran++; await gate; return 'fixture finished'; };
  await f.agent.actions.execute('close_app', { app: 'first fixture' });
  const id = f.agent.app.state().pending[0].id, first = f.agent.app.decide(id, true);
  assert.equal(f.agent.app.busy(), true); assert.equal(ran, 1);
  await f.agent.actions.execute('close_app', { app: 'second fixture' });
  const second = f.agent.app.state().pending[0].id;
  assert.equal(f.agent.app.decide(second, true).busy, true); assert.equal(ran, 1);
  assert.match(await f.agent.handle('/calc 2+2'), /kaam chal raha/);
  release(); await first.reply; assert.equal(f.agent.app.busy(), false);
});
