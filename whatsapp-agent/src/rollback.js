// rollback.js — ⏪ /rollback: update kharab lage to ek command me pichhle
// version par wapas. Snapshot data/rollback/<ts>/ me (src + package.json).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAP_ROOT = path.join(ROOT, 'data', 'rollback');
export const MAX_SNAPSHOTS = 3;

/** Copy current src + package.json into a timestamped snapshot. */
export function saveSnapshot(opts = {}) {
  const { root = ROOT, snapRoot = SNAP_ROOT, now = Date.now, label = '' } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const dest = path.join(snapRoot, `${nowTs}${label ? `-${label}` : ''}`);
  try {
    fs.mkdirSync(path.join(dest, 'src'), { recursive: true });
    for (const f of fs.readdirSync(path.join(root, 'src'))) {
      fs.copyFileSync(path.join(root, 'src', f), path.join(dest, 'src', f));
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(dest, 'package.json'));
    prune(snapRoot);
    return { ok: true, dest };
  } catch (err) {
    return { ok: false, error: `⏪ Snapshot nahi bana: ${err?.message ?? err}` };
  }
}

function prune(snapRoot) {
  try {
    const snaps = fs.readdirSync(snapRoot).sort();
    while (snaps.length > MAX_SNAPSHOTS) {
      fs.rmSync(path.join(snapRoot, snaps.shift()), { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}

export function latestSnapshot(snapRoot = SNAP_ROOT) {
  try {
    const snaps = fs.readdirSync(snapRoot).sort();
    return snaps.length ? path.join(snapRoot, snaps[snaps.length - 1]) : null;
  } catch {
    return null;
  }
}

/** Restore the latest snapshot back into the project. */
export function rollback(opts = {}) {
  const { root = ROOT, snapRoot = SNAP_ROOT, snapshot = null } = opts;
  const src = snapshot ?? latestSnapshot(snapRoot);
  if (!src) return '⏪ Koi snapshot nahi mila (pehle update hona chahiye tha).';
  try {
    for (const f of fs.readdirSync(path.join(src, 'src'))) {
      fs.copyFileSync(path.join(src, 'src', f), path.join(root, 'src', f));
    }
    fs.copyFileSync(path.join(src, 'package.json'), path.join(root, 'package.json'));
    return `⏪ *Rolled back* to snapshot ${path.basename(src)}\nBot ko restart karo: \`observer.sh service restart\``;
  } catch (err) {
    return `⏪ Rollback fail: ${err?.message ?? err}`;
  }
}

export function snapshotList(snapRoot = SNAP_ROOT) {
  try {
    const snaps = fs.readdirSync(snapRoot);
    return snaps.length ? `⏪ *Snapshots*\n${snaps.map((s) => `• ${s}`).join('\n')}` : '⏩ Koi snapshot nahi hai.';
  } catch {
    return '⏩ Koi snapshot nahi hai.';
  }
}
