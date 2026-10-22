// AI quality suite — language, grammar and reply pipeline of the free brain.
//
// Vigorously tests the layers between "user types a WhatsApp message" and
// "model answer goes out": language detection (Hinglish/English/Devanagari),
// question-scope lock ("jo pucha hai sirf wahi"), preamble stripping,
// offline bilingual corpus replies, filler/grammar post-processing, the
// deterministic accuracy engine, Hinglish offline intents, and the full
// chat() round-trip against a localhost mock brain (no cloud, no key).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  detectBilingualMode,
  detectQuestionScope,
  extractCoreQuestion,
  lookupBilingualCorpus,
  buildBilingualMasteryDirective,
  runBilingualMasteryBenchmark,
  BILINGUAL_CORPUS,
} from '../src/bilingual.js';
import {
  postProcessAiAnswer,
  selectOptimalTemperature,
  solveDeterministicQuery,
  runAccuracySelfTest,
} from '../src/accuracy.js';
import { parseIntent } from '../src/nlp.js';
import { chat, guestChat, aiCacheStats, raceModels } from '../src/ai.js';
import { lookupKnowledge, formatKnowledgeContext, ingestWikiEntry, lookupLearnedKnowledge, BUILTIN_KNOWLEDGE } from '../src/knowledge.js';
import { looksFactualQuery, toWikiQuery, wikiSummary, wikiContextFor, wikiCommand, wikiFallback, trainFromWikipedia, loadTrainedWikiFile } from '../src/wiki.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THINK = '<' + 'think' + '>';
const THINK_END = '</' + 'think' + '>';

// ── 1. Language detection ───────────────────────────────────────────────────

test('ai: language detection — Hinglish vs English vs Devanagari', () => {
  const cases = [
    ['bhai ye kya hai', 'hinglish'],
    ['chrome kholo', 'hinglish'],
    ['wifi band karo', 'hinglish'],
    ['screenshot bhej do', 'hinglish'],
    ['yaar kal ka mausam kaisa rahega', 'hinglish'],
    ['iska matlab kya hai', 'hinglish'],
    ['yaar this is amazing', 'hinglish'],
    ['thanks yaar', 'hinglish'],
    ['kya tum mujhe python sikhate ho', 'hinglish'],
    ['What is the time complexity of binary search?', 'english'],
    ['can you help me with this code', 'english'],
    ['the system is running fine', 'english'],
    ['ok thanks', 'english'],
    ['thanks bro', 'english'],
    ['hello', 'english'],
    ['open chrome', 'english'],
    ['मुझे हिंदी में बताओ', 'hindi_deva'],
    ['मैं ठीक हूँ', 'hindi_deva'],
  ];
  for (const [txt, want] of cases) {
    assert.equal(detectBilingualMode(txt), want, `detectBilingualMode(${JSON.stringify(txt)})`);
  }
  assert.equal(detectBilingualMode(''), 'hinglish', 'empty defaults to owner language');
});

// ── 2. Question-scope lock ("jo pucha hai sirf uska hi jawab") ──────────────

test('ai: question scope — exact answer shape, no unasked lectures', () => {
  const cases = [
    ['seedha bata 255 in binary', 'ultra_direct'],
    ['TCP aur UDP me kya farak hai?', 'comparison'],
    ['Python me list sort kaise karein?', 'practical_howto'],
    ['write a code to reverse a string', 'practical_howto'],
    ['which is better SQL or NoSQL', 'comparison'],
    ['What is photosynthesis?', 'direct_fact'],
    ['what is the capital of india?', 'direct_fact'],
    ['explain in detail how TCP works', 'deep_explanation'],
  ];
  for (const [txt, want] of cases) {
    assert.equal(detectQuestionScope(txt).scope, want, `detectQuestionScope(${JSON.stringify(txt)})`);
  }
});

test('ai: greetings are never locked to quiz-style direct_fact', () => {
  for (const txt of ['bhai kya haal hai', 'kaise ho', "what's up", 'how are you', 'good morning', 'sab theek hai']) {
    assert.notEqual(detectQuestionScope(txt).scope, 'direct_fact', `greeting ${JSON.stringify(txt)}`);
    assert.equal(detectQuestionScope(txt).scope, 'focused_standard', `greeting ${JSON.stringify(txt)}`);
  }
  assert.equal(detectQuestionScope('').scope, 'focused_standard', 'empty input');
});

