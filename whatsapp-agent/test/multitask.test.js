import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { splitBatch, parseBatch, runBatch, batchSummary, conversationSnapshot, concurrencyLimit } from '../src/multitask.js';
import { createTaskRegistry, sleepWith } from '../src/cancel.js';
import { createAgent } from '../src/commands.js';
import { Store } from '../src/store.js';
import { chat } from '../src/ai.js';
import { pendingState, cancelPending } from '../src/safety.js';
import { brainInfo, loadBrain } from '../src/neural/index.js';
import { orchestrate } from '../src/agents.js';

const silent = { info() {}, warn() {}, error() {} };
const answer = (text) => ({ choices: [{ message: { content: text } }] });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const firstQ = 'explain database snapshot isolation in a speculative transaction scheduler';
const secondQ = 'write a playful poem about a purple robot exploring a comet';

async function fixture(t, handler = async (body) => answer(`Answer for: ${body.messages.at(-1).content}`)) {
  const seen = [];
  let active = 0, peak = 0;
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); seen.push(body); active++; peak = Math.max(peak, active);
      const value = await handler(body, seen.length, res);
      if (value) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); }
    } finally { active--; }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-multitask-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = {
    ownerNumber: '919111111111', agentNumber: '919222222222', timezone: 'Asia/Kolkata',
    aiProvider: 'openrouter', openrouterApiKey: 'local-test-secret', openrouterBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    openrouterModel: 'fixture/text-70b:free', openrouterModelFallbacks: [], ollamaModel: '', ollamaUrl: '',
    groqApiKey: '', geminiApiKey: '', routerPrefer: 'cloud', aiTimeoutMs: 3000,
    agentTools: false, accessLevel: 'full', allowShell: false, allowPcControl: false,
    dataDir: dir, downloadsDir: dir, wikiGrounding: false, maxParallelTasks: 2,
    agentTag: false,
  };
  const store = new Store(); store.save = () => {}; store.saveNow = () => {};
  const agent = createAgent({ config, store, log: silent, taskRegistry: createTaskRegistry({ log: silent }) });
  return { agent, config, store, seen, dir, get peak() { return peak; } };
}

const task = (n, lane = 'parallel') => ({ lane, kind: 'answer', cmd: 'ask', args: `${n}` });

test('multitask: splitter respects logical OR in quotes/code and ordinary apostrophes', () => {
  assert.deepEqual(splitBatch('/ask explain "a || b" || /time'), ['/ask explain "a || b"', '/time']);
  assert.deepEqual(splitBatch('/ask debug ```js\na || b\n``` || /date'), ['/ask debug ```js\na || b\n```', '/date']);
  assert.equal(splitBatch("/ask don't overcomplicate this || /time").length, 2);
  assert.throws(() => splitBatch('/ask missing "quote || /time'), /Close/);
  assert.throws(() => splitBatch('/time || || /date'), /non-empty/);
  assert.throws(() => splitBatch(Array(9).fill('/time').join(' || ')), /1..8/);
});

test('multitask: only a hard allowlist enters the parallel lane; controls cannot auto-approve', () => {
  const { tasks } = parseBatch('/ask explain caches || /time || /open chrome || /pc brightness 50 || /rm /tmp/x');
  assert.deepEqual(tasks.map((t) => t.lane), ['parallel', 'parallel', 'serial', 'serial', 'serial']);
  for (const raw of ['/batch /time', '/yes', '/approve 1', '/run 1234 id', '/screenshot', '/pc shutdown', '/totallyunknown']) {
    assert.throws(() => parseBatch(raw), /not batch-safe/);
  }
  assert.equal(parseBatch('/open chrome || /stop || /open code').stop, true);
  assert.equal(concurrencyLimit(999), 4);
  assert.equal(concurrencyLimit(-2), 1);
});

test('multitask: bounded parallelism and output order do not depend on completion order', async () => {
  let active = 0, peak = 0;
  const finished = [];
  const result = await runBatch(Array.from({ length: 6 }, (_, i) => task(i)), { concurrency: 2,
    run: async (t) => {
      active++; peak = Math.max(peak, active);
      await delay(Number(t.args) === 0 ? 20 : 3);
      active--; finished.push(t.args); return { ok: true, text: t.args };
    },
  });
  assert.equal(peak, 2);
  assert.equal(finished[0], '1');
  assert.deepEqual(result.entries.map((e) => e.value.text), ['0', '1', '2', '3', '4', '5']);
  assert.ok(result.entries.every((e) => e.status === 'completed'));
});

