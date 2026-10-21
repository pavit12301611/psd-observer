// tts.js — the JARVIS voice. Text → speech, free, offline-first.
//
// WHAT WAS WRONG BEFORE (2.x): engine priority put espeak-ng FIRST — a 1980s
// formant synthesiser that sounds like a robot with a cold — and the neural
// engine (Piper) last, behind a manual PIPER_BIN/PIPER_MODEL most people never
// set. The default preset was also a female English voice. Nobody got JARVIS.
//
// NOW — engines are tried in this order, falling through on ANY failure:
//   1. xtts-clone   your own Coqui XTTS server + a reference clip (the only
//                   route to a true voice CLONE; see VOICE.md, XTTS_URL)
//   2. piper        neural, offline. en_GB-alan-medium / en_GB-ryan-high are
//                   the closest free voices to Paul Bettany's JARVIS.
//                   Auto-detected in ~/.local/share/observer-voice — install
//                   with one command:  bash observer.sh voice setup
//   3. edge-tts     Microsoft neural en-GB-RyanNeural via the free `edge-tts`
//                   CLI if present (needs internet; pip install edge-tts)
//   4. espeak-ng    last-resort robot, now with a proper en-G.B. JARVIS preset
//   5. pico2wave / flite / festival
// Every engine's output gets the same JARVIS polish (ffmpeg: warmth, presence,
// broadcast compression, a whisper of digital sheen, loudnorm) and becomes a
// true WhatsApp opus voice note. Text is ALWAYS passed as argv/stdin — never
// through a shell (see the security regression test).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { jarvisFxFilter, splitSentences, transliterateDevanagari } from './jarvis.js';

const execFileAsync = promisify(execFile);

function hasBin(name) {
  if (!name) return false;
  if (name.includes('/')) return fs.existsSync(name);
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(which, [name], { encoding: 'utf8', timeout: 2000 });
    return Boolean(out.trim());
  } catch {
    return fs.existsSync(`/usr/bin/${name}`) || fs.existsSync(`/usr/local/bin/${name}`) || fs.existsSync(`/bin/${name}`);
  }
}

// ── voice presets ────────────────────────────────────────────────────────────
// espeak fields (voice/speed/pitch) only matter for the espeak fallback; the
// piper/edge hints tell those engines which British voice "jarvis" means.
const VOICE_PRESETS = {
  jarvis: { voice: 'en-gb+m3', speed: 140, pitch: 34, gap: 6, edgeVoice: 'en-GB-RyanNeural', piperHint: 'en_GB-alan' },
  'jarvis-deep': { voice: 'en-gb+m1', speed: 132, pitch: 26, gap: 7, edgeVoice: 'en-GB-RyanNeural', piperHint: 'en_GB-ryan' },
  special: { voice: 'en+f3', speed: 130, pitch: 50 },
  calm: { voice: 'en+f3', speed: 128, pitch: 50 },
  female: { voice: 'en+f4', speed: 132, pitch: 50, edgeVoice: 'en-GB-SoniaNeural', piperHint: 'en_GB-cori' },
  soft: { voice: 'en+f3', speed: 125, pitch: 50 },
  deep: { voice: 'en+m3', speed: 130, pitch: 36 },
  male: { voice: 'en+m3', speed: 133, pitch: 44 },
  hindi: { voice: 'hi', speed: 130, pitch: 50 },
  fast: { voice: 'en-gb+m3', speed: 158, pitch: 38 },
  slow: { voice: 'en-gb+m3', speed: 116, pitch: 34 },
  whisper: { voice: 'en+whisper', speed: 130, pitch: 50 },
};

function resolvePreset(config, text) {
  const key = String(config.ttsVoice || 'jarvis').toLowerCase();
  const preset = VOICE_PRESETS[key] ?? { voice: config.ttsVoice || 'en-gb+m3', speed: 140, pitch: 40 };
  let voice = preset.voice || 'en-gb+m3';
  if (containsDevanagari(text) && !String(voice).startsWith('hi')) voice = 'hi';
  return {
    key: VOICE_PRESETS[key] ? key : 'custom',
    voice,
    speed: config.ttsSpeed ?? preset.speed ?? 140,
    pitch: preset.pitch ?? 40,
    gap: preset.gap ?? 0,
    edgeVoice: config.edgeTtsVoice || preset.edgeVoice || 'en-GB-RyanNeural',
    piperHint: preset.piperHint || 'en_GB-alan',
  };
}