// ── 3. Conversational preamble stripping ───────────────────────────────────

test('ai: preamble stripper keeps only the core question', () => {
  const cases = [
    ['bhai ek baat bata ki TCP vs UDP me kya farak hai', 'TCP vs UDP me kya farak hai'],
    ['hey bro can you tell me what is 2+2', 'what is 2+2'],
    ['please batao ye kya hota hai', 'kya hota hai'],
    ['arre suno yaar ye batao ki 2+2 kya hai', '2+2 kya hai'],
    ['suno yaar mera naam kya hai', 'mera naam kya hai'],
    ['mujhe ek baat bata, time kya hua hai', 'time kya hua hai'],
  ];
  for (const [txt, want] of cases) {
    assert.equal(extractCoreQuestion(txt), want, `extractCoreQuestion(${JSON.stringify(txt)})`);
  }
});

// ── 4. Offline bilingual corpus — reply content & language match ───────────

test('ai: every corpus entry ships non-empty Hinglish AND English replies', () => {
  for (const item of BILINGUAL_CORPUS) {
    assert.ok(item.hi?.trim(), `corpus ${item.id} missing hi reply`);
    assert.ok(item.en?.trim(), `corpus ${item.id} missing en reply`);
    assert.ok(item.patterns?.length, `corpus ${item.id} missing patterns`);
    // Roman-Hinglish replies must not leak Devanagari mid-script
    if (item.id !== 'vocab_hint') {
      assert.ok(!/[\u0900-\u097F]/.test(item.hi), `corpus ${item.id} hi reply mixes Devanagari into Roman Hinglish`);
    }
  }
});

test('ai: corpus replies match the user language', () => {
  const en = lookupBilingualCorpus('What is the difference between TCP and UDP?');
  assert.equal(en?.lang, 'english');
  assert.equal(en?.id, 'tech_tcp_vs_udp');
  const hi = lookupBilingualCorpus('== aur === me kya farak hai');
  assert.equal(hi?.lang, 'hinglish');
  assert.ok(hi?.reply.includes('Strict Equality'));
});

test('ai: corpus catches WhatsApp text-speak ("what can u do", "how r u", "THANKS A LOT")', () => {
  assert.equal(lookupBilingualCorpus('what can u do')?.id, 'capability_who_are_you');
  assert.equal(lookupBilingualCorpus('how r u')?.id, 'checkin_how_are_you');
  assert.equal(lookupBilingualCorpus('THANKS A LOT')?.id, 'appreciation_thanks');
  assert.equal(lookupBilingualCorpus('ram vs rom')?.id, 'tech_ram_vs_rom');
});

test('ai: corpus does not hijack unrelated chat', () => {
  assert.equal(lookupBilingualCorpus('hello'), null);
  assert.equal(lookupBilingualCorpus('SQL joins ke bare me batao kya hote hain'), null);
});

test('ai: "speak in english" locks the reply language mode', () => {
  const store = { data: {}, save() {} };
  lookupBilingualCorpus('speak in english', store);
  assert.equal(store.data.preferredLanguageMode, 'english');
});

test('ai: built-in bilingual mastery benchmark is 100%', () => {
  const bb = runBilingualMasteryBenchmark();
  assert.equal(bb.passed, bb.total, JSON.stringify(bb.checks.filter((c) => !c.ok)));
});

test('ai: mastery directive injects language lock + gold exemplars', () => {
  const dir = buildBilingualMasteryDirective('bhai TCP vs UDP me kya farak hai');
  assert.match(dir, /HINGLISH/);
  assert.match(dir, /Example 1/);
  assert.match(dir, /ZERO FILLER/);
  const enDir = buildBilingualMasteryDirective('Explain the OSI model in English.');
  assert.match(enDir, /IMPECCABLE ENGLISH/);
});

// ── 5. Reply post-processing — filler, think blocks, grammar enforcement ───

test('ai: postProcess strips think blocks completely', () => {
  assert.equal(postProcessAiAnswer(`${THINK}scratch${THINK_END}\nThe answer is 42`), 'The answer is 42');
  assert.equal(postProcessAiAnswer(`${THINK}x${THINK_END}`), '');
});