test('multitask: serial side effects are exclusive barriers between answer groups', async () => {
  const events = []; let active = 0;
  const result = await runBatch([task(0), task(1), task(2, 'serial'), task(3), task(4, 'serial')], { concurrency: 4,
    run: async (t) => {
      if (t.lane === 'serial') assert.equal(active, 0, 'no answer/action overlaps this side effect');
      active++; events.push(`start${t.args}`); await delay(3); events.push(`end${t.args}`); active--;
      return { ok: true, text: 'verified' };
    },
  });
  assert.equal(result.halted, '');
  assert.ok(events.indexOf('start2') > events.indexOf('end0'));
  assert.ok(events.indexOf('start2') > events.indexOf('end1'));
  assert.ok(events.indexOf('start3') > events.indexOf('end2'));
  assert.ok(events.indexOf('start4') > events.indexOf('end3'));
});

test('multitask: a failed part is visible, not retried, and queued work is skipped', async () => {
  const seen = [];
  const result = await runBatch([task(0), task(1), task(2)], {
    run: async (t) => { seen.push(t.args); await delay(t.args === '0' ? 1 : 10); return { ok: t.args !== '0', text: t.args === '0' ? 'provider unavailable' : 'answer' }; },
  });
  assert.deepEqual(seen, ['0', '1']);
  assert.deepEqual(result.entries.map((e) => e.status), ['failed', 'completed', 'skipped']);
  assert.match(batchSummary(result), /1\/3 completed/);
  assert.match(batchSummary(result), /provider unavailable/);
});

test('multitask: pending confirmation parks the batch instead of approving/overwriting it', async () => {
  const seen = [];
  const result = await runBatch([task(0, 'serial'), task(1, 'serial')], {
    run: async (t) => { seen.push(t.args); return { ok: true, text: 'Owner confirmation needed', pending: true }; },
    shouldPause: (v) => v.pending,
  });
  assert.deepEqual(seen, ['0']);
  assert.deepEqual(result.entries.map((e) => e.status), ['waiting', 'skipped']);
  assert.match(batchSummary(result), /NOT started or auto-approved/);
});

test('multitask: cancellation reaches running workers and prevents every queued start', async () => {
  const controller = new AbortController(), ready = deferred(); let started = 0;
  const running = runBatch(Array.from({ length: 5 }, (_, i) => task(i)), { signal: controller.signal,
    run: async () => { if (++started === 2) ready.resolve(); await sleepWith(5000, controller.signal); return 'not returned'; },
  });
  await ready.promise; controller.abort();
  const result = await running;
  assert.equal(started, 2);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.entries.map((e) => e.status), ['cancelled', 'cancelled', 'skipped', 'skipped', 'skipped']);
});

test('multitask: snapshots detach nested owner state and have no persistence/history writer', () => {
  let writes = 0;
  const original = { data: { history: [{ role: 'user', content: 'old' }], profile: { goals: ['a'] } }, save: () => writes++ };
  const snap = conversationSnapshot(original);
  snap.data.profile.goals.push('b'); snap.data.history[0].content = 'changed'; snap.save(); snap.pushHistory('user', 'new');
  assert.deepEqual(original.data, { history: [{ role: 'user', content: 'old' }], profile: { goals: ['a'] } });
  assert.equal(writes, 0);
  assert.equal(snap.data.history.length, 1);
});

test('multitask e2e: two answers overlap but write exactly one owner turn/profile update', async (t) => {
  const f = await fixture(t, async (body, n) => { await delay(n === 1 ? 45 : 10); return answer(`Result ${n}: ${body.messages.at(-1).content}`); });
  const result = await f.agent.handle(`/batch /ask ${firstQ} || /ask ${secondQ}`);
  assert.equal(f.seen.length, 2);
  assert.equal(f.peak, 2);
  assert.match(result, /2\/2 completed/);
  assert.ok(result.indexOf(firstQ) < result.indexOf(secondQ));
  assert.equal(f.store.data.history.length, 2);
  assert.equal(f.store.data.profile.totalTurns, 1);
  assert.ok(f.seen.every((b) => b.messages.filter((m) => m.role !== 'system').length === 1));
  assert.ok(f.seen.every((b) => b.messages[0].content.includes('READ-ONLY ANSWER MODE')));
  assert.equal(fs.existsSync(path.join(f.dir, 'neural-examples.json')), false, 'no prediction-as-ground-truth feedback');
});

