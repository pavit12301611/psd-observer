// Regression tests for heavy-task routing. No cloud keys, desktop or external
// network: providers are local HTTP fixtures, actions are explicit stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentLoop } from '../src/agentloop.js';
import { createActions } from '../src/actions.js';
import { createAgent } from '../src/commands.js';
import { Store } from '../src/store.js';
import { loadConfig } from '../src/config.js';
import { buildCatalog, createModelRouter, looksLikeWebTask } from '../src/router.js';
import { BrainError, brainFailure, postBrainJson, safeBrainText } from '../src/brainrequest.js';
import { compactSchema, fitAgentMessages, stableSignature } from '../src/agentprotocol.js';
import { complete } from '../src/ai.js';

const silent = { info() {}, warn() {}, error() {} };
const memory = () => {
  const store = new Store();
  store.save = () => {};
  store.saveNow = () => {};
  return store;
};
const cfg = (overrides = {}) => ({
  aiProvider: 'openrouter', openrouterApiKey: 'fixture-secret-key', openrouterModel: 'test/code-70b:free', openrouterModelFallbacks: [],
  ownerNumber: '1', agentNumber: '2', timezone: 'Asia/Kolkata', accessLevel: 'full',
  agentTools: true, maxAgentSteps: 6, agentToolLimit: 20, aiTimeoutMs: 2000, ...overrides,
});
const schema = (name, properties = { path: { type: 'string' } }, required = Object.keys(properties)) => ({
  name, description: `${name} on the PC`, parameters: { type: 'object', properties, required, additionalProperties: false },
});
const write = schema('write_file', { path: { type: 'string' }, content: { type: 'string' } });
const read = schema('read_file');
const call = (name, args, id = name) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const answer = (content) => ({ choices: [{ message: { role: 'assistant', content } }] });
const calls = (...tool_calls) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls } }] });
const asText = (reply) => typeof reply === 'string' ? reply : reply?.text || '';

async function provider(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || '{}');
      seen.push({ body, url: req.url, headers: req.headers });
      const result = await handler(body, seen.length, seen);
      if (result?.hang) return;
      res.writeHead(result?.status || 200, { 'content-type': 'application/json', ...result?.headers });
      res.end(JSON.stringify(result?.data ?? result));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, url: `${base}/v1`, seen };
}
function loop(config, execute = async () => ({ ok: true, text: 'verified' }), schemas = [write, read], store = memory()) {
  return createAgentLoop({ config, store, log: silent, actions: { level: () => 'full', toolSchemas: () => schemas, execute } });
}

test('transport: HTTP 200 error envelopes retain HTTP-like code and Retry-After', async (t) => {
  const p = await provider(t, () => ({ headers: { 'retry-after': '300' }, data: { error: { code: 429, message: 'free tier quota exceeded' } } }));
  await assert.rejects(postBrainJson(p.url, {}), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 300_000);
    assert.equal(brainFailure(err).kind, 'rate_limit');
    return true;
  });
});

test('transport: a timeout still works when a caller signal is supplied', async (t) => {
  const p = await provider(t, () => ({ hang: true }));
  const controller = new AbortController();
  await assert.rejects(postBrainJson(p.url, {}, {}, 35, controller.signal), (err) => {
    assert.equal(brainFailure(err).kind, 'timeout');
    return true;
  });
  assert.equal(controller.signal.aborted, false);
});

test('transport: caller cancellation aborts an in-flight request immediately', async (t) => {
  let arrived;
  const ready = new Promise((resolve) => { arrived = resolve; });
  const p = await provider(t, () => { arrived(); return { hang: true }; });
  const controller = new AbortController();
  const request = postBrainJson(p.url, {}, {}, 5000, controller.signal);
  await ready;
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
});

test('failures: auth, model, tool, network, context and quota errors are distinguishable', () => {
  for (const [message, status, kind] of [
    ['bad credentials', 401, 'auth'], ['model not found', 404, 'model'],
    ['tool_use_failed', 400, 'tools'], ['fetch failed: ECONNREFUSED', 0, 'network'],
    ['context_length_exceeded', 400, 'context'], ['rate limit', 429, 'rate_limit'],
  ]) assert.equal(brainFailure(new BrainError(message, { status })).kind, kind);
  const secret = 'fixture-private-api-key';
  const text = safeBrainText(`key=${secret} Bearer ${secret} https://example.test/?key=${secret}`, { groqApiKey: secret });
  assert.doesNotMatch(text, new RegExp(secret));
});

