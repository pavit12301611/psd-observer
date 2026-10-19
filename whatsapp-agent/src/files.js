// files.js — read, write, search, zip, download and delete files from
// WhatsApp, safely inside the owner's home folder.
//
// Delivery is the point: files you ask for come back as WhatsApp documents, so
// the PC becomes a file server you can drive from a chat. Every path is
// resolved through realpath and must stay inside $HOME (or FILES_EXTRA_ROOTS),
// and secrets (SSH/GPG keys, the WhatsApp login) are blocked on purpose.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findBin } from './pccontrol.js';

const execFileAsync = promisify(execFile);
const RUN_TIMEOUT = 10_000;
const MAX_READ = 200 * 1024;
const MAX_SEND = 64 * 1024 * 1024; // WhatsApp document limit

const BLOCKED = ['.ssh', '.gnupg', 'auth_info', path.join('.local', 'share', 'keyrings'), path.join('.config', 'evolution')];
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '__pycache__', '.local', 'venv', '.venv', 'target', 'dist', 'build']);

export function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** Roots the file tools may touch. */
export function allowedRoots(extra = []) {
  const home = os.homedir();
  return [fs.realpathSync(home), ...extra.filter(Boolean).map((r) => {
    const raw = String(r).replace(/^~(?=$|\/)/, home);
    try { return fs.realpathSync(raw); } catch { return path.resolve(raw); }
  })];
}

// Fedora/GNOME folders are capitalised; people type "downloads". Map the
// common ones (and fix the case of any existing folder) instead of failing.
const COMMON_DIRS = {
  download: 'Downloads', downloads: 'Downloads',
  document: 'Documents', documents: 'Documents', docs: 'Documents',
  desktop: 'Desktop', pictures: 'Pictures', picture: 'Pictures',
  photos: 'Pictures', photo: 'Pictures', images: 'Pictures',
  music: 'Music', songs: 'Music', videos: 'Videos', video: 'Videos',
  movies: 'Videos', movie: 'Videos', templates: 'Templates', public: 'Public',
};

/** Case/alias-correct a path under $HOME ("~/downloads/x" → "~/Downloads/x"). */
export function smartHomePath(absolute) {
  const home = os.homedir();
  const rel = path.relative(home, absolute);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return absolute;
  const parts = rel.split(path.sep);
  let current = home;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || part === '.') continue;
    const direct = path.join(current, part);
    let exists = false;
    try { fs.statSync(direct); exists = true; } catch { /* try alias */ }
    if (exists) { current = direct; continue; }
    const wanted = COMMON_DIRS[part.toLowerCase()] ?? part;
    let entries = [];
    try { entries = fs.readdirSync(current); } catch { return path.join(current, ...parts.slice(i)); }
    const hit = entries.find((name) => name.toLowerCase() === wanted.toLowerCase());
    if (hit) { current = path.join(current, hit); continue; }
    return path.join(current, ...parts.slice(i));
  }
  return current;
}

function inside(real, roots) {
  return roots.some((root) => real === root || real.startsWith(root + path.sep));
}

/**
 * Resolve a user-supplied path. `mustExist` false means new paths are allowed
 * (their parent must still resolve inside a root).
 */
export function resolvePath(input, { extraRoots = [], mustExist = false } = {}) {
  const home = os.homedir();
  let wanted = String(input ?? '').trim();
  if (!wanted) return { ok: false, reason: 'no path given' };
  if (wanted === '~') wanted = home;
  else if (wanted.startsWith('~/')) wanted = path.join(home, wanted.slice(2));
  const absolute = smartHomePath(path.isAbsolute(wanted) ? path.normalize(wanted) : path.join(home, wanted));
  const roots = allowedRoots(extraRoots);

  if (mustExist) {
    let real;
    try { real = fs.realpathSync(absolute); } catch { return { ok: false, reason: `"${input}" doesn't exist.` }; }
    if (!inside(real, roots)) return { ok: false, reason: `"${input}" is outside the allowed folders (your home${extraRoots.length ? ' + configured roots' : ''}).` };
    const rel = path.relative(roots[0], real);
    if (BLOCKED.some((b) => rel === b || rel.startsWith(b + path.sep) || rel.split(path.sep).includes('auth_info'))) {
      return { ok: false, reason: 'That folder is blocked on purpose (passwords / WhatsApp login live there).' };
    }
    return { ok: true, path: real };
  }

  // New path: nearest existing ancestor must be inside a root.
  let parent = path.dirname(absolute);
  while (parent && parent !== path.dirname(parent) && !fs.existsSync(parent)) parent = path.dirname(parent);
  let parentReal;
  try { parentReal = fs.realpathSync(parent); } catch { return { ok: false, reason: 'that path is not usable' }; }
  if (!inside(parentReal, roots)) return { ok: false, reason: `"${input}" is outside the allowed folders (your home${extraRoots.length ? ' + configured roots' : ''}).` };
  return { ok: true, path: absolute };
}

