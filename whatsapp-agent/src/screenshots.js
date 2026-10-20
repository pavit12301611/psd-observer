// screenshots.js — screenshots are disposable, so delete them by themselves.
//
// Two places a screenshot can survive on disk:
//   1. the temp copy every capture makes (`<tmp>/observer-shot-<ts>.png`)
//   2. the file the Wayland portal writes into ~/Pictures
//
// (1) is deleted the moment the bytes are read — nothing needs it afterwards.
// (2) is a real file the owner can see, and it is also useless a minute later:
// it was taken to be *sent*, not kept. So it goes through this janitor and is
// deleted after a short TTL (default 4 minutes, configurable 2–5, or off).
//
// What is NEVER touched:
//   • any file the owner created (only paths the agent captured are tracked)
//   • anything outside the temp dir / the portal's pictures folders
//   • downloads, shared files, recordings, webcam photos
//
// The ledger lives in data/shots.json so a restart still cleans what the
// previous process captured, and the temp folder is swept by name so a crash
// cannot leak either.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_TTL_MINUTES = 4;
export const MIN_TTL_MINUTES = 2;
export const MAX_TTL_MINUTES = 5;

const TMP_PREFIX = 'observer-shot-';
const TMP_PATTERN = /^observer-shot-\d+\.png$/;

/** Minutes → seconds, clamped to something sane (2–5 by default, 1–30 forced). */
export function ttlSeconds(config = {}) {
  const raw = Number(config.screenshotTtlMinutes ?? process.env.SCREENSHOT_TTL_MINUTES ?? DEFAULT_TTL_MINUTES);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TTL_MINUTES;
  const clamped = Math.min(Math.max(minutes, 1), 30);
  return Math.round(clamped * 60);
}

/** Is automatic cleanup on? SCREENSHOT_CLEANUP=false turns it off entirely. */
export function cleanupEnabled(config = {}) {
  const raw = config.screenshotCleanup;
  if (raw === false) return false;
  if (typeof raw === 'string') return !/^(false|0|off|no|nahi)$/i.test(raw.trim());
  return raw !== false;
}

/** The portal's likely homes for a screenshot (mirrors pccontrol.picturesDirs). */
export function pictureDirs(env = process.env) {
  const home = os.homedir();
  const dirs = [];
  try {
    const text = fs.readFileSync(path.join(home, '.config', 'user-dirs.dirs'), 'utf8');
    const match = text.match(/^XDG_PICTURES_DIR="?([^"\n]+)"?/m);
    if (match) dirs.push(match[1].replace(/^\$HOME/, home));
  } catch { /* no user-dirs file */ }
  if (env.XDG_PICTURES_DIR) dirs.push(env.XDG_PICTURES_DIR);
  dirs.push(path.join(home, 'Pictures'), path.join(home, 'Pictures', 'Screenshots'), path.join(home, 'Desktop'));
  return [...new Set(dirs)].filter((dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  });
}

const isInside = (file, dir) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/**
 * Captures made before the janitor finished starting (or in a short-lived
 * process) wait here; the janitor drains this list into its ledger.
 */
const PENDING = [];

/** Called by pccontrol for every file the agent itself produced. */
export function trackScreenshot(file, { kind = 'tmp', ts = Date.now() } = {}) {
  if (!file) return;
  PENDING.push({ path: String(file), kind, ts });
}

export function takePending() {
  return PENDING.splice(0, PENDING.length);
}

const humanSize = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
};

