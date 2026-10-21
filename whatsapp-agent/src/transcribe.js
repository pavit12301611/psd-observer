// transcribe.js — speech → text, for free. Feeds BOTH WhatsApp voice notes
// and the live call (src/wavoip.js / phone-app call upload).
//
// Priority (privacy first, matching the rest of the agent):
//   1. Local whisper.cpp (`whisper-cli`) or Python `whisper` — offline, ₹0.
//      Setup in one command:  bash scripts/observer.sh voice whisper
//   2. Groq free-tier Whisper (same free key as the chat brain).
//
// BUG FIXED in 3.0: the old code handed WhatsApp's .ogg/opus straight to
// whisper.cpp, which only accepts 16 kHz mono WAV — local transcription
// therefore *never* worked and silently fell back to the cloud. Everything
// is now converted with ffmpeg first (when available).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findBin } from './pccontrol.js';

const execFileAsync = promisify(execFile);
const HINT = '🎙️ Voice samajhne ke liye ek free transcriber chahiye. Easiest offline: `bash scripts/observer.sh voice whisper` (whisper.cpp + model, ek baar). Ya GROQ_API_KEY (free tier) .env me daalo — phir restart.';

const extFor = (mimetype) => ({
  'audio/ogg': 'ogg', 'audio/opus': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/webm': 'webm',
}[String(mimetype ?? '').split(';')[0]] ?? 'ogg');

/** The local whisper binary + which CLI shape it speaks, or null. */
export function localWhisperTool(config = {}) {
  const candidates = [config.whisperBin, process.env.WHISPER_BIN].filter(Boolean);
  for (const name of ['whisper-cli', 'whisper-cpp', 'main', 'whisper']) {
    const bin = findBin(name);
    if (bin) candidates.push(bin);
  }
  // whisper.cpp built by observer.sh lives here even when not on PATH.
  candidates.push(path.join(os.homedir(), '.local/share/observer-voice/whisper.cpp/build/bin/whisper-cli'));
  for (const bin of candidates) {
    if (!bin || (bin.includes('/') && !fs.existsSync(bin))) continue;
    const base = path.basename(bin);
    // Python `whisper` (openai-whisper) has a completely different CLI from
    // whisper.cpp and takes a model *name*, not a .bin path. Keep them apart.
    if (base === 'whisper') return { bin, kind: 'python' };
    return { bin, kind: 'cpp' };
  }
  return null;
}

/** Auto-find the whisper.cpp model installed by observer.sh, if any. */
export function localWhisperModel(config = {}) {
  if (config.whisperModel) return config.whisperModel;
  const dir = path.join(os.homedir(), '.local/share/observer-voice/whisper.cpp/models');
  for (const name of ['ggml-base.bin', 'ggml-small.bin', 'ggml-tiny.bin', 'ggml-medium.bin']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return '';
}

/** Convert any audio buffer to the 16 kHz mono WAV local whisper demands. */
async function toWav16k(buffer, mimetype, workDir) {
  const ext = extFor(mimetype);
  const input = path.join(workDir, `in.${ext}`);
  fs.writeFileSync(input, buffer);
  if (ext === 'wav') return input; // already wav (call PCM path encodes 16 kHz)
  const ffmpeg = findBin('ffmpeg');
  if (!ffmpeg) return input; // best effort: python whisper can decode most formats itself
  const output = path.join(workDir, 'out.wav');
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-f', 'wav', output], { timeout: 60_000 });
  return output;
}

async function localWhisper(config, buffer, mimetype) {
  const tool = localWhisperTool(config);
  if (!tool) return null;
  const model = tool.kind === 'cpp' ? localWhisperModel(config) : (config.whisperModelPy || 'base');
  if (tool.kind === 'cpp' && !model) return null;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-whisper-'));
  try {
    const wav = await toWav16k(buffer, mimetype, workDir);
    if (tool.kind === 'cpp') {
      const stem = path.join(workDir, 'transcript');
      const args = ['-m', model, '-f', wav, '-otxt', '-of', stem, '--no-prints'];
      if (config.whisperLanguage && config.whisperLanguage !== 'auto') args.push('-l', config.whisperLanguage);
      await execFileAsync(tool.bin, args, { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
      return fs.readFileSync(`${stem}.txt`, 'utf8').trim() || null;
    }
    const args = [wav, '--model', model, '--output_format', 'txt', '--output_dir', workDir, '--fp16', 'False'];
    if (config.whisperLanguage && config.whisperLanguage !== 'auto') args.push('--language', config.whisperLanguage);
    await execFileAsync(tool.bin, args, { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    const out = fs.readdirSync(workDir).find((name) => name.endsWith('.txt'));
    return out ? fs.readFileSync(path.join(workDir, out), 'utf8').trim() || null : null;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

async function groqWhisper(config, buffer, mimetype) {
  if (!config.groqApiKey) return null;
  if (buffer.length > 25 * 1024 * 1024) throw new Error('audio is over Groq\'s 25 MB free-tier limit');
  const ext = extFor(mimetype);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/ogg' }), `voice.${ext}`);
  form.append('model', config.whisperModelGroq || 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  // A Hinglish prompt measurably improves mixed Hindi+English recognition.
  form.append('prompt', 'Ye Hinglish/English voice command hai ek PC assistant ke liye: chrome kholo, screenshot bhej do, volume kam karo, wifi off, JARVIS.');
  if (config.whisperLanguage && config.whisperLanguage !== 'auto') form.append('language', config.whisperLanguage);
  const res = await fetch(`${config.groqBaseUrl || 'https://api.groq.com/openai/v1'}/audio/transcriptions`, {
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
  // Local first: private, offline, free. Cloud is the fallback, not the default.
  try {
    const text = await localWhisper(config, buffer, mimetype);
    if (text) return { text, provider: 'whisper (local, offline)' };
  } catch (err) {
    errors.push(`local whisper: ${err.message}`);
    log.warn?.(`[voice] local whisper failed: ${err.message}`);
  }
  if (config.groqApiKey) {
    try {
      const text = await groqWhisper(config, buffer, mimetype);
      if (text) return { text, provider: 'Groq Whisper (free tier)' };
    } catch (err) {
      errors.push(`Groq: ${err.message}`);
      log.warn?.(`[voice] Groq transcription failed: ${err.message}`);
    }
  }
  throw new Error(errors.length ? `${HINT}\n\n_${errors[0]}_` : HINT);
}

export function transcriptionAvailable(config) {
  const tool = localWhisperTool(config);
  return Boolean(config.groqApiKey || (tool && (tool.kind === 'python' || localWhisperModel(config))));
}
