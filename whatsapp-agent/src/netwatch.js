// netwatch.js — 📶 Internet watchdog: net drop → auto-reconnect + downtime
// report. `pingFn()` returns latency ms or throws; `reconnectFn()` tries to
// bring wifi back (nmcli). Heartbeat pe tick.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NET_FILE = path.join(ROOT, 'data', 'netwatch.json');
export const TICK_MS = 60_000;

export function loadNet(file = NET_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { enabled: false, outages: [], lastUp: 0, drops: 0, reconnects: 0 };
  }
}

function saveNet(data, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/**
 * One watchdog tick: returns {state:'up'|'down', action?}.
 * Pure decision + injected IO.
 */
export async function netTick(opts = {}) {
  const {
    pingFn, reconnectFn,
    file = NET_FILE, now = Date.now,
  } = opts;
  const nowTs = typeof now === 'function' ? now() : now;
  const data = loadNet(file);
  let latency = null;
  try {
    latency = await pingFn();
  } catch {
    latency = null;
  }

  if (latency != null) {
    if (data.downSince) {
      const mins = Math.max(1, Math.round((nowTs - data.downSince) / 60_000));
      data.outages.push({ from: data.downSince, to: nowTs, mins });
      data.outages = data.outages.slice(-20);
      data.downSince = null;
    }
    data.lastUp = nowTs;
    saveNet(data, file);
    return { state: 'up', latency };
  }

  // down
  if (!data.downSince) {
    data.downSince = nowTs;
    data.drops = (data.drops ?? 0) + 1;
    saveNet(data, file);
  }
  let reconnected = false;
  if (typeof reconnectFn === 'function') {
    try {
      reconnected = Boolean(await reconnectFn());
      if (reconnected) data.reconnects = (data.reconnects ?? 0) + 1;
    } catch { /* keep watching */ }
  }
  saveNet(data, file);
  return {
    state: 'down',
    action: reconnected ? 'reconnected' : 'waiting',
    message: reconnected
      ? '📶 Net gayab tha — reconnect try kiya, wapas aa gaya!'
      : '📶 Internet DOWN hai — reconnect fail. WiFi check karo.',
  };
}

export function netReport(opts = {}) {
  const data = loadNet(opts.file ?? NET_FILE);
  const outages = data.outages ?? [];
  const totalMin = outages.reduce((s, o) => s + (o.mins ?? 0), 0);
  return `📶 *Net watchdog report*\n• Drops: ${data.drops ?? 0} · Reconnects: ${data.reconnects ?? 0}\n• Outages (last 20): ${outages.length} · total ${totalMin} min${data.downSince ? '\n• ⚠️ ABHI bhi down hai' : ''}`;
}

export function setNetwatch(enabled, opts = {}) {
  const { file = NET_FILE } = opts;
  const data = loadNet(file);
  data.enabled = enabled;
  saveNet(data, file);
  return enabled ? '📶 Net watchdog *ON* — drop pe auto-reconnect + report.' : '📶 Net watchdog *OFF*.';
}