export function listDirectory(dir, { extraRoots = [], limit = 60 } = {}) {
  const resolved = resolvePath(dir || '~', { extraRoots, mustExist: true });
  if (!resolved.ok) throw new Error(resolved.reason);
  const stat = fs.statSync(resolved.path);
  if (!stat.isDirectory()) throw new Error(`"${dir}" is a file, not a folder.`);
  const entries = fs.readdirSync(resolved.path, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .slice(0, limit)
    .map((e) => {
      const full = path.join(resolved.path, e.name);
      let size = 0;
      try { size = e.isDirectory() ? 0 : fs.statSync(full).size; } catch { /* noop */ }
      return { name: e.name, dir: e.isDirectory(), size, full };
    })
    .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  const shown = resolved.path.replace(os.homedir(), '~');
  if (!entries.length) return `📂 ${shown} is empty.`;
  return `📂 *${shown}*\n\n` + entries.map((e) => `${e.dir ? '📁' : '📄'} ${e.name}${e.dir ? '/' : ` · ${humanSize(e.size)}`}`).join('\n') +
    '\n\nRead: /read <path> · fetch here: /send <path>';
}

export function readTextFile(file, { extraRoots = [], maxBytes = MAX_READ } = {}) {
  const resolved = resolvePath(file, { extraRoots, mustExist: true });
  if (!resolved.ok) throw new Error(resolved.reason);
  const stat = fs.statSync(resolved.path);
  if (stat.isDirectory()) return listDirectory(resolved.path, { extraRoots });
  if (stat.size > maxBytes) throw new Error(`That file is ${humanSize(stat.size)} — too big to read in a chat (limit ${humanSize(maxBytes)}). /send <path> sends the whole file.`);
  const buffer = fs.readFileSync(resolved.path);
  // Reject obvious binaries instead of dumping mojibake.
  if (buffer.includes(0)) throw new Error('That looks like a binary file. /send <path> sends it as a document instead.');
  const text = buffer.toString('utf8');
  return `📄 *${path.basename(resolved.path)}* · ${humanSize(stat.size)}\n\`\`\`\n${text.slice(0, 6000)}${text.length > 6000 ? '\n…' : ''}\n\`\`\``;
}

export function writeTextFile(file, text, { extraRoots = [], append = false } = {}) {
  const resolved = resolvePath(file, { extraRoots });
  if (!resolved.ok) throw new Error(resolved.reason);
  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  if (append) fs.appendFileSync(resolved.path, String(text ?? ''));
  else fs.writeFileSync(resolved.path, String(text ?? ''));
  const size = fs.statSync(resolved.path).size;
  return `💾 ${append ? 'Appended to' : 'Saved'} *${path.basename(resolved.path)}* (${humanSize(size)}) → ${resolved.path.replace(os.homedir(), '~')}`;
}

export async function deletePath(target, { extraRoots = [] } = {}) {
  const resolved = resolvePath(target, { extraRoots, mustExist: true });
  if (!resolved.ok) throw new Error(resolved.reason);
  if (resolved.path === fs.realpathSync(os.homedir())) throw new Error('I will not delete your home folder.');
  const gio = findBin('gio');
  if (gio) {
    try {
      await execFileAsync(gio, ['trash', '--', resolved.path], { timeout: RUN_TIMEOUT });
      return `🗑️ Moved *${path.basename(resolved.path)}* to the trash (recoverable).`;
    } catch { /* no trash available: permanent delete below */ }
  }
  fs.rmSync(resolved.path, { recursive: true, force: true });
  return `🗑️ Permanently deleted *${path.basename(resolved.path)}*.`;
}

/** Search by filename under a folder (default: home), skipping heavy dirs. */
export async function searchFiles(query, { extraRoots = [], root, maxResults = 25, maxDepth = 6 } = {}) {
  const needle = String(query ?? '').toLowerCase().trim();
  if (!needle) throw new Error('usage: /find <part of filename>');
  const resolved = resolvePath(root || '~', { extraRoots, mustExist: true });
  if (!resolved.ok) throw new Error(resolved.reason);
  const base = resolved.path;
  const results = [];
  let visited = 0;
  async function walk(dir, depth) {
    if (depth > maxDepth || visited > 40_000 || results.length >= maxResults) return;
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited++ > 40_000 || results.length >= maxResults) return;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name.toLowerCase().includes(needle)) results.push(full);
      if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !BLOCKED.includes(entry.name)) await walk(full, depth + 1);
    }
  }
  await walk(base, 0);
  if (!results.length) return `🔎 Nothing under ${base.replace(os.homedir(), '~')} matches "${query}".`;
  return `🔎 *Found ${results.length}* (search: ${base.replace(os.homedir(), '~')})\n\n` +
    results.map((f) => {
      let size = '';
      try { size = ` · ${humanSize(fs.statSync(f).size)}`; } catch { /* noop */ }
      return `📄 ${f.replace(os.homedir(), '~')}${size}`;
    }).join('\n') +
    '\n\nRead one with /read <path> · fetch it with /send <path>';
}

