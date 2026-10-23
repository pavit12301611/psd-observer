// Deterministic contracts and model-based testing: no desktop/network effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { FastCache, memoize } from '../src/fastcache.js';
import { normalizeNumber, jidToNumber, candidateNumbers, isOwner, maskNumber } from '../src/allowlist.js';
import { shorten, stableSignature, decodeToolArgs, validateToolArgs, fitAgentMessages } from '../src/agentprotocol.js';
import { parseBatch, runBatch, conversationSnapshot } from '../src/multitask.js';
import { createTaskRegistry, sleepWith, isStoppedError } from '../src/cancel.js';

const seed = 0x503d;

test('deep/cache: updating a full cache neither evicts a neighbour nor loses recency', () => {
  const cache = new FastCache({ max: 2, ttlMs: 0 });
  cache.set('a', 1); cache.set('b', 2); cache.set('b', 3);
  assert.equal(cache.get('a'), 1);
  cache.set('a', 4); cache.set('c', 5);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 4);
  const other = new FastCache({ max: 2, ttlMs: 0 });
  other.set('a', 1); other.set('b', 2); other.set('a', 3); other.set('c', 4);
  assert.equal(other.get('b'), undefined); assert.equal(other.get('a'), 3);
});

test('deep/cache: expires at the exact TTL boundary with an injectable clock', () => {
  let now = 0;
  const cache = new FastCache({ max: 2, ttlMs: 10, now: () => now });
  cache.set('a', 7);
  now = 9; assert.equal(cache.get('a'), 7);
  now = 10; assert.equal(cache.get('a'), undefined);
  assert.equal(cache.stats().misses, 1);
});

test('deep/cache: zero capacity disables retention; invalid bounds fail explicitly', () => {
  const cache = new FastCache({ max: 0 });
  assert.equal(cache.set('a', 1), 1);
  assert.equal(cache.get('a'), undefined);
  for (const max of [-1, NaN, Infinity, 1.5]) assert.throws(() => new FastCache({ max }), RangeError);
  for (const ttlMs of [-1, NaN, Infinity]) assert.throws(() => new FastCache({ ttlMs }), RangeError);
});

test('deep/cache: memoized keys preserve object/symbol identity and negative zero', () => {
  let calls = 0;
  const fn = memoize((x) => { calls++; return typeof x === 'object' ? x.value : x; });
  const a = { value: 'a' }, b = { value: 'b' };
  assert.equal(fn(a), 'a'); assert.equal(fn(b), 'b'); assert.equal(fn(a), 'a');
  const s1 = Symbol('same'), s2 = Symbol('same');
  assert.equal(fn(s1), s1); assert.equal(fn(s2), s2);
  assert.ok(Object.is(fn(-0), -0)); assert.ok(Object.is(fn(0), 0));
  assert.equal(calls, 6);
});

test('deep/cache: rejected async work is evicted, not cached as a permanent failure', async () => {
  let calls = 0;
  const cache = new FastCache();
  const fn = () => { calls++; return calls === 1 ? Promise.reject(new Error('temporary')) : Promise.resolve('recovered'); };
  await assert.rejects(cache.wrap('work', fn), /temporary/);
  assert.equal(await cache.wrap('work', fn), 'recovered');
  assert.equal(calls, 2);
});

test('deep/property: LRU matches an independent reference model (500 operation sequences)', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 8 }), fc.array(fc.record({
    op: fc.constantFrom('get', 'set'), key: fc.integer({ min: 0, max: 12 }), value: fc.integer(),
  }), { maxLength: 80 }), (max, ops) => {
    const actual = new FastCache({ max, ttlMs: 0 }), expected = new Map();
    for (const op of ops) {
      if (op.op === 'set') {
        expected.delete(op.key);
        if (max) expected.set(op.key, op.value);
        while (expected.size > max) expected.delete(expected.keys().next().value);
        actual.set(op.key, op.value);
      } else {
        const wanted = expected.get(op.key);
        if (expected.has(op.key)) { expected.delete(op.key); expected.set(op.key, wanted); }
        assert.equal(actual.get(op.key), wanted);
      }
      assert.equal(actual.stats().size, expected.size);
      assert.ok(actual.stats().size <= max);
    }
  }), { seed, numRuns: 500 });
});

