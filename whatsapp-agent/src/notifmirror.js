// notifmirror.js — 🔔 PC Notification Mirror: desktop popups → WhatsApp.
// Listens to the freedesktop notification bus via `gdbus monitor` (GNOME —
// graceful no-op elsewhere), filters to an allowlist, throttles bursts, and
// forwards each popup to the owner. Privacy first: NOTHING is mirrored until
// the owner turns it on and (optionally) sets the allowlist.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_STATE_FILE = path.join(ROOT, 'data', 'notifmirror.json');
export const MAX_PER_MINUTE = 6;

export function loadMirrorState(stateFile = DEFAULT_STATE_FILE) {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { enabled: false, allow: [] }; // empty allow = ALL apps (owner choice)
  }
}

function saveMirrorState(state, stateFile) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  } catch { /* best effort */ }
}

/**
 * Parse one `gdbus monitor` line of a Notification signal into
 * { app, summary, body } or null. Shape:
 *   ...Notification (uint32 42, '', 'Spotify', 'Now playing', 'Artist — Song', ...
 */
export function parseNotificationLine(line) {
  const m = String(line ?? '').match(/\.Notifications\.Notification\s*\((.*)$/);
  if (!m) return null;
  // pull quoted strings in order: app_name, summary, body
  const quoted = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'|\"((?:[^\"\\]|\\.)*)\"/g)]
    .map((q) => (q[1] ?? q[2]).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\n/g, ' '));
  if (quoted.length < 2) return null;
  // freedesktop signature: (uint32 replaces_id, string app_icon, string app_name,
  // string summary, string body, ...) — quoted[0] is the icon path.
  const [icon, app, summary, body = ''] = quoted.length >= 3
    ? quoted
    : ['', quoted[0], quoted[1], ''];
  void icon;
  if (!app && !summary) return null;
  return { app: app || 'unknown', summary: summary || '', body };
}

/** Allowlist decision: empty allow = mirror everything, else only listed apps. */
export function allowed(notif, allow = []) {
  if (!notif) return false;
  if (!allow.length) return true;
  const a = notif.app.toLowerCase();
  return allow.some((x) => a.includes(String(x).toLowerCase()));
}

/** Rate limiter: at most `max` notifications per rolling minute. */
export function makeThrottle(max = MAX_PER_MINUTE, windowMs = 60_000, now = Date.now) {
  const hits = [];
  return () => {
    const t = now();
    while (hits.length && t - hits[0] > windowMs) hits.shift();
    if (hits.length >= max) return false;
    hits.push(t);
    return true;
  };
}

let monitor = null; // { child, throttle }

export function stopMirror() {
  if (!monitor) return '🔔 Notification mirror already OFF hai.';
  try { monitor.child?.kill?.('SIGKILL'); } catch { /* noop */ }
  monitor = null;
  return '🔔 Notification mirror *OFF*.';
}

export function mirrorStatus(stateFile = DEFAULT_STATE_FILE) {
  const state = loadMirrorState(stateFile);
  const apps = state.allow?.length ? state.allow.join(', ') : 'ALL apps';
  return `🔔 Notification mirror: *${state.enabled && monitor ? 'ON' : 'OFF'}* · allow: ${apps} · burst cap ${MAX_PER_MINUTE}/min\n/on: \`/nmirror on\` · allow sirf kuch apps: \`/nmirror allow slack, telegram\``;
}

/**
 * Start mirroring. `spawnMonitor(onLine)` attaches to gdbus (injected in
 * tests); `send(text)` delivers to WhatsApp.
 */
export async function startMirror(opts = {}) {
  const { spawnMonitor, send, stateFile = DEFAULT_STATE_FILE, now = Date.now } = opts;
  if (typeof spawnMonitor !== 'function' || typeof send !== 'function') {
    throw new Error('startMirror needs spawnMonitor(), send()');
  }
  const state = loadMirrorState(stateFile);
  if (monitor) return '🔔 Notification mirror already ON hai. Off: `/nmirror off`';
  const throttle = makeThrottle(MAX_PER_MINUTE, 60_000, now);
  const onLine = (line) => {
    const notif = parseNotificationLine(line);
    if (!allowed(notif, state.allow)) return;
    if (!throttle()) return;
    send(`🔔 *${notif.app}* — ${notif.summary}${notif.body ? `\n${notif.body.slice(0, 200)}` : ''}`).catch(() => {});
  };
  const child = spawnMonitor(onLine);
  monitor = { child, throttle };
  state.enabled = true;
  saveMirrorState(state, stateFile);
  return `🔔 *Notification mirror ON* — PC ke popups ab yahan aayenge (${state.allow?.length ? `sirf: ${state.allow.join(', ')}` : 'saare apps'}).\nOff: \`/nmirror off\``;
}

export function setAllow(appsCsv, stateFile = DEFAULT_STATE_FILE) {
  const allow = String(appsCsv ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const state = loadMirrorState(stateFile);
  state.allow = allow;
  saveMirrorState(state, stateFile);
  return allow.length
    ? `🔔 Allowlist set — sirf ye mirror honge: *${allow.join(', ')}*`
    : '🔔 Allowlist khaali — ab *saare apps* mirror honge.';
}

export async function toggleMirror(enabled, opts = {}) {
  if (enabled) return startMirror(opts);
  const state = loadMirrorState(opts.stateFile ?? DEFAULT_STATE_FILE);
  state.enabled = false;
  saveMirrorState(state, opts.stateFile ?? DEFAULT_STATE_FILE);
  return stopMirror();
}
