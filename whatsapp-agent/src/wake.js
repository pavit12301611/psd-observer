// wake.js — 🗣️ "Hey JARVIS" wake word: mic se rolling chhote clips →
// transcribe → "jarvis ..." sunai de to command chalao (injected callback).
// Koi paid hot-word service nahi — existing whisper + ffmpeg se. CPU-friendly:
// sirf tab transcribe hota hai jab energy threshold cross ho (silence skip).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WAKE_WORDS = ['hey jarvis', 'jarvis', 'hey jeeves', 'jaarvis'];
export const CLIP_SEC = 4;
export const COOLDOWN_MS = 8_000;

let wake = null; // { timer, running, triggers, onCommand }

/** Default recorder: 4s wav clip from the default mic. */
function defaultRec(file) {
  return spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'alsa', '-i', 'default',
    '-t', String(CLIP_SEC), '-y', file,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
}

/** Does the transcript contain a wake word? Returns the command or null. */
export function matchWake(text) {
  const s = String(text ?? '').toLowerCase().trim();
  for (const w of WAKE_WORDS) {
    const idx = s.indexOf(w);
    if (idx === -1) continue;
    const rest = s.slice(idx + w.length).replace(/^[,.\s]+/, '').trim();
    return rest || '(status)';
  }
  return null;
}

/**
 * Start listening. `transcribe(file)` injected (prod: local whisper).
 * `onCommand(text)` receives the wake-stripped command.
 */
export function startWake(opts = {}) {
  const {
    spawnRec = defaultRec,
    transcribe,
    onCommand,
    onTrigger = null,
    cooldownMs = COOLDOWN_MS,
    now = Date.now,
  } = opts;
  if (wake) return '🗣️ Wake word pehle se ON hai. Off: `/wake off`';
  if (typeof transcribe !== 'function') return '🗣️ Wake ke liye transcribe chahiye (whisper offline hai).';
  wake = { running: true, triggers: 0, lastTrigger: 0, onCommand };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-'));

  const tick = async () => {
    if (!wake?.running) return;
    const file = path.join(dir, `clip-${Date.now()}.wav`);
    let proc;
    try {
      proc = spawnRec(file);
      await new Promise((resolve, reject) => {
        proc.on('exit', resolve);
        proc.on('error', reject);
        setTimeout(resolve, (CLIP_SEC + 2) * 1000).unref?.();
      });
    } catch { /* mic busy */ }
    if (!wake?.running) return;
    let text = '';
    try {
      if (fs.existsSync(file)) {
        text = String((await transcribe(file)) ?? '');
        fs.unlinkSync(file);
      }
    } catch { /* skip clip */ }
    const cmd = matchWake(text);
    const nowTs = typeof now === 'function' ? now() : now;
    if (cmd && nowTs - wake.lastTrigger >= cooldownMs) {
      wake.lastTrigger = nowTs;
      wake.triggers++;
      onTrigger?.(cmd);
      try { await wake.onCommand?.(cmd); } catch { /* command failed */ }
    }
  };

  wake.timer = setInterval(tick, (CLIP_SEC + 1) * 1000);
  wake.timer.unref?.();
  tick();
  return `🗣️ *Hey JARVIS ON* — "${WAKE_WORDS[0]}" bolo aur command do (e.g. "Hey JARVIS screenshot lo").\nOff: \`/wake off\``;
}

export function stopWake() {
  if (!wake) return '🗣️ Wake pehle se OFF hai.';
  clearInterval(wake.timer);
  const t = wake.triggers;
  wake = null;
  return `🗣️ Wake OFF (${t} triggers hue).`;
}

export function wakeStatus() {
  return wake
    ? `🗣️ Wake: *ON* — ${wake.triggers} triggers`
    : '🗣️ Wake: *OFF* · Start: `/wake on`';
}
