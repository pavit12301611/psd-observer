// Tests for 3.0 JARVIS voice: spoken-text shaping, Hindi speech → commands,
// the shared voice-call brain (confirm gate, command chaining, call control),
// the WhatsApp call segmenter, TTS engine order, the real-call adapter
// (against a FAKE VoIP engine — no WhatsApp account in CI), the incoming-call
// fallback, and the phone-app call API. Everything offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  spokenSummary, splitSentences, normalizeSpokenText, stripWakeWord,
  isEndCallPhrase, isAffirmPhrase, jarvisGreeting,
} from '../src/jarvis.js';
import * as tts from '../src/tts.js';
import { createVoiceCall, splitSpokenCommands } from '../src/voicecall.js';
import {
  UtteranceSegmenter, encodeWavS16, floatToS16le, createWaVoip,
} from '../src/wavoip.js';
import { createAgent } from '../src/commands.js';
import { createWhatsApp } from '../src/whatsapp.js';
import { createBridgeServer } from '../src/server.js';
import { Mailbox } from '../src/mailbox.js';
import { Store } from '../src/store.js';

const silent = { info() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'observer-voice-'));

function makeConfig(dir, overrides = {}) {
  return {
    ownerNumber: '919528923866',
    agentNumber: '918859555795',
    timezone: 'Asia/Kolkata',
    accessLevel: 'full',
    confirmTtlMs: 120_000,
    aiProvider: 'none',
    agentTools: true,
    ttsEngine: 'auto',
    ttsVoice: 'jarvis',
    jarvisAddress: 'Sir',
    jarvisPersona: true,
    voiceCall: true,
    voiceMaxSpokenChars: 340,
    waCallAnswer: false,
    waCallFallback: 'voice-session',
    waCallFallbackDelayMs: 10,
    waCallUnknown: 'ignore',
    voipAuthDir: path.join(dir, 'auth_info_voip'),
    dataDir: dir,
    storeFile: path.join(dir, 'store.json'),
    downloadsDir: path.join(dir, 'downloads'),
    sharedDir: path.join(dir, 'shared'),
    authDir: path.join(dir, 'auth_info'),
    dryRun: true,
    ...overrides,
  };
}

// ── jarvis.js: spoken language ────────────────────────────────────────────────

test('jarvis: Devanagari speech becomes runnable Hinglish commands', () => {
  assert.equal(normalizeSpokenText('क्रोम खोलो'), 'chrome kholo');
  assert.equal(normalizeSpokenText('जार्विस स्क्रीनशॉट भेजो'), 'screenshot bhejo');
  assert.equal(normalizeSpokenText('वाईफाई बंद करो'), 'wifi band karo');
});

test('jarvis: number words become digits only next to units/controls', () => {
  assert.equal(normalizeSpokenText('jarvis volume fifty karo'), 'volume 50 karo');
  assert.equal(normalizeSpokenText('volume fifty five'), 'volume 55');
  assert.equal(normalizeSpokenText('das minute baad'), '10 minute baad');
  // "do" (give) must survive — it is a verb here, not the number 2.
  assert.equal(normalizeSpokenText('screenshot bhej do'), 'screenshot bhej do');
});

test('jarvis: wake word + mis-hearings are normalised', () => {
  assert.equal(stripWakeWord('hey jarvis, chrome kholo').text, 'chrome kholo');
  assert.equal(normalizeSpokenText('jervis screen shot bhej do'), 'screenshot bhej do');
  assert.ok(isEndCallPhrase(normalizeSpokenText('goodbye jarvis')));
  assert.ok(isAffirmPhrase('haan'));
  assert.match(jarvisGreeting({ timezone: 'Asia/Kolkata', jarvisAddress: 'Sir' }), /Sir/);
});

