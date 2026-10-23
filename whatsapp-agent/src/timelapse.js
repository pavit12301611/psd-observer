// timelapse.js — ⏩ Webcam timelapse: "/webcam timelapse 2h [intervalSec]" —
// N photos at an interval → fast-forward video. Frames ke beech ka kaam
// injected; assembly ffmpeg se.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const MAX_FRAMES = 240;

const jobs = new Map(); // id -> { timer, frames, opts, startedAt }

/**
 * Start collecting frames. `capture()` returns an image buffer (injected —
 * default callers pass webcamPhoto().image).
 */
export function startTimelapse(opts = {}) {
  const {
    durationMs = 60 * 60_000,
    intervalSec = 60,
    capture,
    dir = path.join(os.tmpdir(), `timelapse-${Date.now()}`),
    now = Date.now,
    onDone,
  } = opts;
  if (typeof capture !== 'function') return { ok: false, error: '⏩ capture() chahiye (webcam)' };
  const nowTs = typeof now === 'function' ? now() : now;
  const id = String(nowTs).slice(-8);
  fs.mkdirSync(dir, { recursive: true });
  const job = {
    id, dir, frames: [], startedAt: nowTs,
    endsAt: nowTs + durationMs,
    timer: null, onDone,
  };
  const tick = async () => {
    if (job.frames.length >= MAX_FRAMES || Date.now() >= job.endsAt) {
      clearInterval(job.timer);
      jobs.delete(id);
      const file = await assembleTimelapse(job.frames, { run: opts.run });
      onDone?.({ frames: job.frames.length, file });
      return;
    }
    try {
      const buf = await capture();
      const f = path.join(job.dir, `frame-${String(job.frames.length).padStart(4, '0')}.jpg`);
      fs.writeFileSync(f, buf);
      job.frames.push(f);
    } catch { /* skip bad frame */ }
  };
  tick();
  job.timer = setInterval(tick, Math.max(2, intervalSec) * 1000);
  job.timer.unref?.();
  jobs.set(id, job);
  return {
    ok: true,
    id,
    reply: `⏩ *Timelapse ON* — har ${intervalSec}s ek frame, ${Math.round(durationMs / 60_000)} min tak.\nStop: \`/webcam timelapse stop ${id}\``,
  };
}

export function stopTimelapse(id) {
  const job = jobs.get(String(id));
  if (!job) return '⏩ Koi timelapse nahi chal raha (ya galat id).';
  clearInterval(job.timer);
  jobs.delete(String(id));
  return `⏩ Timelapse ${id} roka — ${job.frames.length} frames captured.`;
}

/** Assemble frames → mp4 via ffmpeg (injected run in tests). */
export async function assembleTimelapse(frames, opts = {}) {
  const {
    run = execFileAsync,
    fps = 12,
    outFile = path.join(os.tmpdir(), `timelapse-${Date.now()}.mp4`),
  } = opts;
  if (!frames.length) return null;
  const listFile = `${outFile}.txt`;
  fs.writeFileSync(listFile, frames.map((f) => `file '${f}'`).join('\n'));
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-r', String(fps),
      '-i', listFile, '-y', outFile,
    ], { timeout: 120_000 });
    return outFile;
  } catch {
    return null;
  }
}

export function activeTimelapses() {
  return [...jobs.keys()];
}
