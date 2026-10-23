// backup.js — 💾 Auto-backup: important folder ka zip backup (local ya
// rclone-configured remote). `/backup now <path>` · `/backup watch <path>` +
// guard photos ka cloud-copy (cloudbak) bhi yahin se.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
export const MANIFEST = path.join(BACKUP_DIR, 'manifest.json');

export function loadManifest(file = MANIFEST) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { backups: [] };
  }
}

function saveManifest(data, file = MANIFEST) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/** Zip `src` into BACKUP_DIR with timestamp. `run` injected (tests). */
export async function backupNow(src, opts = {}) {
  const {
    run = execFileAsync,
    outDir = BACKUP_DIR,
    now = Date.now,
  } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const resolved = path.resolve(src ?? path.join(os.homedir(), 'Documents'));
  if (!fs.existsSync(resolved)) return `💾 Path nahi mili: ${resolved}`;
  const base = `${path.basename(resolved)}-${new Date(nowTs).toISOString().slice(0, 10)}-${String(nowTs).slice(-5)}`;
  const outFile = path.join(outDir, `${base}.zip`);
  try {
    fs.mkdirSync(outDir, { recursive: true });
    await run('zip', ['-r', '-q', outFile, resolved], { timeout: 300_000 });
    const size = fs.statSync(outFile).size;
    const data = loadManifest();
    data.backups.push({ at: nowTs, src: resolved, file: outFile, size });
    data.backups = data.backups.slice(-20);
    saveManifest(data);
    return `💾 *Backup done* — ${outFile} (${Math.round(size / 1024)} KB)\nRestore: \`/backup restore ${path.basename(outFile)}\``;
  } catch (err) {
    return `💾 Backup fail: ${err?.message ?? err} (zip chahiye: sudo dnf install zip)`;
  }
}

/** Copy a single file (guard photo) to a cloud-synced dir (rclone/Drive). */
export async function cloudCopy(filePath, opts = {}) {
  const {
    remoteDir = null,
    run = execFileAsync,
    useRclone = false,
    remoteName = 'gdrive:observer-alerts',
  } = opts;
  if (!fs.existsSync(filePath)) return `☁️ File nahi mili: ${filePath}`;
  try {
    if (useRclone) {
      await run('rclone', ['copy', filePath, remoteName], { timeout: 60_000 });
      return `☁️ *Cloud backup:* ${remoteName}/${path.basename(filePath)}`;
    }
    if (remoteDir) {
      fs.mkdirSync(remoteDir, { recursive: true });
      fs.copyFileSync(filePath, path.join(remoteDir, path.basename(filePath)));
      return `☁️ *Cloud-sync folder me copy:* ${remoteDir}`;
    }
    return '☁️ Cloud target set nahi — `/backup cloud <folder|gdrive>` se setup karo.';
  } catch (err) {
    return `☁️ Cloud copy fail: ${err?.message ?? err}`;
  }
}

export function backupList() {
  const data = loadManifest();
  return data.backups.length
    ? `💾 *Backups* (${data.backups.length})\n${data.backups.slice(-5).map((b) => `• ${new Date(b.at).toLocaleDateString('en-IN')} — ${path.basename(b.file)} (${Math.round(b.size / 1024)} KB)`).join('\n')}`
    : '💾 Koi backup nahi hua. `/backup now ~/Documents` chalao.';
}