test('router: failed heavy requests do not spend the entire power budget', () => {
  const router = createModelRouter({ config: cfg({ maxHeavyPerHour: 1 }), log: silent });
  const plan = router.plan({ text: 'write a python script then save the full report', needsTools: true });
  const model = plan.candidates[0];
  router.record(model.id, { ok: false, tier: 4, error: new BrainError('quota', { status: 429, retryAfterMs: 300_000 }) });
  assert.equal(router.budget().heavyUsed, 0);
  assert.ok(router.snapshot().catalog.find((entry) => entry.id === model.id).health.cooldownUntil - Date.now() > 290_000);
  assert.match(router.statusText(), /rate_limit:.*429|rate_limit: quota/);
  assert.match(router.statusText(), /Free-tier quota/);
});

test('router: budget downgrade avoids big models but keeps the heavy step/tool budget', () => {
  const router = createModelRouter({ config: cfg({ aiProvider: 'groq', groqApiKey: 'fixture-key', maxHeavyPerHour: 1 }), log: silent });
  const job = { text: 'write a complete python script then save a detailed report', needsTools: true };
  const before = router.plan(job);
  router.record(before.candidates[0].id, { ok: true, tier: 4 });
  const after = router.plan(job);
  assert.equal(after.budgetHit, true);
  assert.equal(after.requestedTier, 'heavy');
  assert.equal(after.maxSteps, before.maxSteps);
  assert.equal(after.toolLimit, before.toolLimit);
  assert.ok(after.candidates.length > 0);
  assert.ok(after.candidates.every((model) => model.quality < 8 && model.minTier < 4));
});

test('router: heavy fallbacks rank capable standard models ahead of a weak local model', () => {
  const router = createModelRouter({ config: cfg({ aiProvider: 'auto', groqApiKey: 'fixture-key', geminiApiKey: 'fixture-key' }), log: silent });
  const plan = router.plan({ text: 'write a complete python script then debug and save the report', needsTools: true });
  assert.equal(plan.tier, 'heavy');
  assert.equal(plan.candidates[0].model, 'openai/gpt-oss-120b');
  const weak = plan.candidates.findIndex((model) => model.provider === 'ollama');
  assert.ok(plan.candidates.findIndex((model) => model.provider === 'gemini') < weak);
});

test('router: all-cooling and provider-filter explanations do not promise an unperformed retry', () => {
  const router = createModelRouter({ config: cfg(), log: silent });
  router.record(router.plan({ text: 'hi' }).candidates[0].id, { ok: false, error: 'fetch failed' });
  const plan = router.plan({ text: 'hi' });
  assert.equal(plan.candidates.length, 0);
  assert.match(plan.notes.join(' '), /retry after/);
  assert.doesNotMatch(plan.notes.join(' '), /retrying once/);
  const off = createModelRouter({ config: { aiProvider: 'groq' }, log: silent });
  assert.match(off.plan({ text: 'hi' }).notes.join(' '), /AI_PROVIDER/);
});

test('catalog: configured fallback IDs are deduplicated without losing capabilities', () => {
  const catalog = buildCatalog(cfg({ groqApiKey: 'fixture-key', groqModel: 'same-120b', groqModelSmall: 'same-120b', openrouterModelFallbacks: ['test/code-70b:free', 'test/backup-30b:free', 'test/backup-30b:free'] }));
  assert.equal(catalog.filter((model) => model.model === 'test/backup-30b:free').length, 1);
  const merged = catalog.find((model) => model.provider === 'groq' && model.model === 'same-120b');
  assert.equal(merged.maxTier, 4);
  assert.equal(merged.quality, 9);
  assert.equal(merged.minTier, 1);
});

test('routing: code/research mentioning GitHub does not become blind browser automation', () => {
  assert.equal(looksLikeWebTask('check github then review and fix the code in the repository'), false);
  assert.equal(looksLikeWebTask('research a website then save the report'), false);
  assert.equal(looksLikeWebTask('chrome kholo aur github pe observer search karo'), true);
  assert.equal(looksLikeWebTask('chatgpt pe rust vs go pooch'), true);
});