test('jarvis: spokenSummary never reads markup, code or URLs aloud', () => {
  const reply = [
    '*Ho gaya!* Details:',
    '• pehli cheez', '• dusri cheez', '• teesri', '• chauthi', '• paanchvi',
    '```js\nconst x = dangerous();\n```',
    'Link: https://example.com/very/long/path?token=secret',
  ].join('\n');
  const spoken = spokenSummary(reply, { jarvisAddress: 'Sir', voiceMaxSpokenChars: 340 });
  assert.ok(!spoken.includes('```'), 'no code fences spoken');
  assert.ok(!/https?:/.test(spoken), 'no URLs spoken');
  assert.ok(!spoken.includes('•'), 'no bullet glyphs spoken');
  assert.match(spoken, /sent in text/);
  assert.ok(spoken.length <= 420, `spoken stays short (${spoken.length})`);
  assert.equal(splitSentences('Hello Sir. Kaise ho? Sab theek hai!').length, 3);
});

// ── voicecall.js: the shared call brain ───────────────────────────────────────

function fakeVoicePending() {
  const state = { pending: false, ran: [], stopped: 0 };
  const voice = createVoiceCall({
    config: { jarvisAddress: 'Sir', timezone: 'Asia/Kolkata' },
    log: silent,
    runText: async (text) => {
      state.ran.push(text);
      if (text === 'haan') { state.pending = false; return '✅ Band kar diya.'; }
      if (text === 'nahi') { state.pending = false; return '👍 Cancelled'; }
      if (/band/.test(text)) { state.pending = true; return '⚠️ Confirm: Close “chrome”?'; }
      return `✅ Done: ${text}`;
    },
    speak: async (text) => ({ buffer: Buffer.from(text), mimetype: 'audio/ogg; codecs=opus', ext: 'ogg', engine: 'fake' }),
    hasPending: () => state.pending,
    stopAll: async () => { state.stopped += 1; return '🛑 Stopped'; },
  });
  return { voice, state };
}

test('voicecall: "X aur Y" runs BOTH commands in order, free', async () => {
  assert.deepEqual(splitSpokenCommands('chrome kholo aur screenshot bhej do'), ['chrome kholo', 'screenshot bhej do']);
  assert.deepEqual(splitSpokenCommands('mujhe ek kahani sunao aur hasao'), ['mujhe ek kahani sunao aur hasao'], 'fuzzy text is NOT split');
  const { voice, state } = fakeVoicePending();
  const res = await voice.say('t1', 'chrome kholo aur screenshot bhej do');
  assert.deepEqual(state.ran, ['chrome kholo', 'screenshot bhej do']);
  assert.match(res.spoken, /Done/);
  assert.ok(res.audio?.buffer?.length, 'JARVIS audio produced');
});

test('voicecall: destructive actions still need a spoken haan', async () => {
  const { voice, state } = fakeVoicePending();
  const first = await voice.say('t2', 'chrome band karo');
  assert.equal(first.state, 'confirming');
  assert.match(first.spoken, /Shall I proceed, Sir\?/);
  const second = await voice.say('t2', 'haan');
  assert.equal(state.ran.at(-1), 'haan', 'spoken yes reaches the same confirmation gate as typed chat');
  assert.match(second.spoken, /Band kar diya/);
  assert.equal(second.state, 'listening');
});

test('voicecall: ruko stops work, goodbye ends the call, dobara repeats', async () => {
  const { voice, state } = fakeVoicePending();
  await voice.say('t3', 'screenshot bhej do');
  const repeated = await voice.say('t3', 'dobara bolo');
  assert.equal(repeated.repeated, true);
  const stopped = await voice.say('t3', 'ruko');
  assert.equal(state.stopped, 1);
  assert.match(stopped.spoken, /Stopped, Sir/);
  const ended = await voice.say('t3', 'goodbye jarvis');
  assert.equal(ended.ended, true);
  assert.equal(voice.sessionInfo('t3'), null, 'session is gone after goodbye');
});

// ── wavoip.js: segmenter + wav ────────────────────────────────────────────────

