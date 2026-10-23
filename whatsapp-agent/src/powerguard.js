// powerguard.js — 🔋 Power Guardian: battery/temperature thresholds with
// owner alerts. `/pguard on|off|status|battery <pct>|temp <c>` — the loop
// watches sysfs (no forks) and pings WhatsApp BEFORE the laptop dies.
//   battery ≤ threshold  → warn (once per level)
//   temp    ≥ threshold  → warn (once per 15 min)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PG_FILE = path.join(ROOT, 'data', 'powerguard.json');
export const DEFAULT_BATTERY = 15; // %
export const DEFAULT_TEMP = 85; // °C
export const TEMP_COOLDOWN_MS = 15 * 60_000;
export const DEFAULT_INTERVAL_MS = 30_000;

export function loadPowerGuard(file = PG_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { enabled: false, battery: DEFAULT_BATTERY, temp: DEFAULT_TEMP, warnedLevels: [], lastTempWarn: 0 };
  }
}

function savePowerGuard(state, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch { /* best effort */ }
}

/** Read battery percent + temp °C from sysfs. Returns nulls on desktops. */
export function readPower(base = '/sys/class/power_supply') {
  let battery = null;
  try {
    for (const dev of fs.readdirSync(base)) {
      const cap = fs.readFileSync(path.join(base, dev, 'capacity'), 'utf8').trim();
      if (Number.isFinite(Number(cap))) { battery = Number(cap); break; }
    }
  } catch { /* no battery */ }
  let temp = null;
  try {
    for (const zone of fs.readdirSync('/sys/class/thermal')) {
      if (!zone.startsWith('thermal_zone')) continue;
      const t = Number(fs.readFileSync(`/sys/class/thermal/${zone}/temp`, 'utf8').trim());
      if (Number.isFinite(t)) { temp = t / 1000; break; }
    }
  } catch { /* no sensors */ }
  return { battery, temp };
}

/**
 * Pure decision: given readings + thresholds + warn history → actions.
 * Returns [{ kind: 'battery'|'temp', message }] (empty = all good).
 */
export function evaluate(readings, state, now = Date.now()) {
  const actions = [];
  const { battery, temp } = readings;
  if (battery != null && battery <= state.battery) {
    const level = Math.floor(battery / 5) * 5; // one warn per 5% band
    if (!state.warnedLevels.includes(level)) {
      state.warnedLevels.push(level);
      actions.push({
        kind: 'battery',
        message: `🔋 *Battery ${battery}%* — threshold ${state.battery}%! Jaldi charge lagao ya kaam save karo.`,
      });
    }
  }
  if (battery != null && battery > state.battery + 10) {
    state.warnedLevels = []; // recovered — future warns allowed again
  }
  const lastTemp = state.lastTempWarn ?? 0;
  if (temp != null && temp >= state.temp && (lastTemp === 0 || now - lastTemp >= TEMP_COOLDOWN_MS)) {
    state.lastTempWarn = now;
    actions.push({
      kind: 'temp',
      message: `🌡️ *CPU ${temp.toFixed(0)}°C* — bohot garam hai (limit ${state.temp}°C). Heavy band karke thanda hone do.`,
    });
  }
  return actions;
}

export function pgStatus(opts = {}) {
  const { file = PG_FILE, read = readPower } = opts;
  const state = loadPowerGuard(file);
  const r = read();
  return `🔋 Power Guardian: *${state.enabled ? 'ON' : 'OFF'}* · battery warn ≤ ${state.battery}% · temp warn ≥ ${state.temp}°C\nAbhi: battery ${r.battery ?? '?'}% · temp ${r.temp != null ? `${r.temp.toFixed(0)}°C` : '?'}\n/on: \`/pguard on\` · set: \`/pguard battery 20\` · \`/pguard temp 90\``;
}

let loop = null;

export function stopPowerGuard() {
  if (!loop) return '🔋 Power Guardian already OFF hai.';
  clearInterval(loop);
  loop = null;
  return '🔋 Power Guardian *OFF*.';
}

export function startPowerGuard(opts = {}) {
  const {
    file = PG_FILE, read = readPower, send, now = Date.now,
    intervalMs = DEFAULT_INTERVAL_MS,
  } = opts;
  if (loop) return '🔋 Power Guardian already ON hai. Off: `/pguard off`';
  const state = loadPowerGuard(file);
  state.enabled = true;
  savePowerGuard(state, file);
  const tick = () => {
    try {
      // evaluate mutates warn history — persist THAT state, not a reload.
      const state = loadPowerGuard(file);
      const actions = evaluate(read(), state, now());
      savePowerGuard(state, file);
      for (const a of actions) send?.(a.message)?.catch?.(() => {});
    } catch { /* guardian never crashes the agent */ }
  };
  tick();
  loop = setInterval(tick, intervalMs);
  loop.unref?.();
  return `🔋 *Power Guardian ON* — battery ≤ ${state.battery}% ya temp ≥ ${state.temp}°C pe alert.\nStatus: \`/pguard status\``;
}

export function setThreshold(kind, value, opts = {}) {
  const { file = PG_FILE } = opts;
  const state = loadPowerGuard(file);
  const n = Number(value);
  if (!Number.isFinite(n)) return '🔋 Usage: `/pguard battery <pct>` ya `/pguard temp <c>`';
  if (kind === 'battery') state.battery = Math.min(90, Math.max(5, n));
  else state.temp = Math.min(99, Math.max(50, n));
  savePowerGuard(state, file);
  return kind === 'battery'
    ? `🔋 Battery warn threshold → *${state.battery}%*`
    : `🌡️ Temp warn threshold → *${state.temp}°C*`;
}

export function togglePowerGuard(enabled, opts = {}) {
  const { file = PG_FILE } = opts;
  const state = loadPowerGuard(file);
  state.enabled = enabled;
  savePowerGuard(state, file);
  return enabled ? startPowerGuard(opts) : stopPowerGuard();
}