test('configuration: new fallback and request budgets load from env', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-brain-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ env: { DATA_DIR: dir, GROQ_MODEL_FALLBACKS: 'a,b, a ', OPENROUTER_MODEL_FALLBACKS: 'x:free, y:free', AGENT_MAX_TRIES: '9', AGENT_MAX_TOKENS: '3072', AGENT_PROMPT_MAX_CHARS: '20000' } });
  assert.deepEqual(config.groqModelFallbacks, ['a', 'b', 'a']);
  assert.deepEqual(config.openrouterModelFallbacks, ['x:free', 'y:free']);
  assert.equal(config.agentMaxTries, 9);
  assert.equal(config.agentMaxTokens, 3072);
  assert.equal(config.agentPromptMaxChars, 20_000);
});

test('agent: a fifth healthy fallback is reached instead of stopping after three failures', async (t) => {
  let target;
  const p = await provider(t, (body) => body.model !== target ? { status: 404, data: { error: { message: 'model unavailable' } } }
    : body.messages.some((message) => message.role === 'tool') ? answer('File verified.') : calls(call('write_file', { path: '~/result.txt', content: 'result' })));
  const config = cfg({ openrouterBaseUrl: p.url, openrouterModelFallbacks: ['test/120b:free', 'test/80b:free', 'test/30b:free', 'test/20b:free'] });
  const agent = loop(config);
  const order = agent.buildPlan('write a complete python script then save it', { forceTier: 'heavy' }).candidates;
  assert.equal(order.length, 5);
  target = order[4].model;
  assert.equal(await agent.run('write a complete python script then save it', {}, { forceTier: 'heavy' }), 'File verified.');
  assert.equal(agent.lastRun.attempts.length, 5);
  assert.deepEqual(agent.lastRun.attempts.map((attempt) => attempt.modelId), order.map((model) => model.id));
});

test('agent: invalid shared credentials skip siblings without consuming fallback slots', async (t) => {
  const dead = await provider(t, () => ({ status: 401, data: { error: { message: 'Invalid API key' } } }));
  const alive = await provider(t, () => answer('Backup answered.'));
  const agent = loop(cfg({ aiProvider: 'auto', routerPrefer: 'cloud', groqApiKey: 'fixture-key', groqBaseUrl: dead.url, openrouterBaseUrl: alive.url, ollamaUrl: dead.base }));
  assert.equal(await agent.run('hello', {}, { maxTries: 2 }), 'Backup answered.');
  assert.equal(dead.seen.length, 1, 'only one request with the invalid key');
  assert.equal(agent.lastRun.attempts.length, 2);
  assert.ok(agent.router.plan({ text: 'hello' }).candidates.every((model) => model.provider !== 'groq'));
});

test('agent: one compact retry repairs oversized requests without dropping the current task', async (t) => {
  const task = 'write a complete python script then save the detailed results to ~/result.txt';
  const p = await provider(t, (body, n) => n === 1 ? { status: 413, data: { error: { code: 'context_length_exceeded', message: 'Request too large' } } }
    : body.messages.some((message) => message.role === 'tool') ? answer('File verified.') : calls(call('write_file', { path: '~/result.txt', content: 'result' })));
  const store = memory();
  store.data.history = Array.from({ length: 4 }, (_v, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `old-chat-${i}` }));
  const agent = loop(cfg({ openrouterBaseUrl: p.url }), undefined, [write, read], store);
  assert.equal(await agent.run(task, {}, { forceTier: 'heavy' }), 'File verified.');
  assert.equal(p.seen.length, 3);
  const [first, retry] = p.seen.map((request) => request.body);
  assert.ok(JSON.stringify(retry).length < JSON.stringify(first).length);
  assert.equal(retry.max_tokens, 1024);
  assert.ok(retry.messages.some((message) => message.content === task));
  assert.ok(!retry.messages.some((message) => /old-chat/.test(message.content)));
  assert.equal(first.provider.require_parameters, true, 'only tool-capable OpenRouter endpoints');
  assert.equal(agent.lastRun.compactRetries, 1);
  assert.equal(agent.router.isCooling(agent.router.catalog.find((model) => model.provider === 'openrouter')), false);
});