/** Build a WhatsApp document reply for a PC file. */
export function fileReply(file, { extraRoots = [] } = {}) {
  const resolved = resolvePath(file, { extraRoots, mustExist: true });
  if (!resolved.ok) throw new Error(resolved.reason);
  const stat = fs.statSync(resolved.path);
  if (stat.isDirectory()) {
    throw new Error(`"${file}" is a folder. Zip it first: /zip ${file}`);
  }
  if (stat.size > MAX_SEND) throw new Error(`That file is ${humanSize(stat.size)} — over WhatsApp's 64 MB document limit. /zip it or copy it to data/shared/.`);
  const name = path.basename(resolved.path);
  const mime = mimeFor(name);
  return {
    text: `📄 ${name} (${humanSize(stat.size)})`,
    document: { buffer: fs.readFileSync(resolved.path), fileName: name, mimetype: mime, path: resolved.path },
  };
}

export function mimeFor(name) {
  const ext = path.extname(String(name ?? '')).toLowerCase();
  return {
    '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.md': 'text/markdown',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.json': 'application/json', '.csv': 'text/csv', '.apk': 'application/vnd.android.package-archive',
  }[ext] ?? 'application/octet-stream';
}

/** Zip files/folders into one archive inside the home folder. */
export async function zipPaths(targets, output, { extraRoots = [] } = {}) {
  const zip = findBin('zip');
  if (!zip) throw new Error('Zipping needs the zip package: sudo dnf install zip');
  const list = (Array.isArray(targets) ? targets : [targets]).map(String).filter(Boolean);
  if (!list.length) throw new Error('usage: /zip <path> [path2 …]');
  const resolvedTargets = list.map((t) => {
    const r = resolvePath(t, { extraRoots, mustExist: true });
    if (!r.ok) throw new Error(r.reason);
    return r.path;
  });
  const out = resolvePath(output || `${path.basename(resolvedTargets[0])}.zip`, { extraRoots });
  if (!out.ok) throw new Error(out.reason);
  try { fs.unlinkSync(out.path); } catch { /* noop */ }
  // -j? no: preserve folders. Run from $HOME so paths stay short.
  await execFileAsync(zip, ['-r', '-q', out.path, ...resolvedTargets], { timeout: 120_000, cwd: os.homedir() });
  const size = fs.statSync(out.path).size;
  return `🗜️ Created *${path.basename(out.path)}* (${humanSize(size)}) → ${out.path.replace(os.homedir(), '~')}\nSend it here: /send ${out.path.replace(os.homedir(), '~')}`;
}

