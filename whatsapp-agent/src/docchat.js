// docchat.js — 📄 Document Q&A: send a doc path, then chat with it.
// `/doc <path>` loads it (txt/md instantly; pdf via pdftotext), `/doc q
// <question>` answers strictly from the document, `/doc clear` closes it.
// The doc text never leaves the machine except to the owner's own AI brain.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const MAX_DOC_CHARS = 24_000; // ~6k tokens — enough for most chapters

let session = null; // { file, text, loadedAt }

export function docStatus() {
  if (!session) return '📄 Doc Q&A: koi doc loaded nahi. `/doc <path>` se load karo.';
  return `📄 Doc loaded: *${path.basename(session.file)}* (${session.text.length} chars) · ask: \`/doc q <question>\` · clear: \`/doc clear\``;
}

export function clearDoc() {
  if (!session) return '📄 Koi doc loaded hi nahi tha.';
  const name = path.basename(session.file);
  session = null;
  return `📄 *${name}* hata diya.`;
}

/** Extract text: plain files directly, PDFs via pdftotext when available. */
export async function extractDocText(file, opts = {}) {
  const { run = execFileAsync } = opts;
  const lower = file.toLowerCase();
  if (/\.(txt|md|markdown|csv|json|log|js|py|html|css|xml|yaml|yml)$/.test(lower)) {
    return fs.readFileSync(file, 'utf8');
  }
  if (lower.endsWith('.pdf')) {
    const { stdout } = await run('pdftotext', ['-q', file, '-'], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return String(stdout ?? '');
  }
  // last resort: try reading as text anyway (odt/docx will be garbage — honest)
  return fs.readFileSync(file, 'utf8');
}

export async function loadDoc(file, opts = {}) {
  const resolved = path.resolve(String(file ?? '').trim());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    return { ok: false, error: `📄 File nahi mili: ${file}` };
  }
  try {
    const raw = await extractDocText(resolved, opts);
    const text = raw.slice(0, MAX_DOC_CHARS);
    if (!text.trim()) return { ok: false, error: '📄 File se text nahi nikla (scanned PDF? `/solve` OCR better rahega).' };
    session = { file: resolved, text, loadedAt: Date.now() };
    return {
      ok: true,
      reply: `📄 *Loaded: ${path.basename(resolved)}* (${text.length} chars)\nAb sawal poochho: \`/doc q <question>\`\nStatus: \`/doc status\` · Clear: \`/doc clear\``,
    };
  } catch (err) {
    return { ok: false, error: `📄 Padh nahi paya: ${err?.message ?? err}${file.toLowerCase().endsWith('.pdf') ? ' (pdftotext chahiye: sudo dnf install poppler-utils)' : ''}` };
  }
}

/** Answer a question strictly from the loaded doc. `ask(q, context)` is the AI. */
export async function askDoc(question, opts = {}) {
  const { ask } = opts;
  if (!session) return '📄 Pehle doc load karo: `/doc <path>`';
  if (typeof ask !== 'function') return '📄 AI brain nahi mila — `/brains` se setup karo.';
  const prompt = [
    'Answer STRICTLY from the document below. If the answer is not in it, say so plainly.',
    '',
    `=== DOCUMENT: ${path.basename(session.file)} ===`,
    session.text.slice(0, MAX_DOC_CHARS),
    '=== END DOCUMENT ===',
    '',
    `Question: ${question}`,
  ].join('\n');
  try {
    const answer = await ask(prompt);
    return `📄 *${path.basename(session.file)}*\n${answer}`;
  } catch (err) {
    return `📄 Sawal nahi chal paya: ${err?.message ?? err}`;
  }
}

export function currentDoc() {
  return session;
}
