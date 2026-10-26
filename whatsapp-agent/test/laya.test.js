// Tests for the optional Laya decision rung.
//
// Everything is offline and injectable: the HTTP client is a fake, so no
// laya-serve, no weights, and no network. The point of these tests is the
// contract — that a missing, down, slow, or unsure Laya leaves the existing
// "all brains offline" reply exactly as it was, and that a confident decision
// can only ever run a command from a fixed read-only allowlist.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  stuckQuestions,
  buildDecisionRequest,
  parseLayaResult,
  decided,
  createLaya,
  nullLaya,
  layaFor,
} from '../src/laya.js';
import { completeWithFallback, fallbackReply, askLaya } from '../src/brainfallback.js';

// ── pure helpers ─────────────────────────────────────────────────────────────

test('the question set is the documented contract', () => {
  const ids = stuckQuestions().map((q) => q.id);
  assert.deepEqual(ids, ['kind', 'command', 'act', 'urgency']);
  // Every question names a primitive Laya actually answers.
  for (const q of stuckQuestions()) {
    assert.ok(['choice', 'score', 'noul'].includes(q.kind), `${q.id} has kind ${q.kind}`);
    if (q.kind !== 'noul') assert.ok(Array.isArray(q.options), `${q.id} needs options`);
  }
});

test('buildDecisionRequest fills the dynamic option space and drops noul options', () => {
  const body = buildDecisionRequest('screenshot bhej do', stuckQuestions(), ['screenshot', 'status']);
  assert.equal(body.state, 'screenshot bhej do');
  const byId = Object.fromEntries(body.questions.map((q) => [q.id, q]));
  assert.deepEqual(byId.command.options, ['screenshot', 'status']);
  assert.equal(byId.kind.options.length, 3);
  assert.equal(byId.act.options, undefined, 'a yes/no question takes no options');
});

test('buildDecisionRequest survives a junk question list', () => {
  const body = buildDecisionRequest('hi', [{ id: 'x', kind: 'nonsense', question: 'q' }], []);
  assert.equal(body.questions[0].kind, 'choice', 'an unknown kind falls back to choice');
});

test('parseLayaResult normalises every accepted envelope shape', () => {
  const direct = parseLayaResult({ answers: [{ id: 'kind', answer: 'command', probability: 0.9 }] });
  assert.equal(direct.kind.answer, 'command');
  assert.equal(direct.kind.probability, 0.9);
  // The server may name the field differently; all are accepted.
  for (const key of ['results', 'questions']) {
    const alt = parseLayaResult({ [key]: [{ id: 'kind', answer: 'command', confidence: 0.9 }] });
    assert.equal(alt.kind.answer, 'command');
  }
  // A JSON string is accepted too, because that is what fetch hands back.
  const asText = parseLayaResult(JSON.stringify({ answers: [{ id: 'kind', answer: 'x', p: 0.5 }] }));
  assert.equal(asText.kind.probability, 0.5);
});

test('parseLayaResult rejects junk rather than guessing', () => {
  assert.equal(parseLayaResult(''), null);
  assert.equal(parseLayaResult('not json'), null);
  assert.equal(parseLayaResult('{}'), null);
  assert.equal(parseLayaResult({ answers: [] }), null);
  assert.equal(parseLayaResult({ answers: 'nope' }), null);
  assert.equal(parseLayaResult(null), null);
});

test('decided gates on a missing answer or a low probability', () => {
  assert.equal(decided({ answer: 'command', probability: 0.9 }), true);
  assert.equal(decided({ answer: 'command', probability: 0.2 }), false);
  assert.equal(decided({ answer: null, probability: 0.9 }), false);
  assert.equal(decided(null), false);
  assert.equal(decided({ answer: 'command', probability: null }), false);
});

// ── the HTTP client ──────────────────────────────────────────────────────────

const answers = (over = {}) => JSON.stringify({
  answers: [
    { id: 'kind', answer: 'command', probability: 0.93, ...(over.kind ?? {}) },
    { id: 'command', answer: 'screenshot', probability: 0.88 },
    { id: 'act', answer: true, probability: 0.81 },
    { id: 'urgency', answer: 'now', probability: 0.7 },
  ],
});

/** A fake POST that records what it was given. */
function fakePost(body, { ok = true, throws = null } = {}) {
  const seen = [];
  const post = async (url, payload, headers, ms) => {
    seen.push({ url, payload, headers, ms });
    if (throws) throw throws;
    if (!ok) throw new Error('laya 503: down');
    return typeof body === 'function' ? body(payload) : body;
  };
  return { post, seen };
}

test('decide posts to the Jev-compatible endpoint and parses the answer', async () => {
  const fake = fakePost(answers());
  const laya = createLaya({ postFn: fake.post, baseUrl: 'http://127.0.0.1:9999' });
  const result = await laya.decide('screenshot bhej do');
  assert.equal(result.kind.answer, 'command');
  assert.equal(fake.seen[0].url, 'http://127.0.0.1:9999/v1/systemone');
  assert.equal(fake.seen[0].payload.state, 'screenshot bhej do');
});