test('multitask e2e: automatic squads get separate sub-prompts, stable order and one history pair', async (t) => {
  const f = await fixture(t, async (body, n) => { await delay(n === 1 ? 35 : 5); return answer(`Task answer: ${body.messages.at(-1).content}`); });
  const text = `${firstQ} and ${secondQ}`;
  const result = await f.agent.handle(`/ask ${text}`);
  assert.equal(f.seen.length, 2);
  assert.deepEqual(f.seen.map((b) => b.messages.at(-1).content), [firstQ, secondQ]);
  assert.ok(f.seen.every((b) => b.messages[0].content.includes('Original multi-part question') && b.messages[0].content.includes('SQUAD MODE')));
  assert.ok(result.indexOf(firstQ) < result.indexOf(secondQ));
  assert.equal(f.store.data.history.length, 2);
  assert.equal(f.store.data.profile.totalTurns, 1);
});

test('multitask e2e: PC actions never overlap and cannot inherit an implicit confirmation', async (t) => {
  const f = await fixture(t); let active = 0;
  const seen = [];
  f.agent.actions.execute = async (name, args, ctx) => {
    assert.equal(active, 0); assert.ok(!ctx.confirmed); assert.ok(ctx.signal);
    active++; seen.push([name, args.app]); await delay(5); active--;
    return { ok: true, text: `Opened ${args.app}` };
  };
  const reply = await f.agent.handle('/batch /open chrome || /open code');
  assert.deepEqual(seen, [['open_app', 'chrome'], ['open_app', 'code']]);
  assert.match(reply, /2\/2 completed/);
});

test('multitask e2e: /rm confirmation pauses following tasks without touching files or notes', async (t) => {
  cancelPending(); t.after(cancelPending);
  const f = await fixture(t);
  const reply = await f.agent.handle('/batch /rm /tmp/not-touched-by-test || /note must-not-be-written');
  assert.ok(pendingState());
  assert.equal(f.store.data.notes.length, 0);
  assert.match(reply, /awaiting|waiting|Confirmation needed/);
  assert.match(reply, /2\. \/note \[skipped\]/);
  const blocked = await f.agent.handle('/batch /yes || /note still-not-written');
  assert.match(blocked, /not started/i);
  assert.ok(pendingState());
});

test('multitask e2e: unsupported/natural side effects are rejected before any earlier task executes', async (t) => {
  const f = await fixture(t);
  for (const raw of ['/note should-not-write || /run 123 id', '/note should-not-write || open chrome']) {
    const reply = await f.agent.handle(`/batch ${raw}`);
    assert.match(reply, /not started/i); assert.equal(f.store.data.notes.length, 0);
  }
});

test('multitask e2e: guest contexts cannot reach batch, training, corrections or progress', async (t) => {
  const f = await fixture(t);
  for (const text of ['/batch /note forbidden', '/neural train', '/neural learn math | poison', '/neural status', '/taskstatus']) {
    const result = await f.agent.handle(text, { isOwner: false, senderNumber: '919999999999' });
    assert.match(result, /Command Blocked|owner/i);
  }
  assert.equal(f.store.data.notes.length, 0);
  assert.equal(f.seen.length, 0);
  assert.equal(fs.existsSync(path.join(f.dir, 'neural-examples.json')), false);
});

test('multitask e2e: progress and /stop bypass busy guard, abort both chats, and do not start queued work', async (t) => {
  const ready = deferred();
  const f = await fixture(t, async (_body, n) => { if (n === 2) ready.resolve(); return null; });
  const batch = f.agent.handle(`/batch /ask ${firstQ} || /ask ${secondQ} || /ask explain the third queued task`);
  await ready.promise;
  assert.match(await f.agent.handle('/batch status'), /2 running · 1 queued/);
  assert.match(await f.agent.handle('/taskstatus'), /Work status/);
  assert.match(await f.agent.handle('/stop'), /Roka gaya/);
  assert.equal(await batch, null);
  assert.equal(f.seen.length, 2, 'no fallback or third call after cancellation');
  assert.equal(f.store.data.history.length, 0, 'cancelled replies are not committed');
  assert.match(await f.agent.handle('/batch status'), /2 skipped|1 skipped/);
});

