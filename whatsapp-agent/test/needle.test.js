// Tests for the optional Needle second opinion in the router.
//
// Everything is offline and injectable: the classifier is a fake spawn, so no
// model, no Python, and no process is ever started. The point of these tests is
// the *contract* — that a missing, silent, slow, or unsure Needle changes
// nothing, and that a confident one can only ever make the plan cheaper in the
// safe direction.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  intentTools,
  parseNeedleResult,
  pickIntent,
  confident,
  createNeedle,
  nullNeedle,
} from '../src/needle.js';
import { createModelRouter } from '../src/router.js';

// ── pure helpers ─────────────────────────────────────────────────────────────

test('intent tools cover the four tiers plus the two flags', () => {
  const names = intentTools().map((t) => t.name);
  assert.deepEqual(names, [
    'tier_tiny', 'tier_light', 'tier_standard', 'tier_heavy',
    'web_task', 'needs_tools',
  ]);
});

test('pickIntent reduces calls and ignores unknown tiers', () => {
  const intent = pickIntent([
    { name: 'tier_light' },
    { name: 'web_task' },
    { name: 'needs_tools' },
    { name: 'tier_nonsense' },
  ], 0.81);
  assert.equal(intent.tier, 'light');
  assert.equal(intent.web, true);
  assert.equal(intent.tools, true);
  assert.equal(intent.confidence, 0.81);
});

test('pickIntent returns null when no tier was chosen', () => {
  assert.equal(pickIntent([{ name: 'web_task' }], 0.9), null);
  assert.equal(pickIntent([], 0.9), null);
  assert.equal(pickIntent(null, null), null);
});

test('parseNeedleResult survives every malformed shape', () => {
  assert.equal(parseNeedleResult(''), null);
  assert.equal(parseNeedleResult('not json'), null);
  assert.equal(parseNeedleResult('{"ok":false}'), null);
  assert.equal(parseNeedleResult('{"ok":true,"calls":[]}'), null);
  assert.equal(parseNeedleResult('{"ok":true,"calls":[{"name":"tier_tiny"}],"confidence":0.7}').tier, 'tiny');
});

test('confident gates on a missing or low score', () => {
  assert.equal(confident({ tier: 'tiny', confidence: 0.9 }), true);
  assert.equal(confident({ tier: 'tiny', confidence: 0.3 }), false);
  assert.equal(confident({ tier: 'tiny', confidence: null }), false);
  assert.equal(confident(null), false);
  // A non-positive gate means "accept anything with a tier".
  assert.equal(confident({ tier: 'tiny', confidence: 0.1 }, 0), true);
});

// ── the spawn bridge ─────────────────────────────────────────────────────────

/** A fake spawn that answers with `out` and records what it was given. */
function fakeSpawn(out, { code = 0, err = '', hang = false } = {}) {
  const seen = [];
  const spawnFn = (command, args, options) => {
    seen.push({ command, args, options });
    const handlers = {};
    const child = {
      stdout: { on: (event, fn) => { handlers[`out:${event}`] = fn; } },
      stderr: { on: (event, fn) => { handlers[`err:${event}`] = fn; } },
      stdin: { end: (body) => { seen[seen.length - 1].body = body; } },
      on: (event, fn) => { handlers[event] = fn; },
      kill: () => { child.killed = true; },
      killed: false,
    };
    setImmediate(() => {
      if (hang) return;
      if (out) handlers['out:data']?.(Buffer.from(out));
      if (err) handlers['err:data']?.(Buffer.from(err));
      handlers.close?.(code);
    });
    return child;
  };
  return { spawnFn, seen };
}

const goodJson = JSON.stringify({ ok: true, calls: [{ name: 'tier_tiny' }], confidence: 0.9 });

test('classify sends the text and tools on stdin and parses stdout', async () => {
  const fake = fakeSpawn(goodJson);
  const needle = createNeedle({ spawnFn: fake.spawnFn });
  const intent = await needle.intent('hello there');
  assert.equal(intent.tier, 'tiny');
  assert.equal(fake.seen[0].command, 'python3');
  const sent = JSON.parse(fake.seen[0].body);
  assert.equal(sent.text, 'hello there');
  assert.ok(sent.tools.some((t) => t.name === 'tier_heavy'));
});

test('a missing command latches and never throws', async () => {
  const spawnFn = () => { const e = new Error('spawn python3 ENOENT'); e.code = 'ENOENT'; throw e; };
  const needle = createNeedle({ spawnFn });
  assert.equal(await needle.intent('anything'), null);
  assert.equal(needle.missing, true);
  // Second call short-circuits rather than spawning again.
  assert.equal(await needle.intent('anything else'), null);
});

test('a hanging classifier times out and returns null', async () => {
  const fake = fakeSpawn(goodJson, { hang: true });
  const needle = createNeedle({ spawnFn: fake.spawnFn, timeoutMs: 20 });
  const started = Date.now();
  assert.equal(await needle.intent('hello'), null);
  assert.ok(Date.now() - started < 2000, 'should not wait for the default timeout');
});

