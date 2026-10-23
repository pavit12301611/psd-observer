// smarthome.js — 🏠 Smart home (webhook bridge): Home Assistant / Tuya /
// MQTT-bridge ke local webhook pe POST — "light off kar do", "study mode" =
// light dim + fan on. Config: /home setup <webhook-base-url>

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME_FILE = path.join(ROOT, 'data', 'smarthome.json');

export function loadHome(file = HOME_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { base: null, devices: {} };
  }
}

function saveHome(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

export function setupHome(args, opts = {}) {
  const { file = HOME_FILE } = opts;
  const [base, ...rest] = String(args ?? '').trim().split(/\s+/);
  if (!base) return '🏠 Usage: `/home setup <webhook-url>` (Home Assistant webhook ya koi bhi local bridge)';
  const data = loadHome(file);
  data.base = base.replace(/\/$/, '');
  if (rest.length >= 2) data.devices[rest[0].toLowerCase()] = rest[1];
  saveHome(data, file);
  return `🏠 *Smart home setup done* — ${data.base}\nDevices: \`/home add light <endpoint>\` · Chalao: \`/home light on\``;
}

export function addDevice(name, endpoint, opts = {}) {
  const { file = HOME_FILE } = opts;
  const data = loadHome(file);
  data.devices[String(name).toLowerCase()] = String(endpoint);
  saveHome(data, file);
  return `🏠 Device *${name}* → ${endpoint}`;
}

/** Map natural action → webhook payload. */
export function buildAction(device, action) {
  const d = String(device ?? '').toLowerCase();
  const a = String(action ?? '').toLowerCase();
  const onoff = /^(on|off|toggle)$/.test(a) ? a : (a.startsWith('dim') ? 'dim' : a);
  return { device: d, action: onoff, body: { device: d, action: onoff, brightness: a.match(/(\d+)/)?.[1] ?? null } };
}

/** Fire the webhook. `post(url, body)` injected (prod: fetch). */
export async function controlHome(device, action, opts = {}) {
  const { file = HOME_FILE, post } = opts;
  const data = loadHome(file);
  if (!data.base) return '🏠 Setup nahi hua. `/home setup <webhook-url>` pehle.';
  const d = String(device ?? '').toLowerCase();
  const endpoint = data.devices[d] ?? d;
  const payload = buildAction(d, action);
  if (typeof post === 'function') {
    try {
      await post(`${data.base}/${endpoint}`, payload.body);
      return `🏠 *${d}* → ${payload.action} ✅`;
    } catch (err) {
      return `🏠 Command fail: ${err?.message ?? err}`;
    }
  }
  return `🏠 ${d} → ${payload.action} (webhook runner missing)`;
}

export function homeStatus(opts = {}) {
  const data = loadHome(opts.file ?? HOME_FILE);
  if (!data.base) return '🏠 Smart home: *not setup*';
  const devices = Object.keys(data.devices);
  return `🏠 Smart home: ${data.base}\nDevices: ${devices.length ? devices.join(', ') : '(default endpoints)'}`;
}