test('ai: postProcess strips English robotic preambles (stacked too)', () => {
  assert.ok(!postProcessAiAnswer('As an AI language model, I think 4 is the answer.').startsWith('As an AI'));
  assert.equal(postProcessAiAnswer('Certainly! Here is the answer: Paris'), 'Paris');
  const stacked = postProcessAiAnswer('Certainly! Here is the answer: 5.\n\nSure! I would be happy to help. The value is 5.');
  assert.ok(!stacked.startsWith('Certainly') && !stacked.includes('happy to help'), stacked);
});

test('ai: postProcess strips Hinglish robotic preambles', () => {
  const hing = postProcessAiAnswer('Namaste! Main aapki sahayata karunga. Delhi capital hai.');
  assert.equal(hing, 'Delhi capital hai.');
  const hindi = postProcessAiAnswer('Ji bilkul! Main aapki sahayata karne ke liye taiyar hoon. Ye raha jawab.');
  assert.ok(!hindi.startsWith('Ji bilkul'), hindi);
});

test('ai: postProcess keeps normal answers and persona warmth intact', () => {
  assert.equal(postProcessAiAnswer('Paris is the capital of France.'), 'Paris is the capital of France.');
  assert.ok(postProcessAiAnswer('Bilkul bhai! Ye raha jawab: 42').startsWith('Bilkul'));
});

// ── 6. Deterministic accuracy engine ───────────────────────────────────────

test('ai: accuracy engine self-test is 10/10', () => {
  const bench = runAccuracySelfTest();
  assert.equal(bench.passed, bench.total, JSON.stringify(bench.results.filter((r) => !r.passed)));
});

test('ai: deterministic answers — math, bases, number theory', () => {
  assert.equal(solveDeterministicQuery('2+2')?.value, '4');
  assert.equal(solveDeterministicQuery('12 * 12')?.value, '144');
  assert.equal(solveDeterministicQuery('5 factorial')?.value, '120');
  assert.equal(solveDeterministicQuery('factorial of 5')?.value, '120');
  assert.equal(Number(solveDeterministicQuery('15% of 200')?.value), 30);
  assert.equal(solveDeterministicQuery('gcd of 48 and 180')?.value, '12');
  assert.equal(solveDeterministicQuery('lcm of 4 and 6')?.value, '12');
  assert.ok(String(solveDeterministicQuery('255 in binary')?.value).includes('11111111'));
});

// ── 7. Adaptive temperature (hallucination control) ────────────────────────

test('ai: temperature — math/MCQ frozen low, chat warm', () => {
  assert.equal(selectOptimalTemperature('solve 2x + 3 = 7'), 0.05);
  assert.equal(selectOptimalTemperature('Which of the following is NOT a prime? (A) 2'), 0.05);
  assert.equal(selectOptimalTemperature('who is the president of france'), 0.12);
  assert.equal(selectOptimalTemperature('bhai aaj mood achha nahi hai'), 0.28);
  assert.equal(selectOptimalTemperature(''), 0.2);
});

// ── 8. Offline Hinglish intents (zero-AI layer) ────────────────────────────

test('ai: Hinglish intents route to commands without any AI', () => {
  const cases = [
    ['chrome kholo', 'open', 'chrome'],
    ['wifi band karo', 'wifi', 'off'],
    ['screenshot bhej do', 'screenshot', ''],
    ['screenshot lo', 'screenshot', ''],
    ['volume kam karo', 'pc', 'volume down'],
    ['awaaz badhao', 'pc', 'volume up'],
    ['terminal me df -h chalao', 'run', 'df -h'],
    ['firefox band karo', 'close', 'firefox'],
  ];
  for (const [txt, wantCmd, wantArgs] of cases) {
    const got = parseIntent(txt);
    assert.equal(got?.cmd, wantCmd, `parseIntent(${JSON.stringify(txt)}) cmd`);
    if (wantArgs !== null) assert.equal(got?.args, wantArgs, `parseIntent(${JSON.stringify(txt)}) args`);
  }
});

test('ai: questions are never hijacked as commands', () => {
  for (const q of ['open source kya hai?', 'what is a thread', 'kaise ho bhai', 'what is the meaning of life']) {
    const got = parseIntent(q);
    assert.ok(!got || !['open', 'close', 'run', 'wifi', 'pc', 'screenshot'].includes(got.cmd), `${q} -> ${JSON.stringify(got)}`);
  }
});