test('deep/property: truncation obeys even tiny budgets and never mutates text (1000 cases)', () => {
  fc.assert(fc.property(fc.string({ maxLength: 1000 }), fc.integer({ min: 0, max: 1100 }), (text, max) => {
    const out = shorten(text, max);
    assert.equal(typeof out, 'string'); assert.ok(out.length <= max);
    if (text.length <= max) assert.equal(out, text);
  }), { seed, numRuns: 1000 });
});

test('deep/property: tool JSON decoding never silently repairs invalid JSON into executable arguments (1000 cases)', () => {
  fc.assert(fc.property(fc.jsonValue(), (value) => {
    const decoded = decodeToolArgs(JSON.stringify(value));
    const object = value !== null && typeof value === 'object' && !Array.isArray(value);
    assert.equal(!decoded.error, object);
    if (object) assert.deepEqual(decoded.args, JSON.parse(JSON.stringify(value)));
  }), { seed, numRuns: 1000 });
  for (const text of ['{', '{"path":', 'undefined', 'NaN']) assert.ok(decodeToolArgs(text).error);
});

test('deep/protocol: schema rejects inherited required fields, extras, NaN and excessive nesting', () => {
  const schema = { type: 'object', required: ['path'], additionalProperties: false, properties: { path: { type: 'string' } } };
  assert.match(validateToolArgs(Object.create({ path: '/tmp/inherited' }), schema), /required/);
  assert.match(validateToolArgs({ path: '/tmp/x', extra: true }, schema), /not allowed/);
  assert.match(validateToolArgs(NaN, { type: 'number' }), /must be number/);
  const value = {}; let node = value;
  for (let i = 0; i < 15; i++) { node.next = {}; node = node.next; }
  const shape = { type: 'object', properties: {} }; shape.properties.next = shape;
  assert.match(validateToolArgs(value, shape), /deeply/);
});

test('deep/protocol: signatures ignore property ordering, preserve array order and do not pollute prototypes', () => {
  assert.equal(stableSignature('tool', { b: 2, a: { y: 2, x: 1 } }), stableSignature('tool', { a: { x: 1, y: 2 }, b: 2 }));
  assert.notEqual(stableSignature('tool', [1, 2]), stableSignature('tool', [2, 1]));
  stableSignature('tool', JSON.parse('{"__proto__":{"deepPolluted":true}}'));
  assert.equal({}.deepPolluted, undefined);
});

test('deep/protocol: context fitting preserves safety, current task and tool-call pairing', () => {
  const messages = [{ role: 'system', content: 'SAFETY' }, { role: 'user', content: 'old' },
    { role: 'assistant', content: 'old reply' }, { role: 'user', content: 'CURRENT' },
    { role: 'assistant', content: 'x'.repeat(3000), tool_calls: [{ id: 'one', function: { name: 'read' } }] },
    { role: 'tool', tool_call_id: 'one', content: 'x'.repeat(6000) }];
  const before = structuredClone(messages);
  const fitted = fitAgentMessages(messages, [], { compact: true, historyCount: 2, maxChars: 2000 });
  assert.equal(fitted[0].content, 'SAFETY'); assert.equal(fitted[1].content, 'CURRENT');
  assert.equal(fitted[2].tool_calls[0].id, fitted[3].tool_call_id);
  assert.deepEqual(messages, before);
  assert.throws(() => fitAgentMessages([{ role: 'user', content: 'x'.repeat(2000) }], [], { maxChars: 100 }), /too large/i);
});

test('deep/property: owner equivalence is exact, never suffix/LID matching (1000 cases)', () => {
  fc.assert(fc.property(fc.integer({ min: 1000000000, max: 9999999999 }), (n) => {
    const owner = `91${n}`;
    assert.equal(normalizeNumber(`+91 ${n}`), owner);
    assert.equal(isOwner([`${n}`], owner), true);
    assert.equal(isOwner([`1${owner}`], owner), false);
    assert.equal(jidToNumber(`${owner}@lid`), '');
    assert.deepEqual(candidateNumbers({ remoteJid: `${owner}@lid`, participantAlt: `${owner}:4@s.whatsapp.net` }), [owner]);
    assert.ok(!maskNumber(owner).includes(owner));
  }), { seed, numRuns: 1000 });
});