test('a refused connection latches so a down server costs one request', async () => {
  const fake = fakePost(answers(), { throws: new Error('fetch failed') });
  const laya = createLaya({ postFn: fake.post, log: { warn() {} } });
  assert.equal(await laya.decide('one'), null);
  assert.equal(laya.down, true);
  assert.equal(await laya.decide('two'), null);
  assert.equal(fake.seen.length, 1, 'the second call must not retry');
});

test('a timeout does not latch, because the server may come back', async () => {
  const fake = fakePost(answers(), { throws: new Error('The operation was aborted due to timeout') });
  const laya = createLaya({ postFn: fake.post, log: { warn() {} } });
  assert.equal(await laya.decide('one'), null);
  assert.equal(laya.down, false);
});

test('confidentDecide returns only the answers that clear the gate', async () => {
  const fake = fakePost(JSON.stringify({
    answers: [
      { id: 'kind', answer: 'command', probability: 0.93 },
      { id: 'command', answer: 'screenshot', probability: 0.31 },
    ],
  }));
  const laya = createLaya({ postFn: fake.post, minProbability: 0.7 });
  const result = await laya.confidentDecide('screenshot lo');
  assert.equal(result.kind.answer, 'command');
  assert.equal(result.command, undefined, 'an unsure command must not be offered');
});

test('layaFor returns a do-nothing client when disabled', async () => {
  const off = layaFor({ layaEnabled: false });
  assert.equal(await off.confidentDecide('anything'), null);
  assert.equal(off.down, true);
});

// ── the fallback rung ────────────────────────────────────────────────────────

test('a brain that answers never reaches the decision rung', async () => {
  let asked = 0;
  const result = await completeWithFallback('hi', {
    attempts: [async () => 'a real answer'],
    laya: { confidentDecide: async () => { asked++; return { kind: { answer: 'command' } }; } },
    onDecision: async () => 'should never run',
  });
  assert.equal(result.text, 'a real answer');
  assert.equal(result.source, 'brain0', 'an anonymous attempt keeps its indexed name');
  assert.equal(asked, 0);
});

test('with no brains, a confident decision can act and beats the template', async () => {
  const laya = { confidentDecide: async () => ({ kind: { answer: 'command' }, command: { answer: 'screenshot' } }) };
  const result = await completeWithFallback('screenshot bhej do', {
    attempts: [async () => { throw new Error('all brains down'); }],
    laya,
    onDecision: async () => '📸 Here is your screenshot.',
  });
  assert.equal(result.text, '📸 Here is your screenshot.');
  assert.equal(result.source, 'laya-decision');
  assert.equal(result.decision.kind.answer, 'command');
});

test('an unsure decision leaves the dead end exactly as it was', async () => {
  const laya = { confidentDecide: async () => null };
  const result = await completeWithFallback('explain quantum physics', {
    attempts: [async () => { throw new Error('all brains down'); }],
    laya,
    onDecision: async () => 'should never run',
  });
  assert.equal(result.text, null);
  assert.equal(result.source, 'none');
});

test('a decision handler that throws cannot break the reply', async () => {
  const laya = { confidentDecide: async () => ({ kind: { answer: 'command' } }) };
  const result = await completeWithFallback('x', {
    attempts: [async () => { throw new Error('down'); }],
    laya,
    onDecision: async () => { throw new Error('handler exploded'); },
  });
  assert.equal(result.text, null);
  assert.ok(result.errors.some((e) => e.startsWith('laya-decision:')));
});

test('a handler returning something empty is ignored', async () => {
  const laya = { confidentDecide: async () => ({ kind: { answer: 'command' } }) };
  const result = await completeWithFallback('x', {
    attempts: [async () => { throw new Error('down'); }],
    laya,
    onDecision: async () => '   ',
  });
  assert.equal(result.text, null);
});

test('with no laya at all the ladder behaves exactly as before', async () => {
  const result = await completeWithFallback('x', {
    attempts: [async () => { throw new Error('down'); }],
    onDecision: async () => 'never',
  });
  assert.equal(result.text, null);
  assert.equal(result.source, 'none');
  // No client means the rung was skipped, not merely unhelpful.
  assert.equal(result.decision, null);
});

test('askLaya is a no-op without a usable client', async () => {
  assert.equal(await askLaya('x', {}), null);
  assert.equal(await askLaya('x', { laya: nullLaya() }), null);
  assert.equal(await askLaya('x', { laya: { confidentDecide: async () => { throw new Error('boom'); } } }), null);
});

test('askLaya passes the command options through', async () => {
  const seen = [];
  const laya = {
    confidentDecide: async (state, questions, commandOptions, min) => {
      seen.push({ state, commandOptions, min });
      return null;
    },
  };
  await askLaya('screenshot lo', { laya, commandOptions: ['screenshot', 'status'], minProbability: 0.8 });
  assert.deepEqual(seen[0].commandOptions, ['screenshot', 'status']);
  assert.equal(seen[0].min, 0.8);
});

test('the honest template is unchanged', () => {
  assert.match(fallbackReply('question'), /brain offline/i);
  assert.match(fallbackReply('nonsense'), /brains busy/i);
});