export function createShotJanitor({ config = {}, log = console, file = null, now = () => Date.now() } = {}) {
  const ledgerFile = file ?? path.join(config.dataDir ?? path.resolve('data'), 'shots.json');

  function load() {
    try {
      const data = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
      return Array.isArray(data?.entries) ? data.entries : [];
    } catch {
      return [];
    }
  }

  function save(entries) {
    try {
      fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
      const tmp = `${ledgerFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2));
      fs.renameSync(tmp, ledgerFile);
    } catch (err) {
      log?.warn?.(`[shots] could not save the ledger: ${err.message}`);
    }
  }

  function remember(entry) {
    if (!entry?.path) return;
    const entries = load();
    if (entries.some((e) => e.path === entry.path)) return;
    entries.push(entry);
    save(entries);
  }

  function drain() {
    const entries = load();
    let added = 0;
    for (const item of takePending()) {
      if (entries.some((e) => e.path === item.path)) continue;
      entries.push(item);
      added += 1;
    }
    if (added) save(entries);
    return added;
  }

  /** Age of a tracked entry (prefer the file's own mtime: it is the truth). */
  function ageOf(entry, ts) {
    try {
      const stat = fs.statSync(entry.path);
      if (!stat.isFile()) return null;
      return { ageMs: Math.max(0, ts - Math.min(stat.mtimeMs, entry.ts ?? stat.mtimeMs)), size: stat.size, path: entry.path };
    } catch {
      return null; // gone already
    }
  }

  /**
   * Delete what is older than the TTL. Also sweeps the temp dir by filename so
   * leftovers from a crash or an older version disappear too.
   * Returns { deleted, bytes, kept, swept, errors }.
   */
  function cleanup({ ttl = ttlSeconds(config), ts = now(), tmpDir = os.tmpdir(), pictures = pictureDirs() } = {}) {
    const result = { deleted: 0, bytes: 0, kept: 0, swept: 0, errors: [] };
    if (!cleanupEnabled(config)) return result;

    drain();
    const entries = load();
    const survivors = [];
    for (const entry of entries) {
      if (entry.kind !== 'tmp' && entry.kind !== 'pictures') continue; // unknown: leave it alone
      const info = ageOf(entry, ts);
      if (!info) continue; // file is gone — drop the record
      // Never delete outside the folders this feature owns.
      const allowed = entry.kind === 'tmp'
        ? isInside(entry.path, tmpDir) && TMP_PATTERN.test(path.basename(entry.path))
        : pictures.some((dir) => isInside(entry.path, dir));
      if (!allowed) continue;
      if (info.ageMs < ttl * 1000) {
        survivors.push(entry);
        result.kept += 1;
        continue;
      }
      try {
        fs.unlinkSync(entry.path);
        result.deleted += 1;
        result.bytes += info.size;
      } catch (err) {
        if (err.code !== 'ENOENT') result.errors.push(`${path.basename(entry.path)}: ${err.message}`);
      }
    }
    save(survivors);

    // Crash leftovers: same prefix, old mtime, not in the ledger.
    let names = [];
    try { names = fs.readdirSync(tmpDir); } catch { names = []; }
    for (const name of names) {
      if (!name.startsWith(TMP_PREFIX) || !TMP_PATTERN.test(name)) continue;
      const full = path.join(tmpDir, name);
      if (survivors.some((e) => e.path === full)) continue;
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile() || ts - stat.mtimeMs < ttl * 1000) continue;
        fs.unlinkSync(full);
        result.swept += 1;
        result.bytes += stat.size;
      } catch { /* raced */ }
    }
    return result;
  }

  function pendingCount(ts = now()) {
    drain();
    return load()
      .map((e) => ageOf(e, ts))
      .filter(Boolean).length;
  }

  return { file: ledgerFile, track: remember, cleanup, pendingCount, describe: () => describeJanitor({ config, file: ledgerFile, now }) };
}

/** WhatsApp-ready /shots report. */
export function describeJanitor({ config = {}, file = null, now = Date.now() } = {}) {
  const entries = (() => {
    try {
      const data = JSON.parse(fs.readFileSync(file ?? path.join(config.dataDir ?? 'data', 'shots.json'), 'utf8'));
      return Array.isArray(data?.entries) ? data.entries : [];
    } catch {
      return [];
    }
  })();
  const live = entries.filter((e) => { try { return fs.statSync(e.path).isFile(); } catch { return false; } });
  const bytes = live.reduce((sum, e) => { try { return sum + fs.statSync(e.path).size; } catch { return sum; } }, 0);
  const on = cleanupEnabled(config);
  const ttl = ttlSeconds(config);

  if (!on) {
    return [
      '📸 *Screenshot cleanup: OFF*',
      '',
      `_${live.length ? `${live.length} file(s) is PC pe pade hain.` : 'Koi screenshot file nahi padi.'}_`,
      'Chalu karne ke liye `.env` me `SCREENSHOT_CLEANUP=true` karke restart karo.',
    ].join('\n');
  }

  const lines = [
    '📸 *Screenshot cleanup: ON*',
    '',
    `Har screenshot *${Math.round(ttl / 60)} min* baad khud delete ho jata hai.`,
    live.length ? `Abhi *${live.length}* file(s) bachi hain (${humanSize(bytes)}).` : 'Abhi koi screenshot PC pe nahi padi.',
  ];
  if (live.length) {
    for (const entry of live.slice(0, 5)) {
      const ageMin = Math.max(0, (now - (entry.ts ?? now)) / 60_000);
      lines.push(`• ${path.basename(entry.path)} — ${ageMin < 1 ? 'abhi' : `${Math.round(ageMin)} min purani`}`);
    }
    if (live.length > 5) lines.push(`_…aur ${live.length - 5}_`);
  }
  lines.push('', '_Abhi turant saaf karna ho: /shots clean_');
  return lines.join('\n');
}

/** Delete everything now, ignoring the TTL. */
export function cleanNow(janitor, { now = Date.now(), tmpDir = os.tmpdir(), pictures = pictureDirs() } = {}) {
  return janitor.cleanup({ ttl: 0, ts: now, tmpDir, pictures });
}

/**
 * Background loop. Runs every 30s (cheap: a few stat calls), deletes anything
 * past the TTL, and logs one line only when it actually removed something.
 */
export function startShotJanitor({ config, log = console, janitor = null, intervalMs = 30_000, tmpDir = os.tmpdir(), pictures = pictureDirs() } = {}) {
  const shots = janitor ?? createShotJanitor({ config, log });
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    try {
      const result = shots.cleanup({ tmpDir, pictures });
      if (result.deleted || result.swept) {
        log?.info?.(`[shots] deleted ${result.deleted + result.swept} screenshot(s) · ${humanSize(result.bytes)} `
          + `(TTL ${Math.round(ttlSeconds(config) / 60)} min)`);
      }
      for (const err of result.errors) log?.warn?.(`[shots] ${err}`);
    } catch (err) {
      log?.warn?.(`[shots] cleanup failed: ${err.message}`);
    }
  };
  const timer = setInterval(tick, Math.max(5_000, intervalMs));
  timer.unref?.();
  const first = setTimeout(tick, 2_000);
  first.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(first);
    try { shots.cleanup({ tmpDir, pictures }); } catch { /* shutdown: best effort */ }
  };
}

/** Human line after `/shots clean`. */
export function cleanupReply(result) {
  const total = (result?.deleted ?? 0) + (result?.swept ?? 0);
  if (!total) return '📸 Kuch delete karne layak nahi mila — shelf already saaf hai.';
  const bytes = result.bytes ? ` (${humanSize(result.bytes)})` : '';
  const errors = result.errors?.length ? `\n_${result.errors.length} file(s) nahi hatti._` : '';
  return `🗑️ *${total} screenshot${total === 1 ? '' : 's'} delete*${bytes} — PC saaf.${errors}`;
}
