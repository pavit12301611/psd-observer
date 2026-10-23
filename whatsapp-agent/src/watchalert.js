// watchalert.js — 👀 Watch & Alert: page change / price drop / repo release /
// keyword appearance — bot khud poll karta hai aur ping karta hai.
//   /watch add <url> [price<5000 | contains <text> | release]
//   /watch list · /watch off <id> · /watch check
// `fetchText(url)` injected (prod: reach.js). Poll loop heartbeat pe.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WATCH_FILE = path.join(ROOT, 'data', 'watchers.json');
export const MAX_WATCHERS = 20;

export function loadWatchers(file = WATCH_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { watchers: [] };
  }
}

function saveWatchers(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/** Parse "price<5000" / "contains foo bar" / "release" rules. */
export function parseRule(text) {
  const s = String(text ?? '').trim();
  const price = s.match(/price\s*[<>=!]+\s*([\d,]+)/i);
  if (price) {
    const num = Number(price[1].replace(/,/g, ''));
    const op = (s.match(/price\s*([<>=!]+)/i) ?? [])[1] ?? '<';
    return { kind: 'price', value: num, op };
  }
  const contains = s.match(/contains\s+(.+)$/i);
  if (contains) return { kind: 'contains', value: contains[1].trim().toLowerCase() };
  if (/release|version/i.test(s)) return { kind: 'release' };
  return { kind: 'change' }; // any-change watch
}

export function addWatch(url, ruleText, opts = {}) {
  const { file = WATCH_FILE, now = Date.now } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const data = loadWatchers(file);
  if (data.watchers.length >= MAX_WATCHERS) return { ok: false, error: '👀 Watch limit full (20).' };
  const rule = parseRule(ruleText);
  const w = {
    id: String(nowTs).slice(-6),
    url: String(url).trim(),
    rule,
    lastFingerprint: null,
    lastAlert: 0,
    at: nowTs,
  };
  data.watchers.push(w);
  saveWatchers(data, file);
  return { ok: true, watcher: w, reply: `👀 *Watch ON* — ${w.url}\nRule: ${rule.kind}${rule.value ? ` ${rule.value}` : ''}\nCheck: \`/watch check\` · Off: \`/watch off ${w.id}\`` };
}

export function removeWatch(id, opts = {}) {
  const { file = WATCH_FILE } = opts;
  const data = loadWatchers(file);
  const before = data.watchers.length;
  data.watchers = data.watchers.filter((w) => w.id !== String(id));
  saveWatchers(data, file);
  return data.watchers.length < before ? `👀 Watch ${id} hata diya.` : '👀 Wo id kisi watch me nahi hai.';
}

/** Extract first ₹/$ price from a page (best effort). */
export function extractPrice(text) {
  const m = String(text ?? '').match(/(?:₹|rs\.?|inr|\$)\s*([\d,]+(?:\.\d{1,2})?)/i);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function fingerprint(text, rule) {
  if (rule.kind === 'price') return String(extractPrice(text) ?? '');
  if (rule.kind === 'contains') return String(text ?? '').toLowerCase().includes(rule.value) ? 'hit' : '';
  if (rule.kind === 'release') {
    const m = String(text ?? '').match(/v?\d+\.\d+(?:\.\d+)?/);
    return m ? m[0] : '';
  }
  // generic change: length+hash-ish stand-in
  return `${String(text ?? '').length}:${String(text ?? '').slice(0, 40)}`;
}

/**
 * Check one watcher. Returns alert message or null.
 * `fetchText(url)` is injected. Pure decision + one fetch.
 */
export async function checkWatch(w, fetchText, opts = {}) {
  const { now = Date.now, cooldownMs = 30 * 60_000 } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  let page;
  try {
    page = await fetchText(w.url);
  } catch {
    return null;
  }
  const fp = fingerprint(page, w.rule);
  const price = extractPrice(page);
  let alert = null;
  const lastAlert = w.lastAlert ?? 0;
  const cooled = lastAlert === 0 || nowTs - lastAlert >= cooldownMs; // 0 = never alerted

  if (w.rule.kind === 'price') {
    const target = w.rule.value;
    const hit = price != null && (w.rule.op === '>' ? price > target : price < target);
    if (hit && cooled) {
      alert = `🔔 *Price alert* — ${w.url}\nAbhi: ₹${price} (target ${w.rule.op}${target})`;
    }
  } else if (w.rule.kind === 'contains') {
    if (fp === 'hit' && cooled) {
      alert = `🔔 *Keyword mila* ("${w.rule.value}") — ${w.url}`;
    }
  } else {
    // change / release: fingerprint flip = alert
    if (w.lastFingerprint != null && fp !== w.lastFingerprint && cooled) {
      alert = w.rule.kind === 'release'
        ? `🔔 *Naya release* (${fp}) — ${w.url}`
        : `🔔 *Page change hua* — ${w.url}`;
    }
  }
  if (alert) w.lastAlert = nowTs;
  w.lastFingerprint = fp;
  return alert;
}

/** Check all watchers; returns {alerts, checked}. Persists new fingerprints. */
export async function checkAll(opts = {}) {
  const { file = WATCH_FILE, fetchText, now = Date.now } = opts;
  const data = loadWatchers(file);
  const alerts = [];
  for (const w of data.watchers) {
    const a = await checkWatch(w, fetchText, { now });
    if (a) alerts.push(a);
  }
  saveWatchers(data, file);
  return { alerts, checked: data.watchers.length };
}

export function watchList(opts = {}) {
  const data = loadWatchers(opts.file ?? WATCH_FILE);
  if (!data.watchers.length) return '👀 Koi watcher nahi. Add: `/watch add <url> [price<5000]`';
  return `👀 *Watchers* (${data.watchers.length})\n${data.watchers
    .map((w) => `• [${w.id}] ${w.url} — ${w.rule.kind}${w.rule.value ? ` ${w.rule.value}` : ''}`)
    .join('\n')}`;
}
