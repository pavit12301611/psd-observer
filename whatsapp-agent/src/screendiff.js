// screendiff.js — 🔍 Screen diff: "kya badla screen pe" — do captures ka
// comparison (byte + stats level), plain-language summary. `/look diff`
// pehle wala snapshot store karta hai, agli baar compare.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { imageStats } from './imaging.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAP_DIR = path.join(ROOT, 'data', 'screenshots');

let baseline = null; // { hash, stats, at, file }

/** Cheap structural diff of two image buffers. 0..1 change ratio. */
export function diffBuffers(a, b, opts = {}) {
  const { statFn = imageStats } = opts;
  if (!a || !b) return { changed: true, ratio: 1, summary: 'ek capture missing hai' };
  const ha = crypto.createHash('sha1').update(a).digest('hex');
  const hb = crypto.createHash('sha1').update(b).digest('hex');
  if (ha === hb) return { changed: false, ratio: 0, summary: 'koi change nahi — same screen' };

  const sa = statFn(a);
  const sb = statFn(b);
  const brightnessDelta = Math.abs((sa.mean ?? 0) - (sb.mean ?? 0));
  const distinctDelta = Math.abs((sa.distinct ?? 0) - (sb.distinct ?? 0));

  // sample-wise byte delta as a rough motion ratio
  const len = Math.min(a.length, b.length);
  let diffs = 0;
  const step = Math.max(1, Math.floor(len / 5000));
  let samples = 0;
  for (let i = 0; i < len; i += step) {
    samples++;
    if (a[i] !== b[i]) diffs++;
  }
  const ratio = samples ? diffs / samples : 1;
  const parts = [];
  if (ratio > 0.4) parts.push('bohot kuch badla');
  else if (ratio > 0.1) parts.push('kaafi change hua');
  else parts.push('thoda sa badla');
  if (brightnessDelta > 25) parts.push(brightnessDelta > 0 ? 'screen bright hui/dark hui' : 'brightness shift');
  if (distinctDelta > 30) parts.push('naya content aaya (window/popup?)');
  return { changed: true, ratio, summary: parts.join(', ') };
}

/** Store a snapshot as the new baseline. */
export function setBaseline(buffer, opts = {}) {
  const { statFn = imageStats, now = Date.now, file = null } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  baseline = {
    hash: crypto.createHash('sha1').update(buffer).digest('hex'),
    stats: statFn(buffer),
    at: nowTs,
    file,
  };
  return baseline;
}

export function compareWithBaseline(buffer, opts = {}) {
  if (!baseline) return { first: true, ...diffBuffers(null, null), reply: '📸 Pehla snapshot liya — ab `/look diff` dobara bolo, badlaav bataunga.' };
  return { first: false, ...diffBuffers(baselineBuffer(opts), buffer, opts) };
}

let _lastBuffer = null;
export function pushBuffer(buf) {
  _lastBuffer = buf;
}
function baselineBuffer(opts) {
  return opts.baselineBuffer ?? _lastBuffer;
}

export function diffReply(result, opts = {}) {
  const nowTs = typeof now === 'function' ? (opts.now ?? Date.now)() : (opts.now ?? Date.now)();
  const agoSec = baseline ? Math.max(0, Math.round((nowTs - baseline.at) / 1000)) : 0;
  if (result.first) return result.reply;
  return `🔍 *Screen diff* (${agoSec}s me)\n${result.summary}\nChange: ${(result.ratio * 100).toFixed(0)}%`;
}

export function resetDiff() {
  baseline = null;
  _lastBuffer = null;
}