export async function unzipPath(file, { extraRoots = [], dest } = {}) {
  const unzip = findBin('unzip');
  if (!unzip) throw new Error('Unzipping needs unzip: sudo dnf install unzip');
  const resolved = resolvePath(file, { extraRoots, mustExist: true });
  if (!resolved.ok) throw new Error(resolved.reason);
  const target = dest
    ? resolvePath(dest, { extraRoots })
    : { ok: true, path: resolved.path.replace(/\.zip$/i, '') || `${resolved.path}-unzipped` };
  if (!target.ok) throw new Error(target.reason);
  fs.mkdirSync(target.path, { recursive: true });
  await execFileAsync(unzip, ['-o', '-q', resolved.path, '-d', target.path], { timeout: 120_000 });
  return `📂 Unzipped *${path.basename(resolved.path)}* into ${target.path.replace(os.homedir(), '~')}`;
}

/** Download a URL straight to the PC (no browser needed). */
export async function downloadUrl(url, dest, { extraRoots = [] } = {}) {
  const clean = String(url ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(clean)) throw new Error('usage: /download <https://link> [path]');
  const curl = findBin('curl');
  const target = dest ? resolvePath(dest, { extraRoots }) : { ok: true, path: null };
  if (!target.ok) throw new Error(target.reason);
  let outPath = target.path;
  if (!outPath) {
    const base = (() => {
      try { return decodeURIComponent(new URL(clean).pathname.split('/').filter(Boolean).pop() || ''); } catch { return ''; }
    })();
    const safe = (base || `download-${Date.now()}`).replace(/[^\w.\- ]/g, '_');
    outPath = path.join(os.homedir(), 'Downloads', safe);
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  if (!curl) throw new Error('Downloading needs curl: sudo dnf install curl');
  await execFileAsync(curl, ['-L', '--fail', '--max-time', '900', '-o', outPath, clean], { timeout: 920_000, maxBuffer: 1024 * 1024 });
  const size = fs.statSync(outPath).size;
  return `⬇️ Downloaded *${path.basename(outPath)}* (${humanSize(size)}) → ${outPath.replace(os.homedir(), '~')}\nSend it here: /send ${outPath.replace(os.homedir(), '~')}`;
}

/** Move/rename a file or folder (works across filesystems by copy+delete). */
export function movePath(from, to, { extraRoots = [] } = {}) {
  const src = resolvePath(from, { extraRoots, mustExist: true });
  if (!src.ok) throw new Error(src.reason);
  const dest = resolvePath(to, { extraRoots });
  if (!dest.ok) throw new Error(dest.reason);
  fs.mkdirSync(path.dirname(dest.path), { recursive: true });
  try {
    fs.renameSync(src.path, dest.path);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src.path, dest.path, { recursive: true });
    fs.rmSync(src.path, { recursive: true, force: true });
  }
  return `📦 Moved *${path.basename(src.path)}* → ${dest.path.replace(os.homedir(), '~')}`;
}

export function copyPath(from, to, { extraRoots = [] } = {}) {
  const src = resolvePath(from, { extraRoots, mustExist: true });
  if (!src.ok) throw new Error(src.reason);
  const dest = resolvePath(to, { extraRoots });
  if (!dest.ok) throw new Error(dest.reason);
  fs.mkdirSync(path.dirname(dest.path), { recursive: true });
  fs.cpSync(src.path, dest.path, { recursive: true });
  return `📋 Copied *${path.basename(src.path)}* → ${dest.path.replace(os.homedir(), '~')}`;
}

export function makeDir(target, { extraRoots = [] } = {}) {
  const dest = resolvePath(target, { extraRoots });
  if (!dest.ok) throw new Error(dest.reason);
  fs.mkdirSync(dest.path, { recursive: true });
  return `📁 Created folder ${dest.path.replace(os.homedir(), '~')}`;
}
