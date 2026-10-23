// meetingnotes.js — 🎙️ Meeting → Notes: `/notes now` starts recording the
// mic, `/notes stop` transcribes (existing transcribe.js) and asks the brain
// for crisp notes + actions. The meeting never leaves the PC except through
// the owner's own AI brain.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transcribeAudio } from './transcribe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NOTES_DIR = path.join(ROOT, 'data', 'meetings');
export const DEFAULT_SECONDS = 600; // 10 min safety cap

let rec = null; // { proc, file, startedAt }

export function notesStatus() {
  if (!rec) return '🎙️ Meeting recorder: *OFF* · start: `/notes now`';
  const mins = Math.floor((Date.now() - rec.startedAt) / 60_000);
  return `🎙️ Meeting recorder: *ON* — ${mins} min ho gaye · stop: \`/notes stop\``;
}

/** Start recording mic audio (ffmpeg ALSA capture → wav). Injected in tests. */
export function startNotes(opts = {}) {
  const {
    spawnRec = (file) => spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'alsa', '-i', 'default',
      '-t', String(DEFAULT_SECONDS),
      '-y', file,
    ], { stdio: ['ignore', 'ignore', 'ignore'] }),
    dir = NOTES_DIR,
  } = opts;
  if (rec) return '🎙️ Pehle se recording chal rahi hai. Stop: `/notes stop`';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `meeting-${Date.now()}.wav`);
    const proc = spawnRec(file);
    rec = { proc, file, startedAt: Date.now() };
    return `🎙️ *Meeting recording ON* — ab sab kuch record ho raha hai.\nNotes: \`/notes stop\` bhejo jab meeting khatam ho.`;
  } catch (err) {
    return `🎙️ Recording shuru nahi hui: ${err?.message ?? err} (mic/ffmpeg chahiye)`;
  }
}

export function stopNotesRaw() {
  if (!rec) return null;
  const { proc, file, startedAt } = rec;
  rec = null;
  try { proc.kill('SIGINT'); } catch { /* already gone */ }
  return { file, startedAt };
}

/**
 * Stop → transcribe → summarize. `summarize(text)` is the AI brain (injected).
 * `transcribe` is injected in tests (default: local whisper).
 */
/** Default transcriber: read the wav file → existing transcribeAudio seam. */
export async function transcribeWavFile(file, opts = {}) {
  const buffer = fs.readFileSync(file);
  const text = await transcribeAudio({}, buffer, 'audio/wav', opts.logger ?? console);
  return { text };
}

export async function stopNotes(opts = {}) {
  const { summarize, transcribe = transcribeWavFile, onSummary } = opts;
  const raw = stopNotesRaw();
  if (!raw) return '🎙️ Koi recording chal hi nahi rahi. Start: `/notes now`';
  const mins = Math.max(1, Math.round((Date.now() - raw.startedAt) / 60_000));
  try {
    if (!fs.existsSync(raw.file)) return '🎙️ Recording file nahi mili (mic band ho gaya?).';
    const { text } = await transcribe(raw.file, { logger: { info: () => {}, error: () => {} } });
    const transcript = String(text ?? '').trim();
    if (!transcript) return '🎙️ Kuch awaaz record nahi hui (mic check karo).';
    let notes = transcript.slice(0, 4000);
    if (typeof summarize === 'function') {
      notes = await summarize(transcript);
    }
    const reply = `🎙️ *Meeting notes* (${mins} min)\n\n${notes}\n\n_Full transcript: ${raw.file}_`;
    onSummary?.(reply);
    return reply;
  } catch (err) {
    return `🎙️ Transcribe nahi ho paya: ${err?.message ?? err}`;
  }
}

export function currentRecording() {
  return rec;
}

export function meetingHistory(limit = 5, dir = NOTES_DIR) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('meeting-')).sort().reverse().slice(0, limit);
    return files.map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