// ── 9. Full chat() round-trip against a mock brain ─────────────────────────

test('ai: chat() e2e — prompt build, think-strip, cache, history, guest sandbox', async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      received.push(parsed);
      const userMsg = (parsed.messages || []).filter((m) => m.role === 'user').pop()?.content || '';
      let reply;
      if (userMsg.includes('THINKTAG')) reply = `${THINK}scratch${THINK_END}\nParis is the capital of France.`;
      else if (userMsg.includes('2+2')) reply = 'The answer is 5.';
      else if (userMsg.includes('Namaste')) reply = 'Namaste! Main aapki sahayata karunga. Delhi is the capital.';
      else reply = `mock-reply-for: ${userMsg.slice(0, 40)}`;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const config = {
    ownerNumber: '919528923866',
    agentNumber: '918859555795',
    timezone: 'Asia/Kolkata',
    aiCache: true,
    groqBaseUrl: baseUrl,
    groqApiKey: 'test-key',
    groqModel: 'mock-big',
    groqModelSmall: 'mock-small',
    groqVisionModel: '',
    openrouterBaseUrl: baseUrl,
    openrouterApiKey: 'test-key',
    openrouterModel: 'mock-or',
    geminiApiKey: '',
    ollamaUrl: 'http://127.0.0.1:9',
    ollamaModel: '',
    modelCooldownMs: 1,
    routerPrefer: 'cloud',
  };
  const mkStore = () => {
    const data = { history: [], memory: { facts: [], rules: [] }, todos: [] };
    return {
      data,
      save() {},
      pushHistory(role, content) {
        data.history.push({ role, content });
        if (data.history.length > 50) data.history.shift();
      },
    };
  };

  const store = mkStore();
  const res1 = await chat(config, store, 'What is the capital of France? THINKTAG', console, { skipBackgroundReflect: true });
  assert.equal(res1?.text, 'Paris is the capital of France.', 'think block stripped end-to-end');

  const sys = received[0]?.messages?.find((m) => m.role === 'system')?.content || '';
  assert.match(sys, /Hinglish/, 'system prompt carries the language rule');
  assert.match(sys, /ZERO-HALLUCINATION|ACCURACY/, 'system prompt carries the accuracy protocol');
  assert.match(sys, /QUESTION-SCOPE/, 'system prompt carries the scope lock');
  assert.ok(sys.includes('919528923866'), 'system prompt carries the owner number');
  assert.equal(store.data.history.length, 2, 'history recorded');

  const before = received.length;
  const res2 = await chat(config, store, 'What is the capital of France? THINKTAG', console, { skipBackgroundReflect: true });
  assert.equal(res2?.cached, true, 'identical question served from cache');
  assert.equal(received.length, before, 'cache hit makes no model call');
  assert.ok(aiCacheStats(config).hits >= 1, 'cache stats tracked');

  const before2 = received.length;
  await chat(config, store, 'aur batao', console, { skipBackgroundReflect: true });
  assert.ok(received.length > before2, 'context follow-up ("aur batao") is never cached');

  const store2 = mkStore();
  const res3 = await chat(config, store2, '2+2 kya hota hai?', console, { skipBackgroundReflect: true });
  assert.ok(res3?.text?.includes('4'), `ground-truth correction appended: ${res3?.text}`);

  const res4 = await chat(config, store2, 'Namaste, help me', console, { skipBackgroundReflect: true });
  assert.ok(!/namaste|namaskar/i.test(res4?.text ?? 'x'), `Namaste fully banned in replies: ${res4?.text}`);
  assert.equal(res4?.text, 'Delhi is the capital.');

  const gstore = mkStore();
  const gres = await guestChat(config, gstore, '911234567890', 'hello there', console);
  assert.ok(gres?.text, 'guest chat replies');
  const gsys = received[received.length - 1]?.messages?.find((m) => m.role === 'system')?.content || '';
  assert.match(gsys, /LOCKED to the owner only|STRICT SECURITY/, 'guest prompt locks commands');
  assert.equal(gstore.data.history.length, 0, 'guest history isolated from owner store');

  const winner = await raceModels(['slow', 'fast'], async (m) => {
    if (m === 'slow') await new Promise((r) => setTimeout(r, 300));
    return m;
  }, { hedgeDelayMs: 30 });
  assert.equal(winner?.model, 'fast', 'hedged race picks the faster brain');
});