test('wavoip: VAD segmenter emits one utterance per sentence of speech', async () => {
  const utterances = [];
  let speechStarts = 0;
  const seg = new UtteranceSegmenter({
    silenceEndMs: 400,
    onUtterance: (s) => utterances.push(s),
    onSpeechStart: () => { speechStarts += 1; },
  });
  const loud = () => new Float32Array(320).fill(0.3);
  const quiet = () => new Float32Array(320).fill(0.001);
  for (let i = 0; i < 10; i++) seg.push(quiet());
  assert.equal(utterances.length, 0, 'silence alone is not an utterance');
  for (let i = 0; i < 30; i++) seg.push(loud());
  for (let i = 0; i < 30; i++) seg.push(quiet());
  assert.equal(speechStarts, 1);
  assert.equal(utterances.length, 1);
  assert.ok(utterances[0].length >= 30 * 320, 'utterance keeps the speech frames');

  const wav = encodeWavS16(utterances[0]);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.length, 44 + utterances[0].length * 2);
  assert.equal(floatToS16le(new Float32Array([1, -1, 0])).length, 6);
});

// ── tts.js: engine order (the original voice bug) ─────────────────────────────

test('tts: neural Piper outranks the robot, alan (JARVIS) model preferred', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'piper'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'piper', 'piper'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'models', 'en_US-amy-medium.onnx'), 'x');
  fs.writeFileSync(path.join(dir, 'models', 'en_GB-alan-medium.onnx'), 'x');
  const config = makeConfig(dir, { voiceDir: dir });
  tts.__resetCache();
  const engines = tts.listTTSEngines(config);
  assert.equal(engines[0].name, 'piper', 'piper is FIRST now, not last');
  assert.match(engines[0].model, /alan/, 'the British JARVIS voice wins over en_US');
  const espeakIndex = engines.findIndex((e) => e.name.startsWith('espeak'));
  assert.ok(espeakIndex === -1 || espeakIndex > 0, 'espeak can only be a fallback');
  assert.match(tts.ttsStatus(config), /JARVIS voice ready/);
  tts.__resetCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── wavoip.js: full call against a FAKE engine ────────────────────────────────

