// corrections.js — ✏️ "Galat, asli jawab ye hai" — ek baar bolo, bot hamesha
// ke liye seekh jata hai. Stored overrides win over brain answers, and a
// retrain policy packs corrections into the neural corpus over time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CORR_FILE = path.join(ROOT, 'data', 'corrections.json');
export const RETRAIN_AFTER_DAYS = 7;
export const RETRAIN_AFTER_NEW = 5;

export function loadCorrections(file = CORR_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { items: [], lastTrain: 0 };
  }
}

function saveCorrections(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/** "galat, asli jawab Photosynthesis hai" / "galat. ye hai: ATP" → right side. */
export function parseCorrection(text) {
  const m = String(text ?? '').match(
    /\b(galat|wrong|nahi)\b[,!. ]*\s*(?:asli|actual|sahi|right)?\s*(?:jawab|answer)?\s*(?:to)?\s*(?:ye|yahi|it)?\s*(?:hai|is|:|-)?\s*[:,-]?\s*(.{2,})/i,
  );
  if (!m) return null;
  const right = m[2].trim().replace(/^[:\-,\s]+/, '');
  return right ? { right } : null;
}

export function saveCorrection(question, right, opts = {}) {
  const { file = CORR_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const q = String(question ?? '').trim();
  if (!q || !right) return false;
  const data = loadCorrections(file);
  const existing = data.items.find((i) => i.q.toLowerCase() === q.toLowerCase());
  if (existing) {
    existing.right = String(right);
    existing.at = nowTs;
  } else {
    data.items.push({ q, right: String(right), at: nowTs });
    data.newSinceTrain = (data.newSinceTrain ?? 0) + 1;
  }
  saveCorrections(data, file);
  return true;
}

/** If a stored correction matches the question, override the brain answer. */
export function applyCorrection(question, answer, opts = {}) {
  const { file = CORR_FILE } = opts;
  const q = String(question ?? '').toLowerCase().trim();
  if (!q) return answer;
  const hit = loadCorrections(file).items.find(
    (i) => i.q.toLowerCase() === q || q.includes(i.q.toLowerCase()),
  );
  return hit ? hit.right : answer;
}

export function hasCorrection(question, opts = {}) {
  const q = String(question ?? '').toLowerCase().trim();
  return loadCorrections(opts.file ?? CORR_FILE).items.some(
    (i) => i.q.toLowerCase() === q || q.includes(i.q.toLowerCase()),
  );
}

export function listCorrections(opts = {}) {
  const items = loadCorrections(opts.file ?? CORR_FILE).items;
  if (!items.length) return '✏️ Koi correction saved nahi hai.';
  return `✏️ *Saved corrections* (${items.length})\n${items
    .slice(-10)
    .map((i) => `• ${i.q.slice(0, 50)} → ${i.right.slice(0, 50)}`)
    .join('\n')}`;
}

/** Weekly self-retrain policy: enough new corrections OR 7 days stale. */
export function shouldRetrain(opts = {}) {
  const {
    file = CORR_FILE, now = Date.now,
    maxAgeMs = RETRAIN_AFTER_DAYS * 86_400_000,
    minNew = RETRAIN_AFTER_NEW,
  } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const data = loadCorrections(file);
  const fresh = (data.newSinceTrain ?? 0) >= minNew;
  const stale = nowTs - (data.lastTrain ?? 0) >= maxAgeMs && data.items.length > 0;
  return { due: fresh || stale, fresh, stale, pending: data.newSinceTrain ?? 0 };
}

export function markTrained(opts = {}) {
  const { file = CORR_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const data = loadCorrections(file);
  data.lastTrain = nowTs;
  data.newSinceTrain = 0;
  saveCorrections(data, file);
}

/** Export corrections as {text: label} pairs for train:neural. */
export function asTrainingPairs(opts = {}) {
  return loadCorrections(opts.file ?? CORR_FILE).items.map((i) => ({
    text: i.q,
    label: `correction:${i.right.slice(0, 60)}`,
  }));
}