// ── 10. Owner hard rule: "Namaste"/"Namaskar" NEVER go out ──────────────────

test('ai: postProcess bans Namaste/Namaskar in every position', () => {
  assert.equal(postProcessAiAnswer('Namaste! Kya haal hai bhai?'), 'Kya haal hai bhai?');
  assert.equal(postProcessAiAnswer('Namaskar! Ye raha jawab: 42'), 'Ye raha jawab: 42');
  const mid = postProcessAiAnswer('Delhi capital hai. Namaste, aur kuch poochna ho to batao.');
  assert.ok(!/namaste|namaskar/i.test(mid), mid);
  const only = postProcessAiAnswer('Namaste!');
  assert.ok(only && !/namaste|namaskar/i.test(only), `fallback without the banned word: ${only}`);
});

test('ai: no corpus or knowledge reply ever contains Namaste/Namaskar', () => {
  for (const item of BILINGUAL_CORPUS) {
    assert.ok(!/namaste|namaskar/i.test(item.hi), `corpus ${item.id} hi`);
    assert.ok(!/namaste|namaskar/i.test(item.en), `corpus ${item.id} en`);
  }
  for (const item of BUILTIN_KNOWLEDGE) {
    assert.ok(!/namaste|namaskar/i.test(item.hi), `knowledge ${item.id} hi`);
    assert.ok(!/namaste|namaskar/i.test(item.en), `knowledge ${item.id} en`);
  }
});

// ── 11. Built-in Wikipedia-trained knowledge bank ──────────────────────────

test('ai: knowledge bank answers core GK instantly (offline, zero AI)', () => {
  assert.match(lookupKnowledge('what is the capital of india')?.reply ?? '', /New Delhi/);
  assert.match(lookupKnowledge('india ki capital kya hai')?.reply ?? '', /New Delhi/);
  assert.match(lookupKnowledge('speed of light')?.reply ?? '', /299,792,458/);
  assert.match(lookupKnowledge('who built taj mahal')?.reply ?? '', /Shah Jahan/);
  assert.match(lookupKnowledge('capital of france')?.reply ?? '', /Paris/);
  assert.match(lookupKnowledge('national game of india')?.reply ?? '', /no official national game|koi official national game nahi/);
  assert.match(lookupKnowledge('chandrayaan 3')?.reply ?? '', /south pole|Vikram/);
  assert.match(lookupKnowledge('what is photosynthesis')?.reply ?? '', /sunlight|glucose/);
});

test('ai: knowledge bank language-matches (Hinglish query → Hinglish reply)', () => {
  const hit = lookupKnowledge('india ki capital kya hai');
  assert.equal(hit?.lang, 'hinglish');
  assert.match(hit.reply, /hai/);
  const en = lookupKnowledge('What is the speed of light?');
  assert.equal(en?.lang, 'english');
});

test('ai: knowledge bank does not hijack casual chat', () => {
  assert.equal(lookupKnowledge('hello how are you'), null);
  assert.equal(lookupKnowledge('bhai kya haal hai'), null);
});

test('ai: knowledge context formats as verified ground truth', () => {
  const hit = lookupKnowledge('speed of light');
  const block = formatKnowledgeContext(hit);
  assert.match(block, /CURATED KNOWLEDGE/);
  assert.match(block, /299,792,458/);
});

// ── 12. Wikipedia live client + training loop (mock server) ────────────────