test('wavoip: owner call is ANSWERED, heard, executed and spoken back', async () => {
  const dir = tempDir();
  class FakeCall extends EventEmitter {
    constructor(peer) {
      super();
      this.callId = 'call-1';
      this.incoming = true;
      this.peerJid = peer;
      this.answeredWith = null;
      this.written = [];
      this.cleared = 0;
    }
    answer(opts) { this.answeredWith = opts; }
    reject() { this.rejected = true; }
    end() { this.ended = true; this.emit('ended', 'hangup'); }
    writeAudio(chunk) { this.written.push(chunk); return true; }
    clearAudio() { this.cleared += 1; return 1; }
  }
  class FakeClient extends EventEmitter {
    constructor() { super(); FakeClient.instance = this; }
    async connect() {}
    disconnect() {}
  }
  const said = [];
  const fakeVoice = {
    start: async () => ({ greeting: 'Good evening, Sir.', spoken: 'Good evening, Sir.', audio: { buffer: Buffer.from('g'), mimetype: 'audio/ogg' } }),
    say: async (_id, text) => { said.push(text); return { spoken: 'Chrome is open, Sir.', text: '✅', audio: { buffer: Buffer.from('r'), mimetype: 'audio/ogg' } }; },
    interrupt() {}, end() {},
  };
  const config = makeConfig(dir, { waCallAnswer: true });
  const store = new Store(config.storeFile);
  const wavoip = createWaVoip({
    config,
    log: silent,
    voice: fakeVoice,
    isOwnerJid: (jid) => jid.startsWith('919528923866'),
    sendToOwner: async () => {},
    transcribe: async () => ({ text: 'chrome kholo', provider: 'fake' }),
    decodePcm: async () => Buffer.alloc(3200, 1),
    loadEngine: async () => ({ mod: { VoipClient: FakeClient }, via: 'test' }),
  });
  void store;
  const status = await wavoip.start();
  assert.equal(status.engine, 'baileys-caller');
  await sleep(20);

  // Stranger calls: never answered.
  const stranger = new FakeCall('910000000000@s.whatsapp.net');
  FakeClient.instance.emit('incoming', stranger, { peerJid: stranger.peerJid });
  assert.equal(stranger.answeredWith, null, 'non-owner call is never picked up');

  // Owner calls: answered with a live PCM stream, then a full turn happens.
  const call = new FakeCall('919528923866@s.whatsapp.net');
  FakeClient.instance.emit('incoming', call, { peerJid: call.peerJid });
  assert.equal(call.answeredWith?.audioSource, 'stream:s16le@16000', 'call answered with live audio stream');
  assert.equal(wavoip.recentlyAnswered('call-1'), true, 'messaging-side fallback knows the engine took it');
  call.emit('connected');
  await sleep(30);
  assert.ok(call.written.length > 0, 'JARVIS greeting PCM was fed into the call');
  const loud = () => new Float32Array(320).fill(0.35);
  const quiet = () => new Float32Array(320).fill(0.001);
  for (let i = 0; i < 25; i++) call.emit('audio', loud());
  for (let i = 0; i < 60; i++) call.emit('audio', quiet());
  await sleep(80);
  assert.deepEqual(said, ['chrome kholo'], 'owner speech reached the voice brain');
  assert.ok(call.written.length >= 2, 'reply PCM spoken back into the call');
  wavoip.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── whatsapp.js: incoming call fallback (engine off) ─────────────────────────

test('whatsapp: owner call with no VoIP engine → JARVIS voice session fallback', async () => {
  const dir = tempDir();
  const config = makeConfig(dir);
  const store = new Store(config.storeFile);
  const agent = createAgent({ config, store, log: silent });
  const whatsapp = createWhatsApp({ config, store, agent, log: silent });
  await whatsapp.handleCallEvents([{ id: 'fb1', from: '919528923866@s.whatsapp.net', status: 'offer' }]);
  await sleep(300);
  assert.equal(store.data.voiceCallMode, true, 'voice mode switched on by the call');
  const sent = whatsapp.state.simulated.map((s) => s.text ?? '').join('\n');
  assert.match(sent, /Call received, Sir/);
  assert.match(sent, /call-engine|Call tab/, 'owner is told exactly how live calling works');

  // Non-owner calls get nothing at all.
  const before = whatsapp.state.simulated.length;
  await whatsapp.handleCallEvents([{ id: 'fb2', from: '910000000000@s.whatsapp.net', status: 'offer' }]);
  await sleep(120);
  assert.equal(whatsapp.state.simulated.length, before, 'stranger call: total silence');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── server.js: the phone-app call API ─────────────────────────────────────────

test('server: /api/call/start + /api/call/say run a real JARVIS turn', async () => {
  const dir = tempDir();
  const port = 18987 + Math.floor(Math.random() * 400);
  const config = makeConfig(dir, {
    host: '127.0.0.1', port, bridgeToken: 'voice-test-token', dashboardPin: '123456',
  });
  const store = new Store(config.storeFile);
  const agent = createAgent({ config, store, log: silent });
  const whatsapp = createWhatsApp({ config, store, agent, log: silent });
  const mailbox = new Mailbox({ waitMs: 100 });
  const bridge = createBridgeServer({
    config, store, whatsapp, mailbox,
    actions: agent.actions, voice: agent.voice, wavoip: null,
    runOwner: (text) => whatsapp.runOwner(text), log: silent,
  });
  await bridge.start();
  try {
    const headers = { 'content-type': 'application/json', 'x-bridge-token': 'voice-test-token' };
    const startRes = await fetch(`http://127.0.0.1:${port}/api/call/start`, { method: 'POST', headers, body: '{}' });
    const started = await startRes.json();
    assert.equal(startRes.status, 200);
    assert.ok(started.sessionId);
    assert.match(started.greeting, /Sir/);

    const sayRes = await fetch(`http://127.0.0.1:${port}/api/call/say`, {
      method: 'POST', headers,
      body: JSON.stringify({ sessionId: started.sessionId, text: '/time' }),
    });
    const said = await sayRes.json();
    assert.equal(sayRes.status, 200);
    assert.ok(said.spoken.length > 3, 'reply is speakable');
    assert.equal(said.heard, '/time');

    const voiceRes = await fetch(`http://127.0.0.1:${port}/api/voice`, { headers });
    const voiceInfo = await voiceRes.json();
    assert.equal(voiceRes.status, 200);
    assert.ok(Array.isArray(voiceInfo.engines));

    const noAuth = await fetch(`http://127.0.0.1:${port}/api/call/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noAuth.status, 401, 'call API is behind the bridge token like everything else');
  } finally {
    bridge.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