// ── Piper auto-discovery ─────────────────────────────────────────────────────

function voiceDirs(config = {}) {
  const home = os.homedir();
  return [...new Set([
    config.voiceDir,
    path.join(home, '.local/share/observer-voice'),
    path.join(home, 'observer-voice'),
  ].filter(Boolean))];
}

/** Find a usable piper binary + model without any .env editing. */
export function resolvePiper(config = {}, piperHint = 'en_GB-alan') {
  const bins = [config.piperBin, ...voiceDirs(config).map((d) => path.join(d, 'piper', 'piper')), 'piper'].filter(Boolean);
  const bin = bins.find((b) => (b.includes('/') ? fs.existsSync(b) : hasBin(b))) ?? null;
  if (!bin) return null;

  let model = config.piperModel && fs.existsSync(config.piperModel) ? config.piperModel : null;
  if (!model) {
    const models = [];
    for (const dir of voiceDirs(config)) {
      for (const sub of ['models', '.']) {
        try {
          for (const name of fs.readdirSync(path.join(dir, sub))) {
            if (name.endsWith('.onnx')) models.push(path.join(dir, sub, name));
          }
        } catch { /* dir does not exist yet */ }
      }
    }
    const rank = (file) => {
      const name = path.basename(file).toLowerCase();
      if (name.includes(piperHint.toLowerCase())) return 0;
      if (name.startsWith('en_gb-alan')) return 1;
      if (name.startsWith('en_gb-ryan')) return 2;
      if (name.startsWith('en_gb')) return 3;
      if (name.startsWith('en_')) return 4;
      return 5;
    };
    models.sort((a, b) => rank(a) - rank(b));
    model = models[0] ?? null;
  }
  return model ? { bin, model } : null;
}

// ── engine detection (ordered, cached per-config) ────────────────────────────

let engineCache = { key: '', list: [] };

function engineListUncached(config = {}) {
  const preset = resolvePreset(config, '');
  const engines = [];
  if (config.xttsUrl) engines.push({ name: 'xtts-clone', label: `XTTS voice clone (${config.xttsUrl})` });
  const piper = resolvePiper(config, preset.piperHint);
  if (piper) engines.push({ name: 'piper', bin: piper.bin, model: piper.model, label: `Piper neural · ${path.basename(piper.model)}` });
  const edgeBin = config.edgeTtsBin || (hasBin('edge-tts') ? 'edge-tts' : hasBin('edge_tts') ? 'edge_tts' : null);
  if (edgeBin) engines.push({ name: 'edge-tts', bin: edgeBin, label: `Edge neural · ${preset.edgeVoice}` });
  if (hasBin('espeak-ng')) engines.push({ name: 'espeak-ng', bin: 'espeak-ng', label: 'espeak-ng (robotic fallback)' });
  else if (hasBin('espeak')) engines.push({ name: 'espeak', bin: 'espeak', label: 'espeak (robotic fallback)' });
  if (hasBin('pico2wave')) engines.push({ name: 'pico2wave', bin: 'pico2wave', label: 'pico2wave' });
  if (hasBin('flite')) engines.push({ name: 'flite', bin: 'flite', label: 'flite' });
  if (hasBin('text2wave')) engines.push({ name: 'festival', bin: 'text2wave', label: 'festival' });

  // A forced engine goes first; the rest stay as safety net, not a dead end.
  const forced = String(config.ttsEngine ?? 'auto').toLowerCase();
  if (forced && forced !== 'auto') {
    const wanted = forced === 'xtts' ? 'xtts-clone' : forced;
    const hit = engines.findIndex((e) => e.name === wanted);
    if (hit > 0) engines.unshift(engines.splice(hit, 1)[0]);
    if (hit === -1 && wanted === 'piper') engines.unshift({ name: 'piper', bin: config.piperBin || 'piper', model: config.piperModel || '', label: 'Piper (forced, not found yet)' });
  }
  return engines;
}

/** Ordered list of engines that can speak right now, best first. */
export function listTTSEngines(config = {}) {
  const key = JSON.stringify([config.ttsEngine, config.ttsVoice, config.piperBin, config.piperModel, config.xttsUrl, config.voiceDir, config.edgeTtsBin]);
  if (engineCache.key === key) return engineCache.list;
  const list = engineListUncached(config);
  engineCache = { key, list };
  return list;
}