test('multitask e2e: an embedded /stop wins before the first action', async (t) => {
  const f = await fixture(t); let calls = 0;
  f.agent.actions.execute = async () => { calls++; return { ok: true }; };
  assert.match(await f.agent.handle('/batch /open chrome || /stop'), /No batch tasks started/);
  assert.equal(calls, 0);
});

test('chat correctness: response cache invalidates changed memory/history/mission and keeps code case', async (t) => {
  const f = await fixture(t);
  const q = 'explain the optimal lifetime of a hazard pointer';
  const options = { skipBackgroundReflect: true };
  await chat(f.config, f.store, q, silent, options);
  const again = await chat(f.config, f.store, q, silent, options);
  assert.equal(again.cached, true);
  assert.equal(f.seen.length, 1);
  f.store.data.facts = { language: 'French' };
  assert.equal((await chat(f.config, f.store, q, silent, options)).cached, false);
  assert.equal(f.seen.length, 2);
  f.store.pushHistory('user', 'Now relate all explanations to memory fences.');
  await chat(f.config, f.store, q, silent, options);
  assert.equal(f.seen.length, 3);
  await chat(f.config, f.store, q, silent, { ...options, taskBrief: 'Give only a one-line critique.' });
  assert.equal(f.seen.length, 4);
  await chat(f.config, f.store, 'debug let Foo = 1;', silent, options);
  await chat(f.config, f.store, 'debug let foo = 1;', silent, options);
  assert.equal(f.seen.length, 6, 'different code case cannot collide');
});

test('chat correctness: isolated calls never append history or train persona, even on cache hits', async (t) => {
  const f = await fixture(t), snapshot = conversationSnapshot(f.store);
  const opts = { isolated: true, skipBackgroundReflect: true };
  const one = await chat(f.config, snapshot, firstQ, silent, opts);
  const two = await chat(f.config, snapshot, firstQ, silent, opts);
  assert.ok(one.text); assert.equal(two.cached, true);
  assert.equal(f.store.data.history.length, 0);
  assert.equal(snapshot.data.history.length, 0);
  assert.equal(snapshot.data.profile.totalTurns, 0);
});

test('neural commands: approved correction works immediately and /retrain actually runs a worker', async (t) => {
  const f = await fixture(t);
  assert.match(await f.agent.handle('/neural learn personal | custom owner constellation'), /Owner-approved/);
  assert.match(await f.agent.handle('/neural classify custom owner constellation'), /personal/);
  assert.equal(brainInfo({ dataDir: f.dir }).approvedExamples, 1);
  const result = await f.agent.handle('/retrain');
  assert.match(result, /actually completed/);
  assert.ok(fs.existsSync(path.join(f.dir, 'neural-weights.json')));
  assert.equal(loadBrain({ dataDir: f.dir }).meta.metrics.intent.approvedRuntimeExamples, 1);
});

test('dispatcher: dependencies and quoted code never create a speculative parallel squad', () => {
  assert.equal(orchestrate('explain caching then write a poem about it', { label: 'explain', scores: {} }).multi, false);
  assert.equal(orchestrate('debug ```foo and write bar``` and explain it', { label: 'code', scores: {} }).multi, false);
});

test('chat correctness: failed history persistence cannot restart an already-generated answer', async (t) => {
  const f = await fixture(t);
  f.store.pushHistory = () => { throw new Error('read-only fixture disk'); };
  const result = await chat(f.config, f.store, firstQ, silent, { skipBackgroundReflect: true });
  assert.ok(result?.text);
  assert.equal(f.seen.length, 1);
  assert.equal(f.store.data.history.length, 0);
});

test('answer continuity: deterministic answers record the same one-turn history as AI answers', async (t) => {
  const f = await fixture(t);
  const result = await f.agent.handle('/ask 14 * 17');
  assert.match(result, /238/);
  assert.equal(f.seen.length, 0);
  assert.equal(f.store.data.history.length, 2);
  assert.equal(f.store.data.profile.totalTurns, 1);
});

test('stack safety: a slash stack cannot cross a newly parked confirmation with /yes', async (t) => {
  cancelPending(); t.after(cancelPending);
  const f = await fixture(t);
  const result = await f.agent.handle('/rm /tmp/not-touched-by-stack\n/yes\n/note must-not-write');
  assert.match(result, /remaining stack commands were NOT started/);
  assert.equal(f.store.data.notes.length, 0);
  assert.ok(pendingState());
});