test('agent: rate limits are not immediately retried; a usable fallback is selected', async (t) => {
  const p = await provider(t, (body) => body.model.includes('70b') ? { status: 429, headers: { 'retry-after': '240' }, data: { error: { message: 'quota exhausted' } } } : answer('Fallback result.'));
  const agent = loop(cfg({ openrouterBaseUrl: p.url, openrouterModelFallbacks: ['test/30b:free'] }));
  assert.equal(await agent.run('hello', {}, { forceTier: 'heavy' }), 'Fallback result.');
  assert.equal(p.seen.length, 2);
  assert.equal(agent.lastRun.attempts[0].error.kind, 'rate_limit');
  assert.equal(agent.lastRun.attempts[0].error.retryAfterMs, 240_000);
});

test('agent: Groq output reservation is explicit, not the model maximum', async (t) => {
  const p = await provider(t, () => answer('hello'));
  const agent = loop(cfg({ aiProvider: 'groq', groqApiKey: 'fixture-key', groqBaseUrl: p.url, agentMaxTokens: 1536 }));
  await agent.run('hello');
  assert.equal(p.seen[0].body.max_completion_tokens, 1536);
  assert.equal(p.seen[0].body.max_tokens, undefined);
});

test('agent: Ollama receives native function wrappers and object arguments', async (t) => {
  const p = await provider(t, (body) => ({ data: { message: body.messages.some((message) => message.role === 'tool')
    ? { content: 'File verified.' } : { content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: '~/result.txt', content: 'x' } } }] } } }));
  const agent = loop(cfg({ aiProvider: 'ollama', ollamaUrl: p.base }));
  assert.equal(await agent.run('write a file'), 'File verified.');
  assert.equal(p.seen[0].body.tools[0].type, 'function');
  assert.ok(p.seen[0].body.tools[0].function.parameters);
  assert.equal(typeof p.seen[1].body.messages.find((message) => message.tool_calls).tool_calls[0].function.arguments, 'object');
  assert.equal(p.seen[1].body.messages.find((message) => message.role === 'tool').tool_name, 'write_file');
});

test('agent: Gemini groups function responses and preserves thought signatures', async (t) => {
  const p = await provider(t, (body, n) => ({ data: { candidates: [{ content: { role: 'model', parts: n === 1
    ? [{ thoughtSignature: 'fixture-signature', functionCall: { name: 'write_file', args: { path: '~/result.txt', content: 'x' } } }, { functionCall: { name: 'read_file', args: { path: '~/result.txt' } } }]
    : [{ text: 'File verified.' }] } }] } }));
  const agent = loop(cfg({ aiProvider: 'gemini', geminiApiKey: 'fixture-key', geminiBaseUrl: p.url }));
  assert.equal(await agent.run('write a file then read it', {}, { forceTier: 'heavy' }), 'File verified.');
  const contents = p.seen[1].body.contents;
  assert.equal(contents[1].parts[0].thoughtSignature, 'fixture-signature');
  assert.equal(contents[2].parts.length, 2);
  assert.ok(contents[2].parts.every((part) => part.functionResponse));
});

test('agent: batch actions execute in dependency order, not Promise.all races', async (t) => {
  const p = await provider(t, (_body, n) => n === 1 ? calls(call('write_file', { path: '~/r.txt', content: 'x' }), call('read_file', { path: '~/r.txt' })) : answer('Verified both steps.'));
  const trace = [];
  let written = false;
  const agent = loop(cfg({ openrouterBaseUrl: p.url }), async (name) => {
    if (name === 'write_file') { await delay(15); written = true; }
    else assert.equal(written, true, 'read must wait for write');
    trace.push(name);
    return { ok: true, text: name === 'read_file' ? 'x' : 'written' };
  });
  assert.equal(await agent.run('write a file then read it'), 'Verified both steps.');
  assert.deepEqual(trace, ['write_file', 'read_file']);
});

