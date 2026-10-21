// wavoip.js — answering REAL WhatsApp voice calls, in-process.
//
// THE HONEST SITUATION
// Official Baileys can only *detect* and *reject* calls — it has no VoIP
// media at all (baileys.wiki/advanced/calls: "Baileys cannot accept or carry
// voice/video calls"). So this module plugs in an experimental VoIP engine,
// `baileys-caller` (github.com/Akane7101/baileys-caller), which runs WhatsApp
// Web's own VoIP WASM stack in Node and exposes exactly what a voice agent
// needs:
//
//     client.on('incoming', (call) => call.answer({ audioSource: 'stream:…' }))
//     call.on('audio', pcmFloat32_16kHz)   ← the owner's voice
//     call.writeAudio(pcmS16le)            → JARVIS speaking back, live
//     call.clearAudio()                    → barge-in: stop mid-sentence
//
// The engine holds its OWN linked-device session (auth_info_voip/, a second
// companion on the agent number) so it never fights the messaging socket.
// It is opt-in (WA_CALL_ANSWER=true), owner-only, and if it is missing or
// fails, whatsapp.js falls back to the voice-note call session — the agent
// never pretends a call was answered when it was not.
//
// Conversation loop per call:
//   peer PCM → VAD utterance segmenter → WAV → transcribe (whisper)
//     → voicecall.say() [intents → API-model tools → execute on the PC]
//     → JARVIS TTS → PCM → writeAudio … until "goodbye" / hangup / timeout.
// Screenshots & files produced mid-call are sent to the WhatsApp *chat* so
// the owner sees them while still on the call.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { ROOT } from './config.js';
import { transcribeAudio } from './transcribe.js';
import { synthesize } from './tts.js';

export const STREAM_SOURCE = 'stream:s16le@16000';
export const ENGINE_INSTALL_HINT = 'bash scripts/observer.sh voice call-engine';

// ── PCM helpers (pure, testable) ─────────────────────────────────────────────