/** Back-compat: the single best engine. */
export function detectTTSEngine(config = {}) {
  return listTTSEngines(config)[0] ?? null;
}

export function __resetCache() { engineCache = { key: '', list: [] }; phraseCache.clear(); }

// ── text preparation ─────────────────────────────────────────────────────────

const containsDevanagari = (text) => /[ऀ-ॿ]/.test(String(text ?? ''));

function sanitizeForTTS(text) {
  return String(text ?? '').trim()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/https?:\/\/\S+/g, ' link ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split long text into speakable chunks (sentence-aware, ≤limit chars each). */
function chunkForSpeech(text, limit = 350, maxChunks = 4) {
  const sentences = splitSentences(text);
  const chunks = [];
  let current = '';
  for (const sentence of sentences.length ? sentences : [text]) {
    if (current && current.length + sentence.length + 1 > limit) {
      chunks.push(current);
      current = sentence;
      if (chunks.length >= maxChunks) break;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current && chunks.length <= maxChunks) chunks.push(current);
  return chunks.slice(0, maxChunks + 1).map((c) => c.slice(0, limit * 1.4));
}

// ── one engine, one chunk → wav/mp3 file ─────────────────────────────────────

async function runEngine(engine, text, outBase, config) {
  const preset = resolvePreset(config, text);
  if (engine.name === 'piper') {
    const outWav = `${outBase}.wav`;
    const lengthScale = Number(config.piperLengthScale ?? 1.05) || 1.05; // measured, unhurried butler pace
    const args = [
      '--model', engine.model,
      '--output_file', outWav,
      '--length_scale', String(lengthScale),
      '--sentence_silence', '0.22',
      '--noise_scale', String(config.piperNoiseScale ?? 0.55),
      '--noise_w_scale', String(config.piperNoiseWScale ?? 0.7),
    ];
    await new Promise((resolve, reject) => {
      const child = spawn(engine.bin, args, { timeout: 30_000 });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.stdin.on('error', () => {});
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`piper exit ${code}: ${stderr.slice(0, 300)}`))));
      child.stdin.end(text);
    });
    return outWav;
  }
  if (engine.name === 'edge-tts') {
    const outMp3 = `${outBase}.mp3`;
    const voice = containsDevanagari(text) ? (config.edgeTtsVoiceHindi || 'hi-IN-MadhurNeural') : preset.edgeVoice;
    await execFileAsync(engine.bin, [
      '--voice', voice, '--rate=-4%', '--pitch=-4Hz',
      '--text', text, '--write-media', outMp3,
    ], { timeout: 45_000 });
    return outMp3;
  }
  if (engine.name === 'xtts-clone') {
    // daswer123/xtts-api-server shape: POST /tts_to_audio → wav bytes.
    const base = String(config.xttsUrl).replace(/\/$/, '');
    const res = await fetch(`${base}/tts_to_audio`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, speaker_wav: config.xttsSpeaker || 'jarvis.wav', language: containsDevanagari(text) ? 'hi' : 'en' }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`XTTS server said ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (type.includes('application/json')) throw new Error(`XTTS server returned JSON, not audio (check speaker_wav "${config.xttsSpeaker}")`);
    const outWav = `${outBase}.wav`;
    fs.writeFileSync(outWav, Buffer.from(await res.arrayBuffer()));
    return outWav;
  }
  if (engine.name === 'espeak-ng' || engine.name === 'espeak') {
    const outWav = `${outBase}.wav`;
    const tryVoices = [...new Set([preset.voice, preset.voice.split('+')[0], 'en-gb', containsDevanagari(text) ? 'hi' : 'en'])];
    let lastErr = null;
    for (const voice of tryVoices) {
      const args = ['-v', voice, '-s', String(preset.speed), '-p', String(preset.pitch)];
      if (preset.gap) args.push('-g', String(preset.gap));
      args.push('-w', outWav, text);
      try {
        await execFileAsync(engine.bin, args, { timeout: 20_000 });
        return outWav;
      } catch (err) {
        lastErr = err;
        if (!/not found|voice/i.test(err.message)) throw err;
      }
    }
    throw lastErr || new Error('espeak voice failed');
  }
  if (engine.name === 'pico2wave') {
    const outWav = `${outBase}.wav`;
    const lang = containsDevanagari(text) ? 'en-GB' : 'en-GB'; // pico has no Hindi; en-GB is its best voice
    await execFileAsync('pico2wave', ['-w', outWav, '-l', lang, text], { timeout: 20_000 });
    return outWav;
  }
  if (engine.name === 'flite') {
    const outWav = `${outBase}.wav`;
    await execFileAsync('flite', ['-t', text, '-o', outWav], { timeout: 20_000 });
    return outWav;
  }
  if (engine.name === 'festival') {
    const outWav = `${outBase}.wav`;
    // text2wave reads the text from stdin. Never go through a shell: a "$(…)"
    // or a stray backtick in the message would be executed by the shell.
    await new Promise((resolve, reject) => {
      const child = spawn('text2wave', ['-o', outWav], { timeout: 20_000 });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.stdin.on('error', () => {});
      child.on('error', reject);
      child.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`festival failed: ${err.slice(0, 300)}`))));
      child.stdin.end(text);
    });
    return outWav;
  }
  throw new Error(`Unknown TTS engine ${engine.name}`);
}

// ── ffmpeg: JARVIS polish + WhatsApp opus, one pass ──────────────────────────

async function polishToOpus(inputFiles, outOgg, config) {
  if (!hasBin('ffmpeg')) return null;
  const fx = jarvisFxFilter(config);
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  if (inputFiles.length > 1) {
    // Concat demuxer via a list file (paths are ours, generated in tmpdir).
    const listFile = `${outOgg}.txt`;
    fs.writeFileSync(listFile, inputFiles.map((f) => `file '${f.replace(/'/g, '')}'`).join('\n'));
    args.push('-f', 'concat', '-safe', '0', '-i', listFile);
  } else {
    args.push('-i', inputFiles[0]);
  }
  if (fx) args.push('-af', fx);
  args.push('-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-vbr', 'on', outOgg);
  try {
    await execFileAsync('ffmpeg', args, { timeout: 30_000 });
    return fs.existsSync(outOgg) && fs.statSync(outOgg).size > 100 ? outOgg : null;
  } catch {
    // Some ffmpeg builds lack an FX filter (loudnorm versions differ) — retry
    // without polish rather than failing the whole voice note.
    if (!fx) return null;
    try {
      const plain = args.filter((a, i) => a !== '-af' && args[i - 1] !== '-af');
      await execFileAsync('ffmpeg', plain, { timeout: 30_000 });
      return fs.existsSync(outOgg) && fs.statSync(outOgg).size > 100 ? outOgg : null;
    } catch { return null; }
  }
}

