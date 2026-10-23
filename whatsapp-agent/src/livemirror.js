// livemirror.js — 🎥 Live Screen Mirror: periodic screenshots to WhatsApp.
// `/live [interval-sec]` starts, `/live off` stops, `/live status` reports.
// The phone becomes a live monitor of the PC — works even with shades ON
// (screenshots always capture the real framebuffer).
//
// Safety: auto-stops after a frame budget / duration so it can never stream
// forever by accident. Everything injectable for tests.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const MAX_FRAMES = 180; // hard cap (~30 min at 10s)
export const MAX_DURATION_MS = 30 * 60_000;
export const DEFAULT_INTERVAL_SEC = 10;

let live = null; // { timer, frames, sent, startedAt, intervalSec }

export function liveStatus() {
  if (!live) return '🎥 Live mirror: *OFF*. Start: `/live [interval-sec]` (default 10s)';
  const mins = Math.floor((Date.now() - live.startedAt) / 60_000);
  return `🎥 Live mirror: *ON* — har ${live.intervalSec}s ek frame · ${live.sent}/${live.maxFrames} bheje · ${mins} min chal raha · off: \`/live off\``;
}

export function stopLive(reason = '') {
  if (!live) return '🎥 Live mirror already OFF hai.';
  clearInterval(live.timer);
  const { sent, frames } = live;
  live = null;
  return `🎥 Live mirror *OFF* ${reason}· total ${sent}/${frames} frames bheji.`;
}

/**
 * Start mirroring. `capture()` returns an image buffer, `send({image,text})`
 * delivers it to the owner. Both injected in tests.
 */
export async function startLive(opts = {}) {
  const {
    intervalSec = DEFAULT_INTERVAL_SEC,
    capture,
    send,
    maxFrames = MAX_FRAMES,
    maxDurationMs = MAX_DURATION_MS,
  } = opts;
  if (typeof capture !== 'function' || typeof send !== 'function') {
    throw new Error('startLive needs capture() and send()');
  }
  if (live) return `🎥 Live mirror already ON hai (${live.sent} frames). Pehle: \`/live off\``;
  const sec = Math.min(300, Math.max(3, Number(intervalSec) || DEFAULT_INTERVAL_SEC));

  const state = { timer: null, frames: 0, sent: 0, startedAt: Date.now(), intervalSec: sec, maxFrames };
  live = state;

  const tick = async () => {
    if (live !== state) return;
    state.frames += 1;
    try {
      const image = await capture();
      if (image) {
        await send({
          image,
          text: `🎥 Live ${state.sent + 1} · ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
        });
        state.sent += 1;
      }
    } catch { /* one bad frame never kills the stream */ }
    if (state.frames >= maxFrames) {
      stopLive('(frame budget khatam)');
    }
  };

  state.timer = setInterval(tick, sec * 1000);
  state.timer.unref?.();
  const kill = setTimeout(() => {
    if (live === state) stopLive('(duration limit)');
  }, maxDurationMs);
  kill.unref?.();

  // First frame immediately so the owner sees it's alive.
  await tick();
  return `🎥 *Live mirror ON* — har ${sec}s ek screenshot yahan aayega (max ${maxFrames} frames / ${Math.round(maxDurationMs / 60000)} min).\nOff: \`/live off\``;
}