test('deep/property: quoted batch separators remain literal and unknown commands never acquire an execution lane (500 cases)', () => {
  fc.assert(fc.property(fc.stringMatching(/^[a-z]{1,30}$/), (word) => {
    const parsed = parseBatch(`/ask "${word} || literal" || /time`);
    assert.equal(parsed.tasks.length, 2); assert.equal(parsed.tasks[0].kind, 'answer');
    assert.throws(() => parseBatch(`/unknown_${word} || /time`), /not batch-safe/);
  }), { seed, numRuns: 500 });
});

test('deep/property: scheduler bounds overlap, honors exclusive barriers and stops new starts on failure (300 schedules)', async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom('parallel', 'serial'), { minLength: 1, maxLength: 8 }),
    fc.integer({ min: 1, max: 4 }), fc.integer({ min: -1, max: 7 }), async (lanes, concurrency, fail) => {
      const active = new Set(), starts = []; let failed = false, peak = 0;
      const result = await runBatch(lanes.map((lane, index) => ({ lane, cmd: `task${index}` })), { concurrency,
        run: async (task, index) => {
          assert.equal(failed, false, 'no task starts after a failure has settled');
          if (task.lane === 'serial') assert.equal(active.size, 0);
          else assert.ok([...active].every((i) => lanes[i] === 'parallel'));
          starts.push(index); active.add(index); peak = Math.max(peak, active.size);
          await Promise.resolve(); await Promise.resolve();
          active.delete(index); if (index === fail) failed = true;
          return { ok: index !== fail, text: `done${index}` };
        } });
      assert.ok(peak <= concurrency); assert.equal(active.size, 0);
      assert.deepEqual(result.entries.map((e) => e.index), lanes.map((_, i) => i));
      for (const entry of result.entries) assert.equal(starts.includes(entry.index), entry.status !== 'skipped');
    }), { seed, numRuns: 300 });
});

test('deep/cancel: pre-abort performs no work, registry cleanup survives errors, public details never expose controllers', async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  const result = await runBatch([{ lane: 'parallel', cmd: 'ask' }], { signal: abort.signal, run: async () => { calls++; } });
  assert.equal(calls, 0); assert.equal(result.stopped, true);
  await assert.rejects(sleepWith(1, abort.signal), isStoppedError);
  let now = 10;
  const registry = createTaskRegistry({ now: () => now });
  const handle = registry.begin('answer'); now = 5;
  assert.equal(registry.active()[0].elapsedMs, 0);
  assert.equal(registry.active()[0].controller, undefined);
  assert.equal(registry.stop(999), null); assert.equal(registry.stop(handle.id).id, handle.id);
  handle.end(); handle.end(); assert.equal(registry.size, 0);
  await assert.rejects(registry.run('broken', async () => { throw new Error('expected'); }), /expected/);
  assert.equal(registry.size, 0);
});

test('deep/snapshot: detached stores retain structured data and cannot persist/history-write into the owner', () => {
  const source = { data: { facts: { name: 'owner' }, history: [{ content: 'one' }], bytes: new Uint8Array([1]) } };
  const copy = conversationSnapshot(source);
  copy.data.facts.name = 'other'; copy.data.history.push({ content: 'two' }); copy.data.bytes[0] = 7;
  copy.save(); copy.saveNow(); copy.pushHistory('user', 'three');
  assert.equal(source.data.facts.name, 'owner'); assert.equal(source.data.history.length, 1); assert.equal(source.data.bytes[0], 1);
});

test('deep/batch: command allowlist never assigns PC/write operations to a parallel lane', () => {
  for (const cmd of ['open', 'close', 'mkdir', 'note', 'todo', 'remind', 'remember', 'rm', 'kill']) {
    assert.equal(parseBatch(`/${cmd} fixture`).tasks[0].lane, 'serial', cmd);
  }
  for (const cmd of ['run', 'shell', 'yes', 'confirm', 'approve', 'go', 'batch', 'panic', 'trash', 'snapshot']) assert.throws(() => parseBatch(`/${cmd} fixture`), /not batch-safe/);
  assert.equal(parseBatch('/pc volume 20').tasks[0].lane, 'serial');
});
