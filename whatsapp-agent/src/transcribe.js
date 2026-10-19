// transcribe.js — voice notes → text, for free.
//
// Priority:
//   1. Local whisper.cpp (offline, private, costs nothing). Set WHISPER_BIN +
//      WHISPER_MODEL, e.g. ~/.local/share/whisper.cpp/models/ggml-base.bin
//   2. Groq free-tier Whisper (only if GROQ_API_KEY is set — same free key as
//      the chat brain). Fast, no local model needed.
//   3. Nothing: the agent says exactly how to enable it and keeps working.
//
// Once transcribed, a voice note behaves exactly like a typed message, so
// "chrome kholo" spoken into WhatsApp opens Chrome.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findBin } from './pccontrol.js';

const execFileAsync = promisify(execFile);
const HINT = '🎙️ Voice notes need a free transcriber. Easiest: set GROQ_API_KEY (free tier) in whatsapp-agent/.env — or install whisper.cpp locally and set WHISPER_BIN + WHISPER_MODEL, then restart.';

const extFor = (mimetype) => ({
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/aac': 'aac', 'audio/webm': 'webm',
}[String(mimetype ?? '').split(';')[0]] ?? 'ogg');

function localWhisperBin(config) {
  if (config.whisperBin) return config.whisperBin;
  if (process.env.WHISPER_BIN) return process.env.WHISPER_BIN;
  for (const name of ['whisper-cli', 'whisper-cpp', 'whisper']) {
    const bin = findBin(name);
    if (bin) return bin;
  }
  return null;
}

async function localWhisper(config, buffer, mimetype) {
  const bin = localWhisperBin(config);
  if (!bin || !config.whisperModel) return null;
  const ext = extFor(mimetype);
  const input = path.join(os.tmpdir(), `observer-voice-${Date.now()}.${ext}`);
  const stem = input.replace(/\.[^.]+$/, '');
  try {
    fs.writeFileSync(input, buffer);
    const args = ['-m', config.whisperModel, '-f', input, '-otxt', '-of', stem, '--no-prints'];
    if (config.whisperLanguage && config.whisperLanguage !== 'auto') args.push('-l', config.whisperLanguage);
    await execFileAsync(bin, args, { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    const text = fs.readFileSync(`${stem}.txt`, 'utf8').trim();
    return text || null;
  } finally {
    try { fs.unlinkSync(input); } catch { /* noop */ }
    try { fs.unlinkSync(`${stem}.txt`); } catch { /* noop */ }
  }
}

async function groqWhisper(config, buffer, mimetype) {
  if (!config.groqApiKey) return null;
  const ext = extFor(mimetype);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/ogg' }), `voice.${ext}`);
  form.append('model', config.whisperModelGroq || 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  if (config.whisperLanguage && config.whisperLanguage !== 'auto') form.append('language', config.whisperLanguage);
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${config.groqApiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Groq transcription said ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = await res.json();
  return (data.text ?? '').trim() || null;
}

/** Returns { text, provider } or throws with a helpful message. */
export async function transcribeAudio(config, buffer, mimetype = 'audio/ogg', log = console) {
  if (!buffer?.length) throw new Error('empty audio');
  const errors = [];
  if (config.groqApiKey) {
    try {
      const text = await groqWhisper(config, buffer, mimetype);
      if (text) return { text, provider: 'Groq Whisper (free tier)' };
    } catch (err) {
      errors.push(`Groq: ${err.message}`);
      log.warn?.(`[voice] Groq transcription failed: ${err.message}`);
    }
  }
  try {
    const text = await localWhisper(config, buffer, mimetype);
    if (text) return { text, provider: 'whisper.cpp (local)' };
  } catch (err) {
    errors.push(`local whisper: ${err.message}`);
    log.warn?.(`[voice] local whisper failed: ${err.message}`);
  }
  throw new Error(errors.length ? `${HINT}\n\n_${errors[0]}_` : HINT);
}

export function transcriptionAvailable(config) {
  return Boolean(config.groqApiKey || (localWhisperBin(config) && config.whisperModel));
}