// ── phrase cache (greetings & acknowledgements must be instant on a call) ────

const phraseCache = new Map(); // hash → {buffer, mimetype, ext, engine}
const PHRASE_CACHE_MAX = 40;

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Synthesise text to an audio buffer, trying engines best-first.
 * Returns { buffer, mimetype, ext, engine } or throws with setup guidance.
 */
export async function synthesize(text, config = {}, log = console) {
  let cleanRaw = String(text ?? '').trim();
  // Inline override kept from 2.x: "/voicereply voice deep hello"
  const voicePrefix = cleanRaw.match(new RegExp(`^(?:voice\\s+(${Object.keys(VOICE_PRESETS).join('|')})\\s+)([\\s\\S]+)$`, 'i'));
  if (voicePrefix) {
    config = { ...config, ttsVoice: voicePrefix[1].toLowerCase() };
    cleanRaw = voicePrefix[2];
  }
  // JARVIS speaks English only (default): Devanagari becomes Roman so the
  // British neural voice is never forced to mangle Hindi script, and Hindi
  // TTS routing below is skipped entirely.
  const clean = sanitizeForTTS(config.jarvisEnglishOnly === false ? cleanRaw : transliterateDevanagari(cleanRaw));
  if (!clean) throw new Error('Kuch likho toh voice banau — e.g. /voicereply hello sir');

  const engines = listTTSEngines(config);
  if (!engines.length) {
    throw new Error('JARVIS voice setup nahi hua. Ek command: bash scripts/observer.sh voice setup (free neural British voice, offline). Emergency fallback: sudo dnf install espeak-ng ffmpeg');
  }

  const cacheKey = crypto.createHash('sha1').update(`${engines[0].name}|${config.ttsVoice || 'jarvis'}|${clean}`).digest('hex');
  if (clean.length <= 140 && phraseCache.has(cacheKey)) return phraseCache.get(cacheKey);

  const chunks = chunkForSpeech(clean);
  const errors = [];
  for (const engine of engines) {
    // English-only neural voices mangle Devanagari — route Hindi to an engine
    // that can actually read it (espeak 'hi', Edge hi-IN, XTTS 'hi').
    if (containsDevanagari(clean) && engine.name === 'piper' && !/hi[_-]/i.test(path.basename(engine.model || ''))) continue;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-tts-'));
    try {
      const parts = [];
      for (const [index, chunk] of chunks.entries()) {
        const file = await runEngine(engine, chunk, path.join(tmpDir, `part-${index}`), config);
        if (!fs.existsSync(file) || fs.statSync(file).size < 100) throw new Error(`${engine.name} produced no audio`);
        parts.push(file);
      }
      const oggPath = path.join(tmpDir, 'out.ogg');
      const ogg = await polishToOpus(parts, oggPath, config);
      const result = ogg
        ? { buffer: fs.readFileSync(ogg), mimetype: 'audio/ogg; codecs=opus', ext: 'ogg', engine: engine.name }
        : { buffer: fs.readFileSync(parts[0]), mimetype: parts[0].endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav', ext: parts[0].endsWith('.mp3') ? 'mp3' : 'wav', engine: engine.name };
      if (clean.length <= 140) {
        if (phraseCache.size >= PHRASE_CACHE_MAX) phraseCache.delete(phraseCache.keys().next().value);
        phraseCache.set(cacheKey, result);
      }
      return result;
    } catch (err) {
      errors.push(`${engine.name}: ${err.message}`);
      log.warn?.(`[tts] ${engine.name} failed (${err.message}) — trying next engine`);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* tmp */ }
    }
  }
  throw new Error(`Koi voice engine kaam nahi kiya. ${errors[0] ?? ''} — fix: bash scripts/observer.sh voice setup, phir /voice se status dekho.`);
}