test('agent: confirmation stops a batch before later side effects run', async (t) => {
  const p = await provider(t, () => calls(call('delete_path', { path: '~/old.txt' }), call('write_file', { path: '~/new.txt', content: 'x' })));
  const executed = [];
  const agent = loop(cfg({ openrouterBaseUrl: p.url }), async (name) => {
    executed.push(name);
    return { ok: false, needsConfirmation: true, text: 'Confirm deletion — not done yet.' };
  }, [schema('delete_path'), write]);
  assert.match(asText(await agent.run('delete the file then write a new file')), /Confirm deletion/);
  assert.deepEqual(executed, ['delete_path']);
  assert.equal(agent.lastRun.needsConfirmation, true);
  assert.equal(agent.lastRun.failedCalls, 0);
  assert.equal(p.seen.length, 1);
});

test('agent: failover resumes verified work, retains media, and does not replay writes', async (t) => {
  const first = await provider(t, (_body, n) => n === 1 ? calls(call('write_file', { path: '~/r.txt', content: 'x' })) : { status: 503, data: { error: { message: 'provider down' } } });
  const second = await provider(t, (_body, n) => n === 1 ? calls(call('write_file', { content: 'x', path: '~/r.txt' }), call('read_file', { path: '~/r.txt' })) : answer('File verified.'));
  const executed = [];
  const document = { buffer: Buffer.from('x'), fileName: 'r.txt', mimetype: 'text/plain' };
  const agent = loop(cfg({ aiProvider: 'auto', groqApiKey: 'fixture-key', groqBaseUrl: first.url, openrouterBaseUrl: second.url, ollamaUrl: first.base }), async (name) => {
    executed.push(name);
    return { ok: true, text: name === 'read_file' ? 'x' : 'written', ...(name === 'write_file' ? { document } : {}) };
  });
  const result = await agent.run('write a complete python script then read the file', {}, { forceTier: 'heavy' });
  assert.equal(result.text, 'File verified.');
  assert.deepEqual(result.document, document);
  assert.deepEqual(executed, ['write_file', 'read_file']);
  assert.match(JSON.stringify(second.seen[0].body.messages), /ALREADY attempted/);
  assert.equal(agent.lastRun.attempts.length, 2);
  assert.equal(agent.lastRun.toolCalls, 2);
  assert.equal(agent.lastRun.successfulCalls, 2);
});

for (const [name, bad] of [
  ['malformed JSON', call('write_file', '{broken')],
  ['array arguments', call('write_file', '[]')],
  ['missing required arguments', call('write_file', { path: '~/r.txt' })],
  ['wrong argument type', call('write_file', { path: '~/r.txt', content: 42 })],
  ['unoffered tool', call('run_shell', { command: 'echo forbidden' })],
]) test(`agent: ${name} is returned for repair without executing defaults`, async (t) => {
  const p = await provider(t, (_body, n) => n === 1 ? calls(bad) : n === 2 ? calls(call('write_file', { path: '~/r.txt', content: 'x' })) : answer('File verified.'));
  const executed = [];
  const agent = loop(cfg({ openrouterBaseUrl: p.url }), async (name, args) => { executed.push({ name, args }); return { ok: true, text: 'written' }; }, [write]);
  assert.equal(await agent.run('write the file', {}, { forceTier: 'heavy' }), 'File verified.');
  assert.deepEqual(executed, [{ name: 'write_file', args: { path: '~/r.txt', content: 'x' } }]);
  assert.match(p.seen[1].body.messages.at(-1).content, /ERROR/);
});

test('agent: /stop signal reaches actions and prevents the next call in a batch', async (t) => {
  const p = await provider(t, () => calls(call('write_file', { path: '~/r.txt', content: 'x' }), call('read_file', { path: '~/r.txt' })));
  const controller = new AbortController();
  const executed = [];
  const agent = loop(cfg({ openrouterBaseUrl: p.url }), async (name, _args, ctx) => {
    assert.equal(ctx.signal, controller.signal);
    executed.push(name);
    controller.abort();
    return { ok: true, text: 'written' };
  });
  await assert.rejects(agent.run('write a file then read it', { signal: controller.signal }), (err) => err.code === 'ESTOPPED');
  assert.deepEqual(executed, ['write_file']);
  assert.equal(agent.lastRun.stopped, true);
  assert.equal(agent.lastRun.toolCalls, 1);
  assert.equal(p.seen.length, 1);
});

