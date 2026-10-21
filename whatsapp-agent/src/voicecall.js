// voicecall.js — ONE conversation engine for every voice surface.
//
// Three very different transports feed the same brain:
//   • a real WhatsApp voice call answered in-process (src/wavoip.js)
//   • the phone app's 📞 Call tab (browser mic → /api/call/*)
//   • plain WhatsApp voice notes (transcribed in whatsapp.js)
//
// Pipeline for every utterance:
//   raw STT text
//     → normalizeSpokenText()      Hindi/Devanagari + mis-hearings + digits
//     → local call controls        "ruko", "dobara bolo", goodbye, haan/nahi
//                                  (never sent to an AI — instant, reliable)
//     → splitSpokenCommands()      "chrome kholo aur screenshot bhej do"
//                                  = TWO commands, executed in order, free
//     → runText()                  the full agent: offline intents → API
//                                  models with tools → DeepSeek Harness auto
//     → spokenSummary()            WhatsApp text becomes say-able English
//     → speak()                    JARVIS TTS (Piper/Edge/XTTS/espeak)
//
// Destructive actions keep the exact same safety gate as typed chat: the
// action is parked, JARVIS asks "Shall I proceed, Sir?", and only a spoken
// "haan/yes" runs it. Nothing about being on a call lowers the bar.

import crypto from 'node:crypto';
import { parseIntent } from './nlp.js';
import {
  jarvisGreeting, jarvisFarewell, spokenSummary, normalizeSpokenText,
  isEndCallPhrase, isStopPhrase, isRepeatPhrase, isAffirmPhrase, isDenyPhrase,
} from './jarvis.js';

const CHAIN_SPLIT = /\s+(?:aur|phir|fir|uske\s+baad|iske\s+baad|and\s+then|then|aur\s+phir)\s+/i;

/**
 * "volume 50 karo aur screenshot bhej do" → two runnable commands.
 * Only chains when EVERY part is independently executable offline (a slash
 * command or a known intent). Anything fuzzier returns [whole] so the API
 * model's multi-step tool loop plans it instead of us guessing wrongly.
 */
export function splitSpokenCommands(text) {
  const clean = String(text ?? '').trim();
  if (!clean || clean.startsWith('/') || clean.includes('?')) return [clean].filter(Boolean);
  const parts = clean.split(CHAIN_SPLIT).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return [clean];
  const runnable = parts.every((part) => part.startsWith('/') || parseIntent(part) !== null);
  return runnable ? parts : [clean];
}

/** Flatten any agent reply ({text,image,…} | string | null) for voice use. */
export function replyParts(reply) {
  if (reply == null) return { text: '', images: [], audio: null, mimetype: null, raw: reply };
  if (typeof reply === 'string') return { text: reply, images: [], audio: null, mimetype: null, raw: reply };
  const images = [];
  if (reply.image) images.push(reply.image);
  for (const extra of reply.extraImages ?? []) images.push(extra);
  return {
    text: reply.text ?? '',
    images,
    audio: reply.audio ?? null,
    mimetype: reply.mimetype ?? null,
    ptt: reply.ptt,
    document: reply.document ?? null,
    video: reply.video ?? null,
    raw: reply,
  };
}

/**
 * Create the engine.
 *   runText(text)   → agent reply (in production: agent.handle with voice ctx)
 *   speak(text)     → {buffer,mimetype,ext,engine} | null (JARVIS TTS)
 *   hasPending()    → a destructive action is parked awaiting haan/nahi
 *   stopAll()       → invoked for "ruko/stop" (runText('/stop') works too)
 */
