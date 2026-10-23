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
