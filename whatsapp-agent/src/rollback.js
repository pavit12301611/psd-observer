// Code-only recovery: complete recursive snapshots, integrity checks and a
// staged restore. Never include owner data, auth, .env or repository metadata.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SNAP_ROOT = path.join(ROOT, 'data', 'rollback');
export const MAX_SNAPSHOTS = 3;
const ITEMS = ['src', 'package.json', 'package-lock.json'];

function copyTree(src, dest) {
  const stat = fs.lstatSync(src);
  if (stat.isSymbolicLink()) throw new Error('Symlinks are not supported in recovery snapshots');
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(path.join(src, name), path.join(dest, name));
  } else if (stat.isFile()) fs.copyFileSync(src, dest, fs.constants.COPYFILE_EXCL);
  else throw new Error('Only regular source files/directories can be snapshotted');
}

function payload(dir) {
  const hashes = new Map();
  function walk(relative) {
    const file = path.join(dir, relative), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('Snapshot symlink rejected');
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(`${relative}/${name}`);
    else if (stat.isFile()) hashes.set(relative, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
    else throw new Error('Snapshot contains a non-regular file');
  }
  if (!fs.lstatSync(path.join(dir, 'src')).isDirectory()) throw new Error('Snapshot src is missing');
  for (const name of ITEMS) if (name !== 'package-lock.json' || fs.existsSync(path.join(dir, name))) walk(name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('Invalid snapshot package.json');
  if (hashes.has('package-lock.json')) {
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    if (!lock || typeof lock !== 'object' || Array.isArray(lock) || (pkg.version && lock.version && pkg.version !== lock.version)) throw new Error('Snapshot package/lock mismatch');
  }
  return hashes;
}

function inspect(dir) {
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error('Invalid snapshot directory');
  const files = payload(dir);
  let createdAt = Number.parseInt(path.basename(dir), 10) || fs.statSync(dir).mtimeMs;
  const manifest = path.join(dir, 'snapshot.json');
  if (fs.existsSync(manifest)) {
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (data.format !== 1 || !Number.isFinite(data.createdAt) || !Array.isArray(data.files) || data.files.length !== files.size) throw new Error('Incomplete snapshot manifest');
    const seen = new Set();
    for (const row of data.files) {
      if (seen.has(row.path) || !files.has(row.path) || files.get(row.path) !== row.sha256) throw new Error('Snapshot integrity check failed');
      seen.add(row.path);
    }
    createdAt = data.createdAt;
  }
  return { dir, createdAt, files };
}

function snapshots(snapRoot) {
  try {
    return fs.readdirSync(snapRoot).filter((name) => !name.startsWith('.')).flatMap((name) => {
      try { return [inspect(path.join(snapRoot, name))]; } catch { return []; }
    }).sort((a, b) => a.createdAt - b.createdAt || a.dir.localeCompare(b.dir));
  } catch { return []; }
}

export function saveSnapshot(opts = {}) {
  const { root = ROOT, now = Date.now, label = '' } = opts;
  const snapRoot = path.resolve(opts.snapRoot ?? SNAP_ROOT);
  let stage;
  try {
    const nowTs = typeof now === 'function' ? now() : now;
    if (!Number.isSafeInteger(nowTs) || nowTs < 0) throw new Error('Invalid snapshot timestamp');
    // Validate before staging: a partial source copy cannot become "latest".
    const original = payload(root);
    fs.mkdirSync(snapRoot, { recursive: true, mode: 0o700 });
    stage = fs.mkdtempSync(path.join(snapRoot, '.pending-'));
    for (const name of ITEMS) if (name !== 'package-lock.json' || fs.existsSync(path.join(root, name))) copyTree(path.join(root, name), path.join(stage, name));
    const files = payload(stage), current = payload(root);
    if (files.size !== original.size || current.size !== original.size || [...original].some(([name, hash]) => files.get(name) !== hash || current.get(name) !== hash)) throw new Error('Source changed while creating snapshot; no partial backup installed');
    fs.writeFileSync(path.join(stage, 'snapshot.json'), JSON.stringify({ format: 1, createdAt: nowTs, files: [...files].map(([file, sha256]) => ({ path: file, sha256 })) }), { flag: 'wx', mode: 0o600 });
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^\.+/, '').slice(0, 50);
    const dest = path.join(snapRoot, `${nowTs}${safeLabel ? `-${safeLabel}` : ''}-${randomBytes(5).toString('hex')}`);
    fs.renameSync(stage, dest); stage = null;
    let warning = '';
    try { for (const old of snapshots(snapRoot).slice(0, -MAX_SNAPSHOTS)) fs.rmSync(old.dir, { recursive: true, force: true }); }
    catch (err) { warning = `Snapshot complete, but old-backup pruning failed: ${err.message}`; }
    return { ok: true, dest, warning };
  } catch (err) { return { ok: false, error: `⏪ Snapshot nahi bana: ${err?.message ?? err}` }; }
  finally { if (stage) fs.rmSync(stage, { recursive: true, force: true }); }
}

export function latestSnapshot(snapRoot = SNAP_ROOT) {
  return snapshots(snapRoot).at(-1)?.dir ?? null;
}

export function rollback(opts = {}) {
  const root = path.resolve(opts.root ?? ROOT), snapRoot = path.resolve(opts.snapRoot ?? SNAP_ROOT);
  const src = opts.snapshot == null ? latestSnapshot(snapRoot) : path.resolve(opts.snapshot);
  if (!src) return '⏪ Koi snapshot nahi mila (pehle update hona chahiye tha).';
  let stage, recoveryFailed = false;
  const touched = [];
  try {
    if (path.dirname(src) !== snapRoot) throw new Error('Snapshot must be directly inside the configured backup directory');
    const backup = inspect(src);
    if (!backup.files.has('package-lock.json') && fs.existsSync(path.join(root, 'package-lock.json'))) throw new Error('Legacy snapshot has no package lock; refusing to mix dependency versions');
    stage = fs.mkdtempSync(path.join(root, '.rollback-'));
    const incoming = path.join(stage, 'new'), old = path.join(stage, 'old');
    fs.mkdirSync(incoming); fs.mkdirSync(old);
    for (const name of ITEMS) if (name !== 'package-lock.json' || backup.files.has(name)) copyTree(path.join(src, name), path.join(incoming, name));
    // The complete staged payload must still match, before the first live rename.
    const staged = payload(incoming);
    if (staged.size !== backup.files.size || [...staged].some(([name, hash]) => backup.files.get(name) !== hash)) throw new Error('Snapshot changed during restore');
    for (const name of ITEMS) {
      if (!fs.existsSync(path.join(incoming, name))) continue;
      const item = { name, previous: false, installed: false }; touched.push(item);
      if (fs.existsSync(path.join(root, name))) { fs.renameSync(path.join(root, name), path.join(old, name)); item.previous = true; }
      fs.renameSync(path.join(incoming, name), path.join(root, name)); item.installed = true;
    }
    return `⏪ *Rolled back* to snapshot ${path.basename(src)}\nBot ko restart karo: \`observer.sh service restart\``;
  } catch (err) {
    for (const item of [...touched].reverse()) {
      try {
        if (item.installed) fs.rmSync(path.join(root, item.name), { recursive: true, force: true });
        if (item.previous) fs.renameSync(path.join(stage, 'old', item.name), path.join(root, item.name));
      } catch { recoveryFailed = true; }
    }
    return `⏪ Rollback fail: ${err?.message ?? err}${recoveryFailed ? ` · recovery files preserved: ${stage}` : ''}`;
  } finally { if (stage && !recoveryFailed) fs.rmSync(stage, { recursive: true, force: true }); }
}

export function snapshotList(snapRoot = SNAP_ROOT) {
  if (typeof snapRoot === 'object') snapRoot = snapRoot?.snapRoot ?? SNAP_ROOT;
  const list = snapshots(snapRoot);
  return list.length ? `⏪ *Snapshots*\n${list.map((s) => `• ${path.basename(s.dir)}`).join('\n')}` : '⏩ Koi snapshot nahi hai.';
}