test('agent: a step limit returns verified partial progress and media, never fake Done', async (t) => {
  const p = await provider(t, () => calls(call('write_file', { path: '~/r.txt', content: 'x' })));
  const audio = Buffer.from('audio');
  const agent = loop(cfg({ openrouterBaseUrl: p.url }), async () => ({ ok: true, text: 'written', audio, mimetype: 'audio/ogg', ptt: true }));
  const result = await agent.run('write a file', {}, { maxSteps: 1, nudge: false });
  assert.match(result.text, /adhoora|Step limit/);
  assert.doesNotMatch(result.text, /✅|Steps complete|✅ Done/);
  assert.equal(result.audio, audio);
  assert.equal(agent.lastRun.ok, false);
  assert.equal(agent.lastRun.partial, true);
  assert.equal(agent.lastRun.successfulCalls, 1);
  assert.equal(agent.router.snapshot().catalog.find((model) => model.provider === 'openrouter').health.lastOk, true, 'step exhaustion does not falsely mark a healthy provider as down');
});

test('agent: provider failure after an executed tool is not reported as nothing done', async (t) => {
  const p = await provider(t, (_body, n) => n === 1 ? calls(call('write_file', { path: '~/r.txt', content: 'x' })) : { status: 401, data: { error: { message: 'key expired' } } });
  const agent = loop(cfg({ openrouterBaseUrl: p.url }));
  const result = await agent.run('write a file');
  assert.match(asText(result), /adhoora/);
  assert.match(asText(result), /write_file/);
  assert.doesNotMatch(asText(result), /kuch bhi nahi kiya/);
  assert.equal(agent.lastRun.partial, true);
  assert.equal(agent.lastRun.attempts[0].error.kind, 'auth');
});

test('agent: a failed real tool cannot be hidden behind a model success claim', async (t) => {
  const p = await provider(t, (_body, n) => n === 1 ? calls(call('open_app', { app: 'chrome' })) : answer('Chrome khul gaya ✅'));
  const agent = loop(cfg({ openrouterBaseUrl: p.url }), async () => ({ ok: false, text: 'No graphical session; app could not be launched.' }), [schema('open_app', { app: { type: 'string' } })]);
  const result = await agent.run('chrome kholo');
  assert.match(asText(result), /No graphical session/);
  assert.doesNotMatch(asText(result), /Chrome khul gaya/);
  assert.equal(agent.lastRun.ok, false);
});

test('agent: false zero-tool success is escalated to a brain that actually executes', async (t) => {
  const p = await provider(t, (body) => body.model.includes('70b') ? answer('Ho gaya bhai ✅') : body.messages.some((message) => message.role === 'tool') ? answer('File verified.') : calls(call('write_file', { path: '~/r.txt', content: 'x' })));
  const agent = loop(cfg({ openrouterBaseUrl: p.url, openrouterModelFallbacks: ['test/30b:free'] }));
  assert.equal(await agent.run('write a file', {}, { forceTier: 'heavy' }), 'File verified.');
  assert.equal(agent.lastRun.attempts.length, 2);
  assert.equal(agent.lastRun.attempts[0].ok, false);
  assert.equal(agent.lastRun.toolCalls, 1);
});

test('tools: relevant code/file/search tools win over unrelated alphabetical defaults', () => {
  const store = memory();
  const config = cfg({ allowShell: true });
  const actions = createActions({ config, store, log: silent });
  const agent = createAgentLoop({ config, store, actions, log: silent });
  const names = agent.toolsFor('write a python script to scrape a site then save the csv report', { limit: 8 }).map((tool) => tool.name);
  for (const name of ['write_file', 'read_file', 'run_shell', 'web_search', 'read_url']) assert.ok(names.includes(name), `${name} is offered`);
  assert.ok(!names.includes('power'));
  assert.equal(names.length, 8);
});

