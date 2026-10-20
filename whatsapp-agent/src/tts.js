// tts.js — free offline Text-To-Speech for /voicereply
// Only runs when owner explicitly asks /voicereply <text>. No auto-voice.
// Engines (auto-detected, zero npm deps):
//   1. espeak-ng / espeak  (Fedora: sudo dnf install espeak-ng)
//   2. pico2wave            (Fedora: sudo dnf install pico2wave / libttspico)
//   3. piper               (https://github.com/rhasspy/piper) if PIPER_BIN + PIPER_MODEL set
// All produce WAV, then optionally ffmpeg converts to opus/ogg for WhatsApp voice notes.
// Without ffmpeg we still send WAV as audio — WhatsApp plays it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function hasBin(name) {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, [name], { encoding: 'utf8', timeout: 2000 });
    return Boolean(out.trim());
  } catch {
    return fs.existsSync(`/usr/bin/${name}`) || fs.existsSync(`/usr/local/bin/${name}`) || fs.existsSync(`/bin/${name}`);
  }
}

let cachedEngine = null;

export function detectTTSEngine(config = {}) {
  if (cachedEngine) return cachedEngine;
  const forced = String(config.ttsEngine ?? 'auto').toLowerCase();
  if (forced !== 'auto' && forced !== '') {
    cachedEngine = { name: forced, bin: forced === 'piper' ? (config.piperBin || 'piper') : forced };
    return cachedEngine;
  }
  if (config.piperBin && fs.existsSync(config.piperBin)) {
    cachedEngine = { name: 'piper', bin: config.piperBin };
    return cachedEngine;
  }
  if (hasBin('espeak-ng')) return cachedEngine = { name: 'espeak-ng', bin: 'espeak-ng' };
  if (hasBin('espeak')) return cachedEngine = { name: 'espeak', bin: 'espeak' };
  if (hasBin('pico2wave')) return cachedEngine = { name: 'pico2wave', bin: 'pico2wave' };
  if (hasBin('flite')) return cachedEngine = { name: 'flite', bin: 'flite' };
  if (hasBin('festival')) return cachedEngine = { name: 'festival', bin: 'festival' };
  if (hasBin('piper')) return cachedEngine = { name: 'piper', bin: 'piper' };
  return cachedEngine = null;
}

// ── voice presets — “special” = calm female, not robotic, not too fast ──────
const VOICE_PRESETS = {
  special: { voice: 'en+f3', speed: 130 }, // default: special calm voice, slightly slow (tez thi to thoda dheere)
  calm: { voice: 'en+f3', speed: 128 },
  female: { voice: 'en+f4', speed: 132 },
  soft: { voice: 'en+f3', speed: 125 },
  deep: { voice: 'en+m3', speed: 130 },    // deep male
  male: { voice: 'en+m3', speed: 133 },
  hindi: { voice: 'hi', speed: 130 },
  fast: { voice: 'en', speed: 150 },
  slow: { voice: 'en+f3', speed: 110 },
  whisper: { voice: 'en+whisper', speed: 130 },
};

function resolveVoicePreset(config, text) {
  let voice = config.ttsVoice || '';
  let speed = config.ttsSpeed ?? 135; // default now 135 (was 150 — tez thi)
  // if user set preset name like "special", expand it
  const presetKey = String(voice).toLowerCase();
  if (VOICE_PRESETS[presetKey]) {
    voice = VOICE_PRESETS[presetKey].voice;
    if (config.ttsSpeed == null) speed = VOICE_PRESETS[presetKey].speed; // use preset speed if not overridden
  }
  // auto per language if no explicit voice
  if (!voice) {
    voice = containsDevanagari(text) ? 'hi' : 'en+f3'; // special calm female default
  }
  // allow Hindi text to force hi even if English voice preset was set to en+f3 but text is Hindi
  // (user can override by setting TTS_VOICE=hi explicitly)
  if (containsDevanagari(text) && voice.startsWith('en')) {
    // if text is Hindi but voice is English preset, switch to hi for this utterance
    voice = 'hi';
  }
  return { voice, speed };
}

