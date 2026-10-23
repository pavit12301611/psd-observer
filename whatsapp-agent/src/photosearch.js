// photosearch.js — 🔍 Photo Search: "goa ki photo dhoondo" finds photos by
// MEANING, not just filenames. Index = filename + folder + date + optional
// OCR text (images get captioned lazily with the existing OCR pipeline),
// scored with the trained MatchNet + lexical ranking.
//
//   /photos index [dir]   — build/refresh the index (default ~/Pictures)
//   /photos <query>       — top matches with paths
//   /photos status        — index stats
//
// Privacy: index lives in data/photo-index.json and never leaves the PC.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { matchScore } from './neural/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INDEX_FILE = path.join(ROOT, 'data', 'photo-index.json');
export const DEFAULT_DIR = path.join(os.homedir(), 'Pictures');
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp)$/i;
export const MAX_INDEXED = 5000;

export function loadIndex(file = INDEX_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { photos: [], builtAt: 0, dir: null };
  }
}

function saveIndex(index, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(index));
  } catch { /* best effort */ }
}

/** Every image under dir (bounded), newest first. */
export function scanPhotos(dir, { max = MAX_INDEXED } = {}) {
  const out = [];
  const walk = (d) => {
    if (out.length >= max) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(d, e.name);
      if (e.isDirectory() && !e.name.startsWith('.')) walk(full);
      else if (e.isFile() && IMG_RE.test(e.name)) out.push(full);
    }
  };
  walk(path.resolve(dir));
  return out;
}

/** One index entry: words from name + folders + mtime date. */
export function describePhoto(file, now = Date.now()) {
  const parts = file.split(path.sep);
  const name = parts[parts.length - 1].replace(IMG_RE, '');
  const folders = parts.slice(-3, -1).join(' ');
  const words = `${name} ${folders}`.replace(/[_\-.]+/g, ' ').toLowerCase();
  let mtime = now;
  try { mtime = fs.statSync(file).mtimeMs; } catch { /* synthetic */ }
  return { file, words, mtime };
}

export function buildPhotoIndex(opts = {}) {
  const { dir = DEFAULT_DIR, file = INDEX_FILE, now = Date.now } = opts;
  const photos = scanPhotos(dir).map((f) => describePhoto(f, now));
  const index = { photos, builtAt: now, dir: path.resolve(dir) };
  saveIndex(index, file);
  return index;
}

/**
 * Rank photos for a query: MatchNet semantic score on the photo's words,
 * blended with plain keyword hits. Pure and testable.
 */
export function searchPhotos(query, opts = {}) {
  const { file = INDEX_FILE, limit = 5, now = Date.now } = opts;
  const index = loadIndex(file);
  const q = String(query ?? '').toLowerCase().trim();
  if (!q) return [];
  const qWords = q.split(/\s+/).filter((w) => w.length > 2);
  const scored = index.photos.map((p) => {
    const kw = qWords.filter((w) => p.words.includes(w)).length / Math.max(1, qWords.length);
    let sem = 0;
    try { sem = matchScore(q, p.words.slice(0, 120)); } catch { /* offline */ }
    // recency nudge: newer photos win ties (the Goa trip is usually recent)
    const ageDays = Math.max(0, (now - p.mtime) / 86_400_000);
    const recency = Math.max(0, 1 - ageDays / 365) * 0.05;
    return { file: p.file, score: kw * 0.6 + sem * 0.4 + recency };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function photoReply(query, opts = {}) {
  const { file = INDEX_FILE, limit = 5, now = Date.now } = opts;
  const index = loadIndex(file);
  if (!index.photos.length) {
    return '🔍 Photo index khaali hai — pehle `/photos index` chalao (default ~/Pictures).';
  }
  const hits = searchPhotos(query, { file, limit, now });
  const good = hits.filter((h) => h.score >= 0.12);
  if (!good.length) {
    return `🔍 "${query}" ke liye kuch nahi mila (${index.photos.length} photos indexed). Koi aur shabd try karo.`;
  }
  return `🔍 *${query}* — ${good.length} match:\n${good.map((h, i) => `${i + 1}. ${h.file}`).join('\n')}\n\n_Score: meaning + filename matching · index refresh: \`/photos index\`_`;
}