test('ai: wikipedia grounding — fetch, learn, then answer offline', async (t) => {
  let calls = 0;
  const server = http.createServer((req, res) => {
    calls += 1;
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname.includes('api.php')) {
      res.end(JSON.stringify({ query: { search: [{ title: 'Photosynthesis' }] } }));
    } else {
      res.end(JSON.stringify({
        title: 'Photosynthesis',
        extract: 'Photosynthesis is how plants convert sunlight into energy.',
        content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Photosynthesis' } },
      }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const config = { wikiBaseUrl: `http://127.0.0.1:${server.address().port}`, wikiTimeoutMs: 2000 };

  // shape guards
  assert.equal(looksFactualQuery('who invented the world wide web?'), true);
  assert.equal(looksFactualQuery('kya haal hai bhai'), false);
  assert.equal(looksFactualQuery('/help'), false);
  assert.equal(toWikiQuery('What is photosynthesis?'), 'photosynthesis');

  // live fetch works and gets learned (the training loop)
  const store = { data: {}, save() {} };
  const ctx1 = await wikiContextFor('explain photosynthesis', config, store);
  assert.match(ctx1, /WIKIPEDIA GROUNDING/);
  assert.match(ctx1, /plants convert sunlight/);
  assert.equal(store.data.wikiKnowledge?.length, 1, 'fetched summary is learned');

  // second lookup is answered from the learned store — zero new HTTP calls
  const before = calls;
  const ctx2 = await wikiContextFor('photosynthesis', config, store);
  assert.match(ctx2, /previously learned/);
  assert.equal(calls, before, 'learned cache answers without the network');

  // wikiCommand learns too — use a topic the built-in bank does not know, so
  // the live path runs (and remembers) instead of the instant built-in answer.
  const store2 = { data: {}, save() {} };
  const reply = await wikiCommand('theory of relativity', config, store2);
  assert.match(reply, /Photosynthesis/); // the mock returns this summary for any query
  assert.match(reply, /yaad bhi rakh liya/, 'the reply says the topic was learned');
  assert.equal(store2.data.wikiKnowledge?.length, 1);

  // trainFromWikipedia batch
  const store3 = { data: {}, save() {} };
  const trained = await trainFromWikipedia(['Photosynthesis', 'Photosynthesis'], config, store3);
  assert.equal(trained.learned, 2);
  assert.equal(trained.failed.length, 0);

  // offline: builtin still answers, live path fails gracefully
  const offline = await wikiCommand('capital of india', { wikiBaseUrl: 'http://127.0.0.1:9', wikiTimeoutMs: 300 }, store2);
  assert.match(offline, /New Delhi/);
});

test('ai: trained wiki file loads at startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-wiki-'));
  try {
    const file = path.join(dir, 'wiki-knowledge.json');
    fs.writeFileSync(file, JSON.stringify({ entries: [{ query: 'mars', title: 'Mars', extract: 'Mars is the fourth planet from the Sun.', url: '' }] }));
    const store = { data: {}, save() {} };
    assert.equal(loadTrainedWikiFile(store, file), 1);
    assert.match(lookupLearnedKnowledge('mars', store)?.extract ?? '', /fourth planet/);
    // ingest dedupes by title
    ingestWikiEntry(store, { query: 'mars', title: 'Mars', extract: 'Updated.', url: '' });
    assert.equal(store.data.wikiKnowledge.length, 1);
    assert.match(store.data.wikiKnowledge[0].extract, /Updated/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ai: chat() e2e injects knowledge grounding into the system prompt', async (t) => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body || '{}'));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Shah Jahan ne banwaya.' } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());

  const config = {
    ownerNumber: '919528923866', agentNumber: '918859555795', timezone: 'Asia/Kolkata',
    aiCache: false,
    groqBaseUrl: `http://127.0.0.1:${server.address().port}`, groqApiKey: 'k', groqModel: 'm', groqModelSmall: 'm2', groqVisionModel: '',
    openrouterBaseUrl: `http://127.0.0.1:${server.address().port}`, openrouterApiKey: 'k', openrouterModel: 'm3',
    geminiApiKey: '', ollamaUrl: 'http://127.0.0.1:9', ollamaModel: '', modelCooldownMs: 1, routerPrefer: 'cloud',
    wikiGrounding: false, // no wiki network in this test — knowledge block alone must appear
  };
  const store = { data: { history: [] }, save() {}, pushHistory() {} };
  const res = await chat(config, store, 'who built the taj mahal?', console, { skipBackgroundReflect: true });
  assert.ok(res?.text, 'chat answered');
  const sys = received[0]?.messages?.find((m) => m.role === 'system')?.content || '';
  assert.match(sys, /CURATED KNOWLEDGE/, 'system prompt carries the knowledge ground-truth');
  assert.match(sys, /Shah Jahan/, 'knowledge fact present in prompt');
  assert.match(sys, /NAMASTE/i, 'system prompt carries the anti-Namaste hard rule');
});