export function ttsStatus(config = {}) {
  const eng = detectTTSEngine(config);
  const ffmpeg = hasBin('ffmpeg');
  if (!eng) {
    return [
      '🔊 TTS not installed — voice reply needs a free offline engine.',
      'Install one (Fedora):',
      '  sudo dnf install espeak-ng ffmpeg   # recommended (Hindi+English, best compat)',
      'OR sudo dnf install flite',
      `ffmpeg: ${ffmpeg ? 'found ✅ (ogg voice notes)' : 'not found — WAV will be sent instead'}`,
      'After install, try: /voicereply namaste, kaise ho',
      `Config: TTS_ENGINE=${config.ttsEngine ?? 'auto'} TTS_VOICE=${config.ttsVoice ?? '(auto:special)'} TTS_SPEED=${config.ttsSpeed ?? 135}`,
      'Voices: special/calm/female/deep/male/hindi — set TTS_VOICE=special in .env',
    ].join('\n');
  }
  const { voice, speed } = resolveVoicePreset(config, '');
  return [
    `🔊 TTS ready: *${eng.name}* ${eng.bin ? `(${eng.bin})` : ''}`,
    `Voice: ${config.ttsVoice || 'special (en+f3)'} → ${voice} · Speed: ${speed} (default 135, tez thi to dheere kiya)`,
    `ffmpeg: ${ffmpeg ? 'found ✅ — voice notes as opus/ogg' : 'not found — WAV will be sent'}`,
    'Use: /voicereply <text> — e.g. /voicereply hello bhai, kaise ho',
    'Tip: /voicereply voice deep hello → deep male, /voicereply voice hindi namaste',
  ].join('\n');
}

function containsDevanagari(text) {
  return /[\u0900-\u097F]/.test(text);
}

function sanitizeForTTS(text) {
  let s = String(text ?? '').trim().slice(0, 600);
  if (!s) return '';
  s = s.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1')
       .replace(/\*([^*]+)\*/g, '$1').replace(/_([^_]+)_/g, '$1')
       .replace(/https?:\/\/\S+/g, ' link ')
       .replace(/\s+/g, ' ').trim();
  return s;
}

async function runEspeak(text, outWav, config) {
  const eng = detectTTSEngine(config);
  const bin = eng?.bin ?? 'espeak-ng';
  const { voice, speed } = resolveVoicePreset(config, text);
  // Try requested voice, fallback to plain en/hi if variant not installed
  const tryVoices = voice ? [voice, voice.split('+')[0], containsDevanagari(text) ? 'hi' : 'en'] : [containsDevanagari(text) ? 'hi' : 'en'];
  let lastErr = null;
  for (const v of [...new Set(tryVoices)]) {
    const args = [];
    if (v) args.push('-v', v);
    if (speed) args.push('-s', String(speed), '-p', '50'); // -p 50 = normal pitch, not squeaky
    args.push('-w', outWav, text);
    try {
      await execFileAsync(bin, args, { timeout: 15_000 });
      return outWav;
    } catch (e) {
      lastErr = e;
      // if voice not found, try next fallback
      if (/not found|voice/i.test(e.message)) continue;
      throw e;
    }
  }
  throw lastErr || new Error('espeak voice failed');
}

async function runPico2Wave(text, outWav, config) {
  const lang = config.ttsLang && config.ttsLang !== 'auto' ? config.ttsLang : (containsDevanagari(text) ? 'hi-IN' : 'en-US');
  const picoLang = lang.startsWith('hi') ? 'en-US' : lang;
  await execFileAsync('pico2wave', ['-w', outWav, '-l', picoLang, text], { timeout: 15_000 });
  return outWav;
}

async function runPiper(text, outWav, config) {
  const bin = config.piperBin || 'piper';
  const model = config.piperModel;
  if (!model) throw new Error('PIPER_MODEL not set — set PIPER_BIN and PIPER_MODEL in .env');
  await new Promise((resolve, reject) => {
    const child = spawn(bin, ['--model', model, '--output_file', outWav], { timeout: 15_000 });
    let stderr = '';
    child.stderr.on('data', (d) => stderr += d);
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`piper exit ${code}: ${stderr.slice(0, 500)}`)));
    child.stdin.write(text);
    child.stdin.end();
  });
  return outWav;
}