/**
 * Streaming variant for live calls: yields one audio buffer per sentence as
 * soon as it is ready, so JARVIS starts speaking while later sentences are
 * still synthesising. Yields { buffer, mimetype, ext, engine, sentence }.
 */
export async function* synthesizeSentences(text, config = {}, log = console) {
  const clean = sanitizeForTTS(text);
  if (!clean) return;
  for (const sentence of chunkForSpeech(clean, 220, 8)) {
    const part = await synthesize(sentence, config, log);
    yield { ...part, sentence };
  }
}

export function ttsStatus(config = {}) {
  const engines = listTTSEngines(config);
  const preset = resolvePreset(config, '');
  const ffmpeg = hasBin('ffmpeg');
  if (!engines.length) {
    return [
      '🔊 *JARVIS voice: setup baaki hai*',
      'Ek command me free neural British voice (offline, ~90 MB):',
      '`bash scripts/observer.sh voice setup`',
      'Emergency robot fallback: `sudo dnf install espeak-ng ffmpeg`',
      `ffmpeg: ${ffmpeg ? 'found ✅' : 'missing — voice notes WAV me jayengi'}`,
      'Guide: VOICE.md · Status phir se: /voice',
    ].join('\n');
  }
  const [best] = engines;
  const robotic = ['espeak-ng', 'espeak', 'flite', 'festival'].includes(best.name);
  return [
    `🔊 *JARVIS voice ready:* ${best.label}`,
    `Preset: *${preset.key}*${robotic ? ` (espeak ${preset.voice}, pitch ${preset.pitch})` : ''} · Available engines: ${engines.map((e) => e.name).join(' → ')}`,
    `ffmpeg JARVIS FX: ${ffmpeg ? (jarvisFxFilter(config) ? 'on ✅ (warmth + sheen + loudnorm)' : 'off (TTS_FX=none)') : 'ffmpeg missing — plain audio'}`,
    robotic ? '⚠️ Abhi robotic fallback chal raha hai. Asli JARVIS ke liye: `bash scripts/observer.sh voice setup`' : 'Use: /voicereply <text> · /call on (har jawab voice me) · phone app ka 📞 Call tab',
    'Voices: jarvis · jarvis-deep · female · hindi · slow/fast — e.g. /voicereply voice jarvis-deep …',
  ].join('\n');
}

export { VOICE_PRESETS };
