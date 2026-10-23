// clipboard.js — 📋↔️📱 Clipboard Sync: `/clip` pulls the PC clipboard to
// WhatsApp, `/copy <text>` pushes text from WhatsApp to the PC clipboard
// (xclip/wl-copy). History keeps the last 10 for `/clip list`.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLIP_FILE = path.join(ROOT, 'data', 'clipboard-history.json');
export const MAX_HISTORY = 10;
export const MAX_CLIP_CHARS = 3500;

export function loadHistory(file = CLIP_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { entries: [] };
  }
}

function saveHistory(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

function pushHistory(text, file) {
  const data = loadHistory(file);
  data.entries = [{ at: Date.now(), text }, ...data.entries.filter((e) => e.text !== text)].slice(0, MAX_HISTORY);
  saveHistory(data, file);
}

/** Read PC clipboard text (Wayland wl-paste → X11 xclip). */
export async function readClipboard(run = execFileAsync) {
  try {
    const { stdout } = await run('wl-paste', ['-n'], { timeout: 3000, maxBuffer: 1024 * 1024 });
    return String(stdout ?? '');
  } catch {
    try {
      const { stdout } = await run('xclip', ['-selection', 'clipboard', '-o'], { timeout: 3000, maxBuffer: 1024 * 1024 });
      return String(stdout ?? '');
    } catch {
      return null;
    }
  }
}

/** Write text to the PC clipboard. */
export async function writeClipboard(text, run = execFileAsync) {
  const t = String(text ?? '').slice(0, MAX_CLIP_CHARS);
  try {
    await run('wl-copy', [], { input: t, timeout: 3000 });
    return true;
  } catch {
    try {
      await run('xclip', ['-selection', 'clipboard', '-i'], { input: t, timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
}

export async function clipPull(opts = {}) {
  const { run = execFileAsync, file = CLIP_FILE } = opts;
  const text = await readClipboard(run);
  if (text == null) return '📋 PC clipboard read nahi hua (xclip/wl-clipboard install karo).';
  if (!text.trim()) return '📋 PC clipboard khaali hai.';
  pushHistory(text, file);
  return `📋 *PC clipboard*\n${text.slice(0, MAX_CLIP_CHARS)}${text.length > MAX_CLIP_CHARS ? '\n…(trimmed)' : ''}`;
}

export async function clipPush(text, opts = {}) {
  const { run = execFileAsync, file = CLIP_FILE } = opts;
  const ok = await writeClipboard(text, run);
  if (!ok) return '📋 PC clipboard pe likh nahi paya (xclip/wl-clipboard install karo).';
  pushHistory(text, file);
  return `📋 *PC clipboard pe set:* ${String(text).slice(0, 200)}${String(text).length > 200 ? '…' : ''}`;
}

export function clipList(opts = {}) {
  const { file = CLIP_FILE } = opts;
  const entries = loadHistory(file).entries;
  if (!entries.length) return '📋 Clipboard history khaali hai.';
  return `📋 *Clipboard history*\n${entries.map((e, i) => `${i + 1}. ${e.text.slice(0, 120).replace(/\n/g, ' ')}`).join('\n')}`;
}