async function convertToOpus(inWav, outOgg) {
  if (!hasBin('ffmpeg')) return null;
  try {
    await execFileAsync('ffmpeg', ['-y', '-i', inWav, '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', outOgg], { timeout: 15_000 });
    return outOgg;
  } catch {
    return null;
  }
}

/**
 * Synthesize text to audio buffer for WhatsApp.
 * Returns { buffer, mimetype, ext, engine } or throws.
 */
export async function synthesize(text, config = {}, log = console) {
  // support inline voice override: "/voicereply voice deep hello" → voice=deep for this utterance
  let overrideVoice = null;
  let cleanRaw = String(text ?? '').trim();
  const voicePrefix = cleanRaw.match(/^(?:voice\s+(special|calm|female|soft|deep|male|hindi|fast|slow|whisper)\s+)([\s\S]+)$/i);
  if (voicePrefix) {
    overrideVoice = voicePrefix[1].toLowerCase();
    cleanRaw = voicePrefix[2];
  }
  const effectiveConfig = overrideVoice ? { ...config, ttsVoice: overrideVoice } : config;
  const clean = sanitizeForTTS(cleanRaw);
  if (!clean) throw new Error('Kuch likho toh voice banau — e.g. /voicereply hello');
  const eng = detectTTSEngine(effectiveConfig);
  if (!eng) throw new Error('TTS engine nahi mila. Install karo: sudo dnf install espeak-ng ffmpeg — phir /voicereply try karo');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  const wavPath = path.join(tmpDir, `tts-${crypto.randomBytes(4).toString('hex')}.wav`);
  const oggPath = wavPath.replace(/\.wav$/, '.ogg');

  try {
    if (eng.name === 'piper' || effectiveConfig.ttsEngine === 'piper') {
      await runPiper(clean, wavPath, effectiveConfig);
    } else if (eng.name === 'pico2wave') {
      await runPico2Wave(clean, wavPath, effectiveConfig);
    } else if (eng.name === 'espeak-ng' || eng.name === 'espeak') {
      await runEspeak(clean, wavPath, effectiveConfig);
    } else if (eng.name === 'flite') {
      await execFileAsync('flite', ['-t', clean, '-o', wavPath], { timeout: 15_000 });
    } else if (eng.name === 'festival') {
      // text2wave reads the text from stdin. Never go through `sh -c`: a "$(
      // … )" or a stray backtick in the message would be executed by the shell
      // (sanitizeForTTS strips balanced backticks, not command substitution).
      await new Promise((resolve, reject) => {
        const child = spawn('text2wave', ['-o', wavPath], { timeout: 15_000 });
        let err = '';
        child.stderr.on('data', d => err += d);
        child.on('error', reject);
        child.on('close', c => c === 0 ? resolve() : reject(new Error(`festival failed: ${err.slice(0,300)}`)));
        child.stdin.on('error', () => { /* the process may exit early */ });
        child.stdin.end(clean);
      });
    } else {
      throw new Error(`Unknown TTS engine ${eng.name}`);
    }

    if (!fs.existsSync(wavPath) || fs.statSync(wavPath).size < 100) {
      throw new Error('TTS produced no audio — text shayad unsupported hai');
    }

    const ogg = await convertToOpus(wavPath, oggPath);
    if (ogg && fs.existsSync(oggPath) && fs.statSync(oggPath).size > 100) {
      const buf = fs.readFileSync(oggPath);
      return { buffer: buf, mimetype: 'audio/ogg; codecs=opus', ext: 'ogg', engine: eng.name };
    }
    const buf = fs.readFileSync(wavPath);
    return { buffer: buf, mimetype: 'audio/wav', ext: 'wav', engine: eng.name };

  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// helper to clear cache in tests
export function __resetCache() { cachedEngine = null; }
export { VOICE_PRESETS };
