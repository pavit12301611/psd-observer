// ocr.js — read the screen / photos / documents on the PC itself, for free.
//
// This is what makes the agent genuinely useful WITHOUT the Observer app:
//   • /ocr        → screenshot → tesseract text (offline)
//   • /look <q>   → screenshot → OCR → free AI answers using what's on screen
//   • a photo/PDF sent on WhatsApp → text → summary
//
// tesseract is optional; every function fails with the exact dnf package to
// install instead of a stack trace. Nothing is uploaded anywhere: OCR and
// screenshots stay on this PC (cloud AI is only used if the owner configured a
// cloud brain, exactly like normal chat).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findBin } from './pccontrol.js';
import * as pc from './pccontrol.js';
import * as ai from './ai.js';

const execFileAsync = promisify(execFile);
const OCR_TIMEOUT = 45_000;
const MAX_TEXT = 12_000;

const TESSERACT_HINT = 'Screen/document OCR needs tesseract: sudo dnf install tesseract tesseract-langpack-hin (the Hindi pack is optional)';

export function ocrAvailable() {
  return Boolean(findBin('tesseract'));
}

function tmpFile(ext) {
  return path.join(os.tmpdir(), `observer-ocr-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
}

/** OCR an image Buffer. Returns extracted text ('' if the image has none). */
export async function ocrImage(buffer, { langs, psm } = {}) {
  if (!buffer?.length) throw new Error('nothing to read');
  const bin = findBin('tesseract');
  if (!bin) throw new Error(TESSERACT_HINT);
  const file = tmpFile('png');
  try {
    fs.writeFileSync(file, buffer);
    const args = [file, 'stdout'];
    if (langs) args.push('-l', langs);
    args.push('--psm', String(psm ?? 3));
    const { stdout } = await execFileAsync(bin, args, { timeout: OCR_TIMEOUT, maxBuffer: 8 * 1024 * 1024 });
    return String(stdout ?? '').replace(/\u000c/g, '').trim().slice(0, MAX_TEXT);
  } finally {
    try { fs.unlinkSync(file); } catch { /* noop */ }
  }
}

/** Screenshot → text. Throws with a useful message when a tool is missing. */
export async function ocrScreen(config) {
  const image = await pc.captureScreenshot({ portalTimeoutMs: config?.portalTimeoutMs });
  const text = await ocrImage(image, { langs: config?.ocrLangs || 'eng' });
  return { image, text };
}

/** Extract plain text from a WhatsApp document (PDF / DOCX / TXT / code). */
export async function extractDocumentText(buffer, fileName = '', mimetype = '') {
  if (!buffer?.length) throw new Error('empty document');
  const ext = path.extname(fileName).toLowerCase() || '';
  const name = String(fileName || '').toLowerCase();
  const isPdf = ext === '.pdf' || mimetype === 'application/pdf';
  const isDocx = ext === '.docx' || name.endsWith('.docx') || String(mimetype).includes('wordprocessingml');
  const isText = /\.(txt|md|markdown|csv|tsv|json|log|ya?ml|xml|html?|css|js|ts|jsx|tsx|py|sh|rs|go|java|c|cpp|h|ini|conf|env|sql)$/.test(ext)
    || String(mimetype).startsWith('text/');
  if (isText) return buffer.toString('utf8').slice(0, MAX_TEXT);
  if (isPdf) {
    const pdftotext = findBin('pdftotext');
    if (!pdftotext) throw new Error('Reading PDFs needs poppler-utils: sudo dnf install poppler-utils');
    const file = tmpFile('pdf');
    try {
      fs.writeFileSync(file, buffer);
      const { stdout } = await execFileAsync(pdftotext, ['-layout', file, '-'], { timeout: OCR_TIMEOUT, maxBuffer: 16 * 1024 * 1024 });
      return String(stdout ?? '').replace(/\u000c/g, '').trim().slice(0, MAX_TEXT);
    } finally {
      try { fs.unlinkSync(file); } catch { /* noop */ }
    }
  }
  if (isDocx) {
    const unzip = findBin('unzip');
    if (!unzip) throw new Error('Reading DOCX needs unzip: sudo dnf install unzip');
    const file = tmpFile('docx');
    try {
      fs.writeFileSync(file, buffer);
      const { stdout } = await execFileAsync(unzip, ['-p', file, 'word/document.xml'], { timeout: OCR_TIMEOUT, maxBuffer: 16 * 1024 * 1024 });
      return String(stdout ?? '')
        .replace(/<\/w:p>/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n\n')
        .trim().slice(0, MAX_TEXT);
    } finally {
      try { fs.unlinkSync(file); } catch { /* noop */ }
    }
  }
  if (/^image\//.test(String(mimetype)) || /\.(png|jpe?g|webp|gif|bmp)$/.test(ext)) {
    return ocrImage(buffer, {});
  }
  return buffer.toString('utf8').replace(/[^\x09\x0a\x0d\x20-\x7e\u0900-\u097f]/g, ' ').trim().slice(0, MAX_TEXT);
}

/**
 * "What's on my screen?" without Observer: screenshot + OCR + the free AI.
 * Returns { image, text } where text is an answer, not a wall of OCR.
 */
export async function lookAtScreen(config, question = '', log = console) {
  const { image, text } = await ocrScreen(config);
  const cleaned = text.replace(/\n{3,}/g, '\n\n').trim();
  const ask = question?.trim();
  if (!cleaned) {
    return { image, text: '🖥️ Screenshot attached. I couldn\'t read any text on the screen (maybe it\'s mostly images or a video).' };
  }
  const prompt = [
    ask
      ? `The owner asks: "${ask}"`
      : 'The owner wants to know what is on their screen right now.',
    'Below is the text OCR read from their screen (it may contain OCR mistakes, UI labels, chat messages, code, etc).',
    'Answer briefly in the owner\'s language (Hinglish if they used Hinglish). Use at most ~10 short lines.',
    'If the question cannot be answered from this text, say what you can see and what is unclear — never invent.',
    '',
    cleaned.slice(0, 8000),
  ].join('\n');
  const done = await ai.complete(config, prompt, log);
  if (!done) {
    return {
      image,
      text: `🖥️ *Screen text (OCR, no AI brain configured)*\n\n${cleaned.slice(0, 1500)}${cleaned.length > 1500 ? '\n…' : ''}\n\n_Install Ollama (/model) for a real answer about the screen._`,
    };
  }
  return { image, text: `🖥️ *On your screen*\n\n${done.text}` };
}