export function rmsOf(frame) {
  if (!frame?.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

export function floatToS16le(samples) {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }
  return out;
}

/** Encode Float32 mono samples as a 16-bit WAV file (whisper food). */
export function encodeWavS16(samples, sampleRate = 16000) {
  const pcm = floatToS16le(samples);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Voice-activity utterance segmenter for the 16 kHz mono Float32 stream.
 * Emits onSpeechStart() after ~60 ms of real speech (for barge-in) and
 * onUtterance(samples) after `silenceEndMs` of quiet. The threshold adapts
 * to the line's noise floor so fan/TV hum does not become fake speech.
 */
export class UtteranceSegmenter {
  constructor({
    sampleRate = 16000, silenceEndMs = 900, minUtteranceMs = 350,
    maxUtteranceMs = 30_000, onUtterance = () => {}, onSpeechStart = () => {},
  } = {}) {
    this.sampleRate = sampleRate;
    this.silenceEndMs = silenceEndMs;
    this.minSamples = Math.floor((minUtteranceMs / 1000) * sampleRate);
    this.maxSamples = Math.floor((maxUtteranceMs / 1000) * sampleRate);
    this.onUtterance = onUtterance;
    this.onSpeechStart = onSpeechStart;
    this.noiseFloor = 0.004;
    this.inSpeech = false;
    this.speechStreak = 0;
    this.silenceMs = 0;
    this.frames = [];
    this.preRoll = [];
    this.totalSamples = 0;
  }

  threshold() { return Math.max(0.016, this.noiseFloor * 4); }

  push(frame) {
    if (!frame?.length) return;
    const rms = rmsOf(frame);
    const frameMs = (frame.length / this.sampleRate) * 1000;
    const isSpeech = rms > this.threshold();
    if (!this.inSpeech) {
      if (!isSpeech) {
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
        this.preRoll.push(frame);
        if (this.preRoll.length > 8) this.preRoll.shift(); // ~160 ms pre-roll
        this.speechStreak = 0;
        return;
      }
      this.speechStreak += 1;
      this.preRoll.push(frame);
      if (this.speechStreak < 3) return; // ignore clicks/pops
      this.inSpeech = true;
      this.silenceMs = 0;
      this.frames = [...this.preRoll];
      this.totalSamples = this.frames.reduce((n, f) => n + f.length, 0);
      this.preRoll = [];
      try { this.onSpeechStart(); } catch { /* listener errors must not kill audio */ }
      return;
    }
    this.frames.push(frame);
    this.totalSamples += frame.length;
    this.silenceMs = isSpeech ? 0 : this.silenceMs + frameMs;
    if (this.silenceMs >= this.silenceEndMs || this.totalSamples >= this.maxSamples) this.flush();
  }

  flush() {
    if (!this.inSpeech) return;
    this.inSpeech = false;
    this.speechStreak = 0;
    this.silenceMs = 0;
    const frames = this.frames;
    this.frames = [];
    this.preRoll = [];
    if (this.totalSamples < this.minSamples) { this.totalSamples = 0; return; }
    const joined = new Float32Array(this.totalSamples);
    let offset = 0;
    for (const frame of frames) { joined.set(frame, offset); offset += frame.length; }
    this.totalSamples = 0;
    try { this.onUtterance(joined); } catch { /* ditto */ }
  }

  reset() {
    this.inSpeech = false;
    this.frames = [];
    this.preRoll = [];
    this.totalSamples = 0;
    this.silenceMs = 0;
    this.speechStreak = 0;
  }
}

/** Decode any TTS audio buffer (ogg/wav/mp3) to raw s16le 16 kHz PCM via ffmpeg stdin/stdout. */
export function decodeToPcm16k(audioBuffer, { timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1']);
    const chunks = [];
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} reject(new Error('ffmpeg PCM decode timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => {});
    child.on('error', (err) => { clearTimeout(timer); reject(new Error(`ffmpeg chahiye call audio ke liye: ${err.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const pcm = Buffer.concat(chunks);
      if (code === 0 && pcm.length) resolve(pcm);
      else reject(new Error(`ffmpeg PCM decode failed (${code}): ${stderr.slice(0, 200)}`));
    });
    child.stdin.end(audioBuffer);
  });
}

// ── engine discovery ─────────────────────────────────────────────────────────

function engineCandidates(config = {}) {
  const candidates = [];
  const add = (p) => { if (p) candidates.push(p); };
  add(config.voipEnginePath);
  const localShare = path.join(os.homedir(), '.local/share/observer-voip/baileys-caller');
  add(path.join(localShare, 'dist/index.mjs'));
  add(path.join(ROOT, 'node_modules/baileys-caller/dist/index.mjs'));
  return candidates;
}

/** Load the baileys-caller engine from node_modules or the observer-voip dir. */
export async function loadVoipEngine(config = {}) {
  try {
    const mod = await import('baileys-caller');
    if (mod?.VoipClient) return { mod, via: 'node_modules' };
  } catch { /* not installed as a package — try the file locations */ }
  for (const candidate of engineCandidates(config)) {
    const target = candidate.endsWith('.mjs') || candidate.endsWith('.js') ? candidate : path.join(candidate, 'dist/index.mjs');
    if (!fs.existsSync(target)) continue;
    const mod = await import(pathToFileURL(target).href);
    if (mod?.VoipClient) return { mod, via: target };
  }
  return null;
}

// ── the call centre ──────────────────────────────────────────────────────────

/**
 * createWaVoip({
 *   config, voice (voicecall engine), isOwnerJid(jid), sendToOwner(reply),
 *   transcribe?, loadEngine? (tests), log
 * })
 */
export function createWaVoip({
  config = {}, voice, isOwnerJid = () => false, sendToOwner = async () => {},
  learnOwnerLid = () => {}, transcribe = null, loadEngine = null,
  decodePcm = decodeToPcm16k, speakText = null, log = console,
}) {
  const doTranscribe = transcribe ?? ((buffer, mime) => transcribeAudio(config, buffer, mime, log));
  const doSpeak = speakText ?? ((text) => synthesize(text, config, log));
  const state = {
    client: null,
    engineMod: null,
    engineVia: null,
    connected: false,
    connecting: false,
    started: false,
    stopped: false,
    activeCall: null, // {call, sessionId, startedAt, turns}
    lastError: '',
    answeredAt: new Map(), // callId → ts (coordination with whatsapp.js fallback)
    lastAnsweredAnyAt: 0,
    // Owner "offer" events seen by the MESSAGING socket (whatsapp.js). They
    // carry callerPn even when this engine only sees an anonymous @lid —
    // the cross-check that stops owner calls being ignored as "unknown".
    recentOwnerOffers: [], // {callId, from, callerPn, at}
    reconnectTimer: null,
    reconnectDelayMs: Math.max(1_000, Number(config.waVoipReconnectMs) || 30_000),
    // Breadcrumb diary of the engine's last moves — surfaced via status()
    // (/api/voice, `voice doctor`, fallback message) so "call kyun nahi
    // utha" is answered by facts, not guesswork.
    events: [], // {at, kind, detail}
    stats: { answered: 0, missed: 0, rejectedNotOwner: 0, outbound: 0, reconnects: 0 },
  };

  function note(kind, detail = '') {
    state.events.push({ at: Date.now(), kind, detail: String(detail ?? '').slice(0, 160) });
    if (state.events.length > 16) state.events.splice(0, state.events.length - 16);
  }

  const enabled = () => Boolean(config.waCallAnswer);
  const linked = () => fs.existsSync(path.join(config.voipAuthDir || '', 'creds.json'));

  // One words for "call kyun nahi utha" — used by /call, /doctor and the
  // fallback message itself, so the owner always sees the exact failed step.
  function stageInfo() {
    if (!enabled()) return { stage: 'off', fix: 'bash scripts/observer.sh voice call-engine' };
    if (!state.engineVia && !state.engineMod) return { stage: 'engine-missing', fix: 'bash scripts/observer.sh voice call-engine' };
    if (state.connected) return { stage: 'ready', fix: '' };
    if (!linked()) return { stage: 'not-linked', fix: 'bash scripts/observer.sh voice link-voip' };
    return { stage: state.lastError ? 'connect-failed' : 'connecting', fix: 'bash scripts/observer.sh voice status' };
  }

  function status() {
    const { stage, fix } = stageInfo();
    return {
      enabled: enabled(),
      stage,
      fix,
      engine: state.engineVia ? 'baileys-caller' : null,
      engineVia: state.engineVia,
      linked: linked(),
      connected: state.connected,
      inCall: Boolean(state.activeCall),
      authDir: config.voipAuthDir,
      lastError: state.lastError || null,
      lastEvents: state.events.slice(-8),
      stats: { ...state.stats },
      hint: !enabled()
        ? 'WA_CALL_ANSWER=false — on karne ke liye: bash scripts/observer.sh voice call-engine'
        : stage === 'engine-missing'
          ? `VoIP engine nahi mila — install: ${ENGINE_INSTALL_HINT}`
          : stage === 'not-linked'
            ? 'VoIP device link nahi hua — bash scripts/observer.sh voice link-voip (QR scan, ek baar)'
            : state.connected ? 'ready' : 'connecting…',
    };
  }

  /** whatsapp.js noticed an owner call ringing (it sees callerPn reliably). */
  function noteOwnerCall({ callId = '', from = '', callerPn = '' } = {}) {
    const now = Date.now();
    state.recentOwnerOffers = state.recentOwnerOffers.filter((o) => now - o.at < 45_000);
    state.recentOwnerOffers.push({ callId: String(callId), from: String(from), callerPn: String(callerPn || ''), at: now });
    ensureConnected();
  }

  function sawOwnerOffer(withinMs = 35_000) {
    const now = Date.now();
    state.recentOwnerOffers = state.recentOwnerOffers.filter((o) => now - o.at < 45_000);
    return state.recentOwnerOffers.some((o) => now - o.at < withinMs);
  }

  /**
   * whatsapp.js fallback coordination: did the VoIP engine take this call?
   * Call ids differ between the two sockets, so (besides an id match) any
   * answer at/after the offer moment counts — never reject a live call.
   */
  function recentlyAnswered(callId, sinceTs = 0) {
    if (state.activeCall) return true;
    const now = Date.now();
    if (callId) {
      const ts = state.answeredAt.get(String(callId));
      if (ts && now - ts < 90_000) return true;
    }
    if (sinceTs && state.lastAnsweredAnyAt >= sinceTs - 2_000) return true;
    if (!sinceTs && state.lastAnsweredAnyAt && now - state.lastAnsweredAnyAt < 15_000) return true;
    return false;
  }
  const isHandlingCalls = () => enabled() && state.connected;

  async function feedSpeech(call, audioResult, conversation) {
    if (!audioResult?.buffer) return false;
    const pcm = await decodePcm(audioResult.buffer);
    if (conversation.ended) return false;
    conversation.speaking = true;
    const chunkBytes = 16000 * 2 / 5; // 200 ms slices at 16 kHz s16
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      if (conversation.ended) break;
      call.writeAudio?.(pcm.subarray(offset, offset + chunkBytes));
    }
    conversation.speakUntil = Date.now() + (pcm.length / (16000 * 2)) * 1000 + 250;
    return true;
  }

  /** Wire one live call object into the full conversation loop. */
  function attachConversation(call, { openingText = '' } = {}) {
    const sessionId = `wa-call-${call.callId || Date.now()}`;
    const conversation = {
      call, sessionId, startedAt: Date.now(), turns: 0,
      speaking: false, speakUntil: 0, ended: false, queue: [], processing: false,
      log: [], // {heard, spoken} — sent as a short transcript when the call ends
    };
    state.activeCall = conversation;
    state.answeredAt.set(String(call.callId || ''), Date.now());
    state.lastAnsweredAnyAt = Date.now();

    const maxMs = Math.max(60_000, (Number(config.waCallMaxMinutes) || 15) * 60_000);
    const maxTimer = setTimeout(() => {
      log.info?.('[wavoip] max call duration reached — hanging up');
      try { call.end('timeout'); } catch { /* already gone */ }
    }, maxMs);
    maxTimer.unref?.();

    const segmenter = new UtteranceSegmenter({
      silenceEndMs: Number(config.voiceSilenceEndMs) || 900,
      onSpeechStart: () => {
        // Barge-in: stop JARVIS mid-sentence the moment the owner speaks.
        if (conversation.speaking && Date.now() < conversation.speakUntil) {
          try { call.clearAudio?.(); } catch { /* engine without clear */ }
          conversation.speaking = false;
          voice?.interrupt?.(sessionId);
          log.info?.('[wavoip] barge-in — playback cleared');
        }
      },
      onUtterance: (samples) => {
        conversation.queue.push(samples);
        processQueue().catch((err) => log.warn?.(`[wavoip] utterance failed: ${err.message}`));
      },
    });

    async function processQueue() {
      if (conversation.processing || conversation.ended) return;
      conversation.processing = true;
      try {
        while (conversation.queue.length && !conversation.ended) {
          const samples = conversation.queue.shift();
          let heardText = '';
          try {
            const { text } = await doTranscribe(encodeWavS16(samples), 'audio/wav');
            heardText = String(text ?? '').trim();
          } catch (err) {
            log.warn?.(`[wavoip] transcription failed: ${err.message}`);
          }
          if (!heardText) continue;
          conversation.turns += 1;
          log.info?.(`[wa call] owner: ${heardText.slice(0, 120)}`);
          const result = await voice.say(sessionId, heardText, { source: 'whatsapp-call' });
          log.info?.(`[wa call] jarvis: ${String(result?.spoken ?? '').slice(0, 120)}`);
          conversation.log.push({ heard: heardText, spoken: String(result?.spoken ?? ''), text: String(result?.text ?? '') });
          // Media produced mid-call (screenshot, file) goes to the chat.
          const raw = result?.reply;
          if (raw && typeof raw === 'object' && (raw.image || raw.document || raw.video)) {
            sendToOwner({ ...raw, text: `📞 Call ke dauraan: ${heardText.slice(0, 120)}` }).catch(() => {});
          }
          await feedSpeech(call, result?.audio, conversation).catch((err) => {
            log.warn?.(`[wavoip] could not speak reply: ${err.message}`);
          });
          if (result?.ended) {
            const wait = Math.max(600, conversation.speakUntil - Date.now());
            setTimeout(() => { try { call.end('hangup'); } catch { /* done */ } }, Math.min(wait, 8000)).unref?.();
          }
        }
      } finally {
        conversation.processing = false;
      }
    }

    call.on?.('audio', (frame) => { if (!conversation.ended) segmenter.push(frame); });
    call.on?.('connected', async () => {
      note('call-connected', call.callId || '');
      log.info?.('[wavoip] call connected — JARVIS is live');
      try {
        const started = await voice.start('whatsapp-call', sessionId);
        await feedSpeech(call, started?.audio, conversation);
        if (openingText) {
          // Outbound/scheduled calls: openingText is what JARVIS ANNOUNCES
          // right after the greeting (e.g. the scheduled update) — then he
          // stays on the line for instructions like any other call.
          conversation.log.push({ heard: '(scheduled update)', spoken: openingText, text: openingText });
          try { await feedSpeech(call, await doSpeak(openingText), conversation); }
          catch (err) { log.warn?.(`[wavoip] opening announcement failed: ${err.message}`); }
        }
      } catch (err) {
        log.warn?.(`[wavoip] greeting failed: ${err.message}`);
      }
    });
    const onEnded = (reason) => {
      if (conversation.ended) return;
      conversation.ended = true;
      clearTimeout(maxTimer);
      segmenter.reset();
      voice?.end?.(sessionId);
      if (state.activeCall === conversation) state.activeCall = null;
      const seconds = Math.round((Date.now() - conversation.startedAt) / 1000);
      note('call-ended', `${reason} · ${seconds}s · ${conversation.turns} turn(s)`);
      log.info?.(`[wavoip] call ended (${reason}) after ${seconds}s, ${conversation.turns} turn(s)`);
      if (conversation.turns > 0 || conversation.log.length) {
        const lines = conversation.log.slice(-8).map((t) => `🎙️ _${t.heard.slice(0, 90)}_\n🤖 ${(t.text || t.spoken).slice(0, 220)}`);
        sendToOwner([
          `📞 *WhatsApp voice call khatm* — ${Math.floor(seconds / 60)}m ${seconds % 60}s · ${conversation.turns} baatein/command.`,
          ...lines,
          'Dobara kabhi bhi seedha call kar lena, Sir.',
        ].join('\n\n')).catch(() => {});
      }
    };
    call.on?.('ended', onEnded);
    call.on?.('error', (err) => { state.lastError = err?.message ?? String(err); onEnded('error'); });
    return conversation;
  }

  function handleIncoming(call, meta = {}) {
    const peerJid = meta.peerJid || call.peerJid || '';
    note('incoming', `${peerJid || 'unknown'}${meta.isVideo ? ' (video)' : ''}${meta.isGroup || call.isGroup ? ' (group)' : ''}`);
    log.info?.(`[wavoip] incoming WhatsApp call from ${peerJid || 'unknown'} (video=${Boolean(meta.isVideo)}, group=${Boolean(meta.isGroup)})`);
    if (meta.isGroup || call.isGroup) {
      note('rejected-group', peerJid);
      try { call.reject?.(); } catch { /* noop */ }
      return { acted: 'rejected-group' };
    }
    const ownerExtras = [meta.callerPn, meta.caller_pn, call.callerPn, call.caller_pn].filter(Boolean);
    let verified = Boolean(isOwnerJid(peerJid, ownerExtras));
    if (!verified && sawOwnerOffer()) {
      // The messaging socket saw THIS call arrive from the owner's verified
      // number (callerPn) a moment ago — this engine merely sees his @lid.
      // Same ringing call on another linked device: answer it, and remember
      // the LID so next time the direct check passes on its own.
      verified = true;
      state.stats.answeredViaOffer = (state.stats.answeredViaOffer ?? 0) + 1;
      if (String(peerJid).endsWith('@lid')) { try { learnOwnerLid(peerJid); } catch { /* cosmetic */ } }
      log.info?.('[wavoip] owner verified via live call-offer cross-check (LID)');
    }
    if (!verified) {
      // SECURITY: an unverified caller (including unknown LIDs) never gets an
      // auto-answered call into a PC that can run commands. Let it ring.
      note('ignored-not-owner', peerJid || 'unknown');
      state.stats.rejectedNotOwner += 1;
      state.stats.missed += 1;
      log.warn?.('[wavoip] not answering: caller is not the verified owner');
      sendToOwner('📞 Ek unknown number se agent number pe WhatsApp call aayi — maine answer nahi kiya (owner-only rule). Agar ye tum hi the, pehle WhatsApp pe ek message bhej do taaki tumhara LID map ho jaye, phir call karna.').catch(() => {});
      return { acted: 'ignored-not-owner' };
    }
    if (state.activeCall) {
      note('rejected-busy', peerJid);
      try { call.reject?.(); } catch { /* noop */ }
      sendToOwner('📞 Sir, ek call pehle se chal rahi hai — dusri call reject kar di.').catch(() => {});
      return { acted: 'rejected-busy' };
    }
    state.stats.answered += 1;
    note('answering', `${peerJid} — engine accept pipeline (~20s tak lag sakta hai)`);
    call.answer({ audioSource: STREAM_SOURCE, withMic: true });
    attachConversation(call);
    return { acted: 'answered' };
  }

  /** Place an outbound call to the owner and run the same conversation. */
  async function callOwner(openingText = '') {
    if (!state.client || !state.connected) throw new Error(status().hint || 'VoIP engine ready nahi hai');
    if (state.activeCall) throw new Error('Ek call pehle se chal rahi hai, Sir.');
    note('outbound', `calling owner ${config.ownerNumber}`);
    const call = await state.client.call(String(config.ownerNumber), { audioSource: STREAM_SOURCE, durationMs: 0 });
    state.stats.outbound += 1;
    attachConversation(call, { openingText });
    return { callId: call.callId };
  }

  // ── connection lifecycle: connect once NEVER worked in the real world ────
  // (a single failed/dropped handshake used to kill pickup until restart).
  // Fresh client per attempt + exponential backoff until it sticks.
  function scheduleReconnect() {
    if (state.stopped || !enabled() || state.reconnectTimer || state.activeCall) return;
    const wait = state.reconnectDelayMs;
    state.reconnectDelayMs = Math.min(wait * 2, 300_000);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      state.stats.reconnects += 1;
      attemptConnect().catch(() => {});
    }, wait);
    state.reconnectTimer.unref?.();
    log.info?.(`[wavoip] reconnect ${Math.round(wait / 1000)}s me try karega…`);
  }

  /** Nudge used when an owner call is ringing: reconnect NOW, not at backoff. */
  function ensureConnected() {
    if (!enabled() || state.stopped || state.connected || state.connecting || !state.engineMod) return;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    attemptConnect().catch(() => {});
  }

  async function attemptConnect() {
    if (state.connecting || state.connected || state.stopped || !state.engineMod) return status();
    state.connecting = true;
    note('connect:start');
    try {
      try { state.client?.disconnect?.(); } catch { /* stale client */ }
      fs.mkdirSync(config.voipAuthDir, { recursive: true });
      // Surface the WASM's own accept/reject reasoning in the journal
      // ([voip-wasm:…] lines, keyword-filtered by the library). Without
      // this an inbound offer can be silently dropped by preprocess_offer
      // (privacy/expiry) and nobody can tell why. WA_VOIP_DEBUG=false → off.
      if (!process.env.VOIP_WASM_LOG) {
        if (config.waVoipLogLevel === '2') process.env.VOIP_WASM_LOG = '2';
        else if (config.waVoipDebug !== false) process.env.VOIP_WASM_LOG = '1';
      }
      const client = new state.engineMod.VoipClient({ authDir: config.voipAuthDir });
      state.client = client;
      client.on?.('incoming', (call, meta) => {
        try { handleIncoming(call, meta ?? {}); } catch (err) { log.error?.(`[wavoip] incoming handling failed: ${err.message}`); }
      });
      // IMPORTANT: the library emits 'error' for PER-CALL failures too
      // (offer decryption, accept problems) — not just dead sockets. An
      // earlier version treated every 'error' as connection death and
      // tore the client down mid-answer, killing the very call being set
      // up. Errors are diary entries now; only connect() failing (or
      // stop()) changes connection state.
      client.on?.('error', (err) => {
        if (state.stopped) return;
        state.lastError = err?.message ?? String(err);
        note('engine-error', state.lastError);
        log.warn?.(`[wavoip] engine error (call-level ho sakti hai, connection NAHI toda): ${state.lastError}`);
      });
      log.info?.(`[wavoip] connecting VoIP linked device (auth: ${config.voipAuthDir})…`);
      await client.connect();
      if (state.stopped) return status();
      state.connected = true;
      state.lastError = '';
      note('connect:ok', 'WASM VoIP stack ready');
      state.reconnectDelayMs = Math.max(1_000, Number(config.waVoipReconnectMs) || 30_000);
      log.info?.('[wavoip] ✅ VoIP device connected — WhatsApp calls ab JARVIS uthayega');
    } catch (err) {
      state.connected = false;
      state.lastError = err.message;
      note('connect:fail', err.message);
      log.error?.(`[wavoip] connect failed: ${err.message} (fallback voice session active rahega)`);
      scheduleReconnect();
    } finally {
      state.connecting = false;
    }
    return status();
  }

  async function start() {
    if (!enabled()) { log.info?.('[wavoip] WhatsApp call answering is OFF (WA_CALL_ANSWER=false) — fallback voice session active rahega'); return status(); }
    if (state.started) return status();
    state.started = true;
    state.stopped = false;
    try {
      const loaded = loadEngine ? await loadEngine(config) : await loadVoipEngine(config);
      if (!loaded?.mod?.VoipClient) {
        state.lastError = 'baileys-caller engine not installed';
        log.warn?.(`[wavoip] WA_CALL_ANSWER=true hai par VoIP engine nahi mila. Install: ${ENGINE_INSTALL_HINT} — tab tak calls voice-session fallback pe jayengi.`);
        return status();
      }
      state.engineMod = loaded.mod;
      state.engineVia = loaded.via || 'baileys-caller';
      // Do not block the whole agent on the VoIP handshake/QR.
      attemptConnect().catch(() => {});
      return status();
    } catch (err) {
      state.lastError = err.message;
      log.error?.(`[wavoip] start failed: ${err.message}`);
      return status();
    }
  }

  function stop() {
    state.stopped = true;
    if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
    try { state.activeCall?.call?.end?.('hangup'); } catch { /* noop */ }
    try { state.client?.disconnect?.(); } catch { /* noop */ }
    state.connected = false;
    state.activeCall = null;
  }

  return { start, stop, status, handleIncoming, callOwner, attachConversation, recentlyAnswered, isHandlingCalls, noteOwnerCall, ensureConnected };
}