test('protocol: compaction preserves schemas, current task and call/result pairs', () => {
  const tool = { ...write, description: 'long description '.repeat(100) };
  const compact = compactSchema(tool, 100);
  assert.deepEqual(compact.parameters, tool.parameters);
  assert.ok(compact.description.length <= 100);
  const task = 'CURRENT TASK — do not truncate or replace this';
  const messages = [
    { role: 'system', content: 'Safety rules.' }, { role: 'user', content: 'old history'.repeat(100) },
    { role: 'user', content: task }, { role: 'assistant', content: '', tool_calls: [call('read_file', { path: '~/x' })] },
    { role: 'tool', tool_call_id: 'read_file', content: 'result '.repeat(1000) },
  ];
  const fitted = fitAgentMessages(messages, [compact], { maxChars: 3000, compact: true, historyCount: 1 });
  assert.equal(fitted[1].content, task);
  assert.ok(fitted.some((message) => message.tool_calls));
  assert.ok(fitted.some((message) => message.tool_call_id === 'read_file'));
  assert.equal(messages.at(-1).content.length, 7000, 'source conversation is not mutated');
  assert.equal(stableSignature('write_file', { a: 1, b: 2 }), stableSignature('write_file', { b: 2, a: 1 }));
});

test('/agent: failure output shows actual attempts, actionable cause, and no API secrets', async (t) => {
  const key = 'fixture-secret-key';
  const p = await provider(t, () => ({ status: 401, data: { error: { message: `Invalid API key ${key}` } } }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-brain-command-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = cfg({ aiProvider: 'groq', groqApiKey: key, groqBaseUrl: p.url, dataDir: dir, sharedDir: path.join(dir, 'shared'), downloadsDir: path.join(dir, 'downloads') });
  const agent = createAgent({ config, store: memory(), log: silent });
  const text = asText(await agent.handle('/agent write a complete python script then save the detailed report', {}));
  assert.match(text, /Kaam nahi ho paaya/);
  assert.match(text, /HTTP 401/);
  assert.match(text, /auth/);
  assert.match(text, /Check its key in .env/);
  assert.doesNotMatch(text, new RegExp(key));
  assert.equal(p.seen.length, 1);
  assert.doesNotMatch(text, /tried:.*gpt-oss-20b/, 'unattempted siblings must not be reported as tried');
});

test('chat completion uses the same error-envelope-aware transport and cooldown', async (t) => {
  const p = await provider(t, (body) => body.model.includes('70b') ? { data: { error: { code: 404, message: 'model not found' } } } : answer('Completion from backup.'));
  const result = await complete(cfg({ openrouterBaseUrl: p.url, openrouterModelFallbacks: ['test/30b:free'] }), 'write a complete python script then save and verify the report', silent);
  assert.equal(result.text, 'Completion from backup.');
  assert.equal(p.seen.length, 2);
});

test('OpenRouter: stale named models fall through to the free auto-router by default', async (t) => {
  const p = await provider(t, (body) => body.model !== 'openrouter/free'
    ? { status: 404, data: { error: { message: 'No endpoints for this model' } } }
    : body.messages.some((message) => message.role === 'tool') ? answer('Verified with free fallback.') : calls(call('write_file', { path: '~/r.txt', content: 'x' })));
  const config = cfg({ openrouterBaseUrl: p.url });
  delete config.openrouterModelFallbacks; // use the installed default
  const agent = loop(config);
  assert.equal(await agent.run('write a complete python script then verify it', {}, { forceTier: 'heavy' }), 'Verified with free fallback.');
  assert.equal(agent.lastRun.attempts[1].modelId, 'openrouter:openrouter/free');
  assert.equal(p.seen[1].body.provider.require_parameters, true);
  assert.ok(p.seen.every(({ body }) => body.model.endsWith(':free') || body.model === 'openrouter/free'));
  assert.equal(buildCatalog(cfg()).filter((model) => model.provider === 'openrouter').length, 1, 'explicit [] opts out of auto fallback');
});

test('agent: observations are refreshed after failover instead of reusing pre-write reads', async (t) => {
  const first = await provider(t, (_body, n) => n === 1 ? calls(call('read_file', { path: '~/r.txt' }))
    : n === 2 ? calls(call('write_file', { path: '~/r.txt', content: 'new' }))
      : { status: 503, data: { error: { message: 'provider down' } } });
  const second = await provider(t, (_body, n) => n === 1 ? calls(call('read_file', { path: '~/r.txt' })) : answer('Verified new file contents.'));
  let content = 'old';
  const trace = [];
  const agent = loop(cfg({ aiProvider: 'auto', groqApiKey: 'fixture-key', groqBaseUrl: first.url, openrouterBaseUrl: second.url }), async (name) => {
    if (name === 'write_file') content = 'new';
    trace.push(`${name}:${content}`);
    return { ok: true, text: content };
  });
  assert.equal(await agent.run('read the file then write a complete python script and verify the result', {}, { forceTier: 'heavy' }), 'Verified new file contents.');
  assert.deepEqual(trace, ['read_file:old', 'write_file:new', 'read_file:new']);
  assert.match(second.seen[1].body.messages.at(-1).content, /new/);
});

test('agent: token-truncated output is not called complete or retried with an even smaller output budget', async (t) => {
  const p = await provider(t, (body) => body.model.includes('70b')
    ? { choices: [{ finish_reason: 'length', message: { content: 'Done ✅' } }] }
    : body.messages.some((message) => message.role === 'tool') ? answer('File verified.') : calls(call('write_file', { path: '~/r.txt', content: 'x' })));
  const agent = loop(cfg({ openrouterBaseUrl: p.url, openrouterModelFallbacks: ['test/30b:free'] }));
  assert.equal(await agent.run('write a file', {}, { forceTier: 'heavy' }), 'File verified.');
  assert.equal(agent.lastRun.attempts[0].error.kind, 'output');
  assert.match(agent.lastRun.attempts[0].error.hint, /AGENT_MAX_TOKENS/);
  assert.equal(agent.lastRun.compactRetries, 0);
  assert.equal(agent.lastRun.toolCalls, 1);
});

test('agent: conversation persistence errors do not restart already executed work', async (t) => {
  const p = await provider(t, (_body, n) => n === 1 ? calls(call('write_file', { path: '~/r.txt', content: 'x' })) : answer('File verified.'));
  const store = memory();
  store.pushHistory = () => { throw new Error('disk full'); };
  let executions = 0;
  const agent = loop(cfg({ openrouterBaseUrl: p.url }), async () => { executions++; return { ok: true, text: 'written' }; }, [write], store);
  assert.equal(await agent.run('write a file'), 'File verified.');
  assert.equal(executions, 1);
  assert.equal(agent.lastRun.attempts.length, 1);
  assert.equal(agent.lastRun.ok, true);
});

test('router: local endpoints have independent IDs and credential cooldowns', async (t) => {
  const dead = await provider(t, () => ({ status: 401, data: { error: { message: 'Invalid API key' } } }));
  const live = await provider(t, () => answer('Private backup answered.'));
  const agent = loop(cfg({ aiProvider: 'llamacpp', localApiUrl: dead.url, localApiUrlHeavy: live.url, localModel: 'same-70b', localModelHeavy: 'same-70b' }));
  const local = agent.router.catalog.filter((model) => model.provider === 'local');
  assert.equal(local.length, 2);
  assert.notEqual(local[0].id, local[1].id);
  assert.ok(local.every((model) => !model.id.includes('http')));
  assert.equal(await agent.run('explain the implementation', {}, { forceTier: 'heavy' }), 'Private backup answered.');
  assert.equal(dead.seen.length, 1);
  assert.equal(live.seen.length, 1);
  assert.ok(agent.lastRun.attempts.every((attempt) => attempt.modelId.startsWith('local:')));
});

test('protocol: a large current task is rejected with a size error, never silently truncated', () => {
  const messages = [{ role: 'system', content: 'Safety rules.' }, { role: 'user', content: 'x'.repeat(8000) }];
  assert.throws(() => fitAgentMessages(messages, [write], { maxChars: 4000, compact: true }), (err) => err.status === 413);
  assert.equal(messages[1].content.length, 8000);
});


test('transport: HTTP 413 wins over a misleading rate_limit_exceeded envelope', () => {
  const error = new BrainError('413: request payload too large', { status: 413, code: 'rate_limit_exceeded' });
  assert.equal(brainFailure(error).kind, 'context');
  assert.equal(brainFailure(new BrainError('429: too many tokens this minute', { status: 429, code: 'rate_limit_exceeded' })).kind, 'rate_limit');
});
