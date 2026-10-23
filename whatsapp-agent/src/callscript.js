// callscript.js — 📞 Saved call scripts: "/callscript save gym-check Roz gym
// kiya? kitne minute?" → JARVIS call karke script bolta hai. Reuse with
// /callscript <name>. Segments = spoken lines (question marks = wait for
// reply on the call).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCRIPT_FILE = path.join(ROOT, 'data', 'callscripts.json');

export function loadScripts(file = SCRIPT_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { scripts: {} };
  }
}

function saveScripts(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/** Split a script text into spoken segments (sentences). */
export function toSegments(text) {
  return String(text ?? '')
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function saveScript(name, text, opts = {}) {
  const { file = SCRIPT_FILE } = opts;
  const key = String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!key || !text?.trim()) return { ok: false, error: '📞 Usage: `/callscript save <name> <text>`' };
  const data = loadScripts(file);
  data.scripts[key] = { text: String(text), segments: toSegments(text), at: Date.now() };
  saveScripts(data, file);
  return { ok: true, name: key, reply: `📞 *Script "${key}" saved* (${data.scripts[key].segments.length} segments).\nCall: \`/callscript ${key}\`` };
}

export function getScript(name, opts = {}) {
  return loadScripts(opts.file ?? SCRIPT_FILE).scripts[String(name ?? '').trim().toLowerCase().replace(/\s+/g, '-')] ?? null;
}

export function listScripts(opts = {}) {
  const keys = Object.keys(loadScripts(opts.file ?? SCRIPT_FILE).scripts);
  return keys.length
    ? `📞 *Call scripts*\n${keys.map((k) => `• ${k}`).join('\n')}\n\nChalao: \`/callscript <name>\``
    : '📞 Koi script nahi. Save: `/callscript save <name> <text>`';
}

/**
 * Build the spoken plan for a call: segments + which ones are questions.
 * The caller (voicecall) speaks them in order.
 */
export function callPlan(script) {
  if (!script?.segments?.length) return null;
  return script.segments.map((s) => ({
    say: s,
    question: /\?\s*$/.test(s),
  }));
}