test('a non-zero exit is treated as no answer', async () => {
  const fake = fakeSpawn(goodJson, { code: 1, err: 'model not found' });
  const needle = createNeedle({ spawnFn: fake.spawnFn, log: { warn() {} } });
  assert.equal(await needle.intent('hello'), null);
});

test('nullNeedle answers nothing', async () => {
  assert.equal(await nullNeedle().intent('hello'), null);
});

// ── router integration ───────────────────────────────────────────────────────

const routerConfig = {
  ollamaModel: 'llama3.2',
  aiProvider: 'auto',
};

test('without a needle the plan is exactly the keyword plan', () => {
  const router = createModelRouter({ config: routerConfig, needle: nullNeedle() });
  const plan = router.plan({ text: 'open chrome and then take a screenshot and send it to me' });
  assert.ok(plan.candidates.length >= 0);
  assert.ok(!plan.notes.some((n) => n.startsWith('needle:')));
  assert.equal(plan.needsTools, plan.complexity.needsTools);
});

test('an unsure needle changes nothing', () => {
  const router = createModelRouter({ config: routerConfig, needle: nullNeedle() });
  const withIntent = router.plan({ text: 'open chrome', needleIntent: { tier: 'tiny', web: false, tools: false, confidence: 0.2 } });
  const without = router.plan({ text: 'open chrome' });
  assert.equal(withIntent.rank, without.rank);
  assert.equal(withIntent.needsTools, without.needsTools);
  assert.ok(!withIntent.notes.some((n) => n.startsWith('needle:')));
});

test('a confident needle lowers the tier by one step and says so', () => {
  const router = createModelRouter({ config: routerConfig, needle: nullNeedle() });
  const base = router.plan({ text: 'compare the two designs and explain the trade-offs in detail' });
  assert.ok(base.rank >= 3, 'keyword classifier should call this hard');
  const lowered = router.plan({
    text: 'compare the two designs and explain the trade-offs in detail',
    needleIntent: { tier: 'light', web: false, tools: false, confidence: 0.85 },
  });
  assert.equal(lowered.rank, base.rank - 1);
  assert.ok(lowered.notes.some((n) => n.startsWith('needle:')));
});

test('a needle that agrees with the keywords changes nothing', () => {
  const router = createModelRouter({ config: routerConfig, needle: nullNeedle() });
  const base = router.plan({ text: 'compare the two designs and explain the trade-offs in detail' });
  const same = router.plan({
    text: 'compare the two designs and explain the trade-offs in detail',
    needleIntent: { tier: 'standard', web: false, tools: false, confidence: 0.85 },
  });
  assert.equal(same.rank, base.rank, 'agreeing is not a reason to move');
  assert.ok(!same.notes.some((n) => n.startsWith('needle:')));
});

test('a confident needle can only lower the tier, never raise it', () => {
  const router = createModelRouter({ config: routerConfig, needle: nullNeedle() });
  const base = router.plan({ text: 'hi' });
  const raised = router.plan({ text: 'hi', needleIntent: { tier: 'heavy', web: false, tools: false, confidence: 0.99 } });
  assert.equal(raised.rank, base.rank, 'a model must not be able to inflate the tier');
});

test('a needle that spots a command adds the tools requirement', () => {
  const router = createModelRouter({ config: routerConfig, needle: nullNeedle() });
  // "mera bill bhej do" carries no verb from the keyword list, so the keyword
  // classifier will not ask for tools. Needle still can.
  const plan = router.plan({ text: 'mera bill bhej do', needleIntent: { tier: 'light', web: false, tools: true, confidence: 0.8 } });
  assert.equal(plan.needsTools, true);
  assert.ok(plan.notes.some((n) => n.includes('needs tools')));
});

test('needsTools:false is respected even when needle insists', () => {
  const router = createModelRouter({ config: routerConfig, needle: nullNeedle() });
  const plan = router.plan({ text: 'mera bill bhej do', needsTools: false, needleIntent: { tier: 'light', web: false, tools: true, confidence: 0.8 } });
  assert.equal(plan.needsTools, false, 'an explicit caller choice outranks the second opinion');
});

test('planAsync resolves the needle and is a no-op when disabled', async () => {
  const disabled = createModelRouter({ config: { ...routerConfig, needleEnabled: false }, needle: nullNeedle() });
  const a = await disabled.planAsync({ text: 'open chrome' });
  const b = disabled.plan({ text: 'open chrome' });
  assert.equal(a.rank, b.rank);

  const fake = fakeSpawn(goodJson);
  const enabled = createModelRouter({
    config: { ...routerConfig, needleEnabled: true },
    needle: createNeedle({ spawnFn: fake.spawnFn }),
  });
  const plan = await enabled.planAsync({ text: 'open chrome and take a screenshot' });
  assert.equal(fake.seen.length, 1, 'needle should have been asked');
  assert.ok(plan.rank >= 1 && plan.rank <= 4);
});

test('planAsync survives a classifier that throws', async () => {
  const exploding = { intent: async () => { throw new Error('boom'); }, classify: async () => null };
  const router = createModelRouter({ config: { ...routerConfig, needleEnabled: true }, needle: exploding, log: { warn() {} } });
  const plan = await router.planAsync({ text: 'open chrome' });
  assert.ok(plan.rank >= 1);
});
