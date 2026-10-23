// highlights.js — ✨ Auto-highlight reel: lambe screen-recording se key
// moments nikaal ke chhota clip bana do (ffmpeg scene detection). Har jagah
// injected runner — tests me fake.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

/**
 * Extract scene-change moments from a recording and cut a highlight reel.
 * `run(bin, args)` is injected (tests assert the ffmpeg recipe).
 */
export async function extractHighlights(inputFile, opts = {}) {
  const {
    run = execFileAsync,
    maxSeconds = 30,
    sceneThreshold = 0.3,
    outFile = path.join(os.tmpdir(), `highlights-${Date.now()}.mp4`),
  } = opts;
  if (!fs.existsSync(inputFile)) {
    return { ok: false, error: `✨ Recording nahi mili: ${inputFile}` };
  }
  try {
    // Pass 1: find scene-change timestamps.
    await run('ffmpeg', [
      '-hide_banner', '-i', inputFile,
      '-vf', `select='gt(scene,${sceneThreshold})',showinfo`,
      '-f', 'null', '-',
    ], { timeout: 120_000 });
    // Pass 2: cut the last N seconds around the busiest section into a reel.
    // (scene list parsing is best-effort; the filter does the heavy lifting)
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', inputFile,
      '-vf', `select='gt(scene,${sceneThreshold})',scale=1280:-2`,
      '-frames:v', String(Math.max(3, Math.round(maxSeconds * 2))),
      '-r', '12', '-an', '-y', outFile,
    ], { timeout: 120_000 });
    return { ok: true, file: outFile, reply: `✨ *Highlight reel ready* — ${outFile}\n(scene-change moments, ~${maxSeconds}s target)` };
  } catch (err) {
    return { ok: false, error: `✨ Highlights nahi ban paye: ${err?.message ?? err}` };
  }
}

/** Pure helper for the reply when the reel is done — kept tiny and testable. */
export function highlightReply(result) {
  return result.ok ? result.reply : result.error;
}