test('grounding cancellation: /stop aborts wiki preparation before a model or fallback call', async (t) => {
  const ready = deferred();
  const f = await fixture(t, async () => { ready.resolve(); return null; });
  f.config.wikiGrounding = true;
  f.config.wikiBaseUrl = f.config.openrouterBaseUrl.replace(/\/v1$/, '');
  const controller = new AbortController();
  // Separate GET-only fixture: the model fixture deliberately parses POST JSON.
  const wiki = http.createServer((_req, _res) => { ready.resolve(); });
  await new Promise((r) => wiki.listen(0, '127.0.0.1', r));
  t.after(() => { wiki.closeAllConnections(); wiki.close(); });
  f.config.wikiBaseUrl = `http://127.0.0.1:${wiki.address().port}`;
  const result = chat(f.config, f.store, 'explain the quantum zeno effect in detail', silent, { signal: controller.signal });
  await ready.promise; controller.abort();
  await assert.rejects(result, { code: 'ESTOPPED' });
  assert.equal(f.seen.length, 0);
  assert.equal(f.store.data.history.length, 0);
});

test('multitask e2e: answer snapshots after an action barrier see its committed owner state', async (t) => {
  const f = await fixture(t);
  const reply = await f.agent.handle(`/batch /todo prepare the telescope tonight || /ask ${firstQ}`);
  assert.match(reply, /2\/2 completed/);
  assert.match(f.seen[0].messages[0].content, /prepare the telescope tonight/);
});

test('multitask e2e: obvious cross-answer dependencies fail preflight instead of reading stale history', async (t) => {
  const f = await fixture(t);
  const reply = await f.agent.handle(`/batch /note must-not-write || /ask explain the previous answer`);
  assert.match(reply, /must be independent/);
  assert.equal(f.store.data.notes.length, 0);
  assert.equal(f.seen.length, 0);
});

test('dispatcher: explanation of newly generated code stays one coherent job', () => {
  const c = { label: 'code', confidence: 0.95, scores: {} };
  assert.equal(orchestrate('write a python queue and explain it', c).multi, false);
  assert.equal(orchestrate("debug 'foo and write bar' and explain the error", c).multi, false);
  assert.equal(orchestrate('debug `foo and write bar` and explain the error', c).multi, false);
});

test('multitask e2e: a known instant fact cannot consume the creative half of a compound request', async (t) => {
  const f = await fixture(t);
  const poem = 'write a poem about autumn';
  const reply = await f.agent.handle(`/ask what is the capital of india and ${poem}`);
  assert.match(reply, /New Delhi/);
  assert.match(reply, /poem about autumn/);
  assert.equal(f.seen.length, 1, 'fact remains local; only the creative part calls a provider');
  assert.equal(f.seen[0].messages.at(-1).content, poem);
  assert.equal(f.store.data.history.length, 2);
  assert.equal(f.store.data.profile.totalTurns, 1);
});

test('multitask e2e: completed work remains inspectable after /stop, never implicitly replayed', async (t) => {
  const ready = deferred();
  const f = await fixture(t, async (_body, n) => { if (n === 2) ready.resolve(); return null; });
  let actions = 0;
  f.agent.actions.execute = async () => { actions++; return { ok: true, text: 'Opened chrome (verified fixture)' }; };
  const pending = f.agent.handle(`/batch /open chrome || /ask ${firstQ} || /ask ${secondQ} || /note never-start`);
  await ready.promise;
  await f.agent.handle('/stop');
  assert.equal(await pending, null);
  const saved = await f.agent.handle('/batch results');
  assert.match(saved, /1\/4 completed/);
  assert.match(saved, /Opened chrome/);
  assert.match(saved, /4\. \/note \[skipped\]/);
  assert.equal(actions, 1);
  assert.equal(f.store.data.notes.length, 0);
});

test('multitask e2e: single batch workers still preserve every part of their own question', async (t) => {
  const f = await fixture(t);
  const question = 'what is the capital of india and write a poem about autumn';
  const reply = await f.agent.handle(`/batch /ask ${question} || /time`);
  assert.match(reply, /2\/2 completed/);
  assert.equal(f.seen.length, 1, 'do not return one instant fact and discard the rest');
  assert.equal(f.seen[0].messages.at(-1).content, question);
});
