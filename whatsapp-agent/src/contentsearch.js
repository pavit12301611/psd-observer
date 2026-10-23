// contentsearch.js — 🔎 File CONTENT search: "jisme GST number hai wo pdf
// dhundo" — naam yaad na ho tab bhi file mile. Grep + scoring; PDFs me
// pdftotext best-effort.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TEXT_RE = /\.(txt|md|csv|json|log|js|py|html|css|xml|ya?ml|sql|sh|env)$/i;
const PDF_RE = /\.pdf$/i;
export const MAX_FILES = 800;

async function readMaybe(file, run) {
  if (TEXT_RE.test(file)) {
    try { return fs.readFileSync(file, 'utf8').slice(0, 200_000); } catch { return ''; }
  }
  if (PDF_RE.test(file)) {
    try {
      const { stdout } = await run('pdftotext', ['-q', file, '-'], { timeout: 15_000 });
      return String(stdout ?? '').slice(0, 200_000);
    } catch { return ''; }
  }
  return '';
}

/**
 * Search content under root. Returns [{file, score, snippet}] ranked.
 * `run` = execFile (injected in tests for pdfs).
 */
export async function searchContent(query, opts = {}) {
  const {
    root = os.homedir(),
    run = execFileAsync,
    limit = 8,
    maxDepth = 6,
  } = opts;
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const qWords = q.split(/\s+/).filter((w) => w.length > 2);
  const results = [];

  const walk = async (dir, depth) => {
    if (results.length >= MAX_FILES || depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && (TEXT_RE.test(e.name) || PDF_RE.test(e.name))) {
        const body = await readMaybe(full, run);
        if (!body) continue;
        const lower = body.toLowerCase();
        const nameLower = e.name.toLowerCase();
        const occurrences = qWords.reduce((s, w) => s + (lower.split(w).length - 1), 0);
        const nameHit = qWords.some((w) => nameLower.includes(w));
        if (occurrences === 0 && !nameHit) continue;
        const score = occurrences + (nameHit ? 3 : 0);
        const idx = lower.indexOf(qWords[0] ?? q);
        const snippet = idx >= 0
          ? body.slice(Math.max(0, idx - 40), idx + 80).replace(/\s+/g, ' ')
          : `(${e.name})`;
        results.push({ file: full, score, snippet });
      }
    }
  };

  await walk(path.resolve(root), 0);
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function contentReply(hits, query) {
  if (!hits.length) return `🔎 "${query}" kisi file ke content me nahi mila.`;
  return `🔎 *Content search* — "${query}"\n${hits
    .map((h, i) => `${i + 1}. ${h.file}\n   …${h.snippet.slice(0, 90)}…`)
    .join('\n')}`;
}