export function createVoiceCall({ config = {}, runText, speak = null, hasPending = () => false, stopAll = null, log = console }) {
  if (typeof runText !== 'function') throw new Error('createVoiceCall needs runText(text)');
  const sessions = new Map();

  async function safeSpeak(text) {
    if (!text || typeof speak !== 'function') return null;
    try { return await speak(text); } catch (err) {
      log.warn?.(`[voicecall] TTS failed: ${err.message}`);
      return null;
    }
  }

  function emit(session, type, data = {}) {
    const event = { type, ts: Date.now(), sessionId: session.id, state: session.state, ...data };
    for (const listener of session.listeners) {
      try { listener(event); } catch { /* a broken SSE client must not kill the call */ }
    }
  }

  function createSession(source = 'app', id = null) {
    const session = {
      id: id ?? crypto.randomUUID(),
      source,
      state: 'listening', // listening | thinking | speaking | confirming | ended
      startedAt: Date.now(),
      turns: 0,
      lastSpoken: '',
      lastHeard: '',
      awaitingConfirm: false,
      speaking: false,
      interrupted: false,
      transcript: [], // [{who:'owner'|'jarvis', text, ts}]
      listeners: new Set(),
    };
    sessions.set(session.id, session);
    return session;
  }

  function getOrCreate(sessionId, source = 'app') {
    if (sessionId && sessions.has(sessionId)) {
      const session = sessions.get(sessionId);
      if (session.state !== 'ended') return session;
    }
    return createSession(source, sessionId || undefined);
  }

  /** Start (or fetch) a call. Returns the greeting + its JARVIS audio. */
// eslint-disable-next-line no-unused-vars
  async function start(source = 'app', sessionId = null) {
    const session = getOrCreate(sessionId, source);
    const greeting = jarvisGreeting(config);
    session.lastSpoken = greeting;
    session.transcript.push({ who: 'jarvis', text: greeting, ts: Date.now() });
    emit(session, 'started', { text: greeting });
    const audio = await safeSpeak(greeting);
    return { sessionId: session.id, greeting, spoken: greeting, audio, state: session.state, source: session.source };
  }

  function finishResult(session, { text = '', reply = null, heard = '' } = {}) {
    const parts = replyParts(reply ?? text);
    const fullText = parts.text || text;
    let spoken = spokenSummary(reply ?? fullText, config);
    session.awaitingConfirm = Boolean(hasPending());
    if (session.awaitingConfirm) {
      session.state = 'confirming';
      // The parked text bubble reads "⚠️ *Confirm:* Close chrome… Reply haan…" —
      // in the call JARVIS asks it properly instead of reading markup aloud.
      if (!/shall I proceed/i.test(spoken)) {
        const ask = spoken
          .replace(/^⚠️?\s*\*?confirm\*?:?\s*/i, '')
          .split(/(?<=[.?!])\s+/)[0]
          .replace(/reply\s+(haan|yes)\b.*$/i, '')
          .replace(/[.?\s]+$/, '')
          .trim();
        spoken = `${ask ? `${ask}. ` : ''}Shall I proceed, ${config.jarvisAddress || 'Sir'}?`;
      }
    } else {
      session.state = 'listening';
    }
    session.lastSpoken = spoken;
    if (heard) session.lastHeard = heard;
    session.transcript.push({ who: 'jarvis', text: spoken, ts: Date.now() });
    return { parts, fullText, spoken };
  }

  /** Run one already-transcribed utterance through the whole pipeline. */
  async function say(sessionId, rawText, { source = 'app' } = {}) {
    const session = getOrCreate(sessionId, source);
    const heard = normalizeSpokenText(rawText);
    const base = { ok: true, sessionId: session.id, source: session.source, heard, turn: session.turns + 1 };
    if (!heard) {
      const spoken = `I beg your pardon, ${config.jarvisAddress || 'Sir'}? I did not quite catch that.`;
      session.lastSpoken = spoken;
      return { ...base, state: session.state, text: '', spoken, audio: await safeSpeak(spoken), images: [] };
    }
    session.turns += 1;
    session.lastHeard = heard;
    session.transcript.push({ who: 'owner', text: heard, ts: Date.now() });
    emit(session, 'heard', { text: heard });

    // ── local call controls (no AI, no queue) ──────────────────────────────
    if (isEndCallPhrase(heard)) {
      const farewell = jarvisFarewell(config);
      session.lastSpoken = farewell;
      session.transcript.push({ who: 'jarvis', text: farewell, ts: Date.now() });
      const audio = await safeSpeak(farewell);
      end(session.id);
      return { ...base, state: 'ended', ended: true, text: farewell, spoken: farewell, audio, images: [] };
    }
    if (isRepeatPhrase(heard) && session.lastSpoken) {
      const spoken = session.lastSpoken;
      return { ...base, state: session.state, text: '', spoken, audio: await safeSpeak(spoken), images: [], repeated: true };
    }
    if (isStopPhrase(heard) && !session.awaitingConfirm) {
      session.state = 'thinking';
      emit(session, 'thinking', { text: heard });
      const reply = stopAll ? await stopAll() : await runText('/stop');
      const { parts, fullText } = finishResult(session, { reply, heard });
      const spoken = `Stopped, ${config.jarvisAddress || 'Sir'}.`;
      session.lastSpoken = spoken;
      emit(session, 'reply', { text: fullText, spoken });
      return { ...base, state: session.state, text: fullText, spoken, audio: await safeSpeak(spoken), images: parts.images, reply: parts.raw };
    }
    if (session.awaitingConfirm && isAffirmPhrase(heard)) {
      return runAndSpeak(session, base, 'haan', heard);
    }
    if (session.awaitingConfirm && isDenyPhrase(heard)) {
      return runAndSpeak(session, base, 'nahi', heard);
    }
    if (session.awaitingConfirm) {
      // Something else was said while a destructive action is parked: treat it
      // as a fresh instruction ONLY if it clearly is one; the parked action
      // stays parked (it expires on its own). Never auto-yes by accident.
      session.awaitingConfirm = false;
    }

    // ── multi-command chaining, then the full agent ────────────────────────
    const parts = splitSpokenCommands(heard);
    if (parts.length > 1) {
      session.state = 'thinking';
      emit(session, 'thinking', { text: heard, commands: parts });
      const texts = [];
      const images = [];
      let lastReply = null;
      for (const part of parts) {
        const reply = await runText(part);
        lastReply = reply;
        const flat = replyParts(reply);
        if (flat.text) texts.push(flat.text);
        images.push(...flat.images);
        if (hasPending()) break; // a destructive step parks — confirm before continuing the chain
      }
      const { fullText, spoken } = finishResult(session, { text: texts.join('\n'), reply: lastReply, heard });
      emit(session, 'reply', { text: fullText, spoken, commands: parts });
      const audio = replyParts(lastReply).audio
        ? { buffer: replyParts(lastReply).audio, mimetype: replyParts(lastReply).mimetype }
        : await safeSpeak(spoken);
      return { ...base, state: session.state, text: fullText, spoken, audio, images, commands: parts, reply: lastReply };
    }
    return runAndSpeak(session, base, heard, heard);
  }

  async function runAndSpeak(session, base, textToRun, heard) {
    session.state = 'thinking';
    emit(session, 'thinking', { text: heard });
    const reply = await runText(textToRun);
    const { parts, fullText, spoken } = finishResult(session, { reply, heard });
    emit(session, 'reply', { text: fullText, spoken });
    const audio = parts.audio
      ? { buffer: parts.audio, mimetype: parts.mimetype, ext: (parts.mimetype || '').includes('wav') ? 'wav' : 'ogg', engine: 'reply' }
      : await safeSpeak(spoken);
    return {
      ...base, state: session.state, text: fullText, spoken, audio,
      images: parts.images, document: parts.document, reply: parts.raw,
      awaitingConfirm: session.awaitingConfirm,
    };
  }

  /** Barge-in: the owner started talking over JARVIS. Playback stops client-side. */
  function interrupt(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.interrupted = true;
    session.speaking = false;
    if (session.state === 'speaking') session.state = 'listening';
    emit(session, 'interrupted');
    return true;
  }

  function end(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    session.state = 'ended';
    emit(session, 'ended');
    session.listeners.clear();
    sessions.delete(sessionId);
    return true;
  }

  function on(sessionId, listener) {
    const session = getOrCreate(sessionId);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  function sessionInfo(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return null;
    return {
      id: s.id, source: s.source, state: s.state, turns: s.turns,
      startedAt: s.startedAt, lastHeard: s.lastHeard, lastSpoken: s.lastSpoken,
      transcript: s.transcript.slice(-40),
    };
  }

  /**
   * WhatsApp voice notes run through the same pipeline with a persistent
   * "whatsapp" session, so "chrome band karo" → (confirm park) → next voice
   * note "haan" completes the same safety flow as on a live call.
   */
  async function sayWhatsApp(text) {
    return say('whatsapp', text, { source: 'whatsapp' });
  }

  return {
    start, say, sayWhatsApp, interrupt, end, on, sessionInfo,
    get activeSessions() { return sessions.size; },
    splitSpokenCommands,
  };
}
