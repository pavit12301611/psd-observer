// lifecycle.js — Automatic "Agent is sleeping" (offline) & wake-up notifications.
//
// When the PC is shutting down, rebooting, suspending/sleeping, or the agent
// service stops (SIGTERM / SIGINT / SIGHUP / systemd-logind PrepareForShutdown
// & PrepareForSleep), the owner automatically receives a WhatsApp message
// without having to ask ("bina puche"):
//
//     😴 *Agent is sleeping* (PSD_Ai offline)
//     ⏻ PC band (shutdown) ho raha hai — jab PC wapas on hoga to khud online message aa jayega.
//
// On Linux/Fedora, startPowerLifecycleWatcher() also holds a lightweight
// `systemd-inhibit --what=shutdown:sleep --mode=delay` lock and listens to
// `org.freedesktop.login1.Manager` (`PrepareForShutdown` / `PrepareForSleep`)
// on the system bus. That keeps Wi-Fi/network alive for the ~200ms needed to
// flush the WhatsApp packet *before* the OS cuts network or freezes processes,
// and releases the lock immediately once the message is sent.

import fs from 'node:fs';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { findBin } from './pccontrol.js';
import { getAgentName } from './memory.js';
import { readUpdateMarker } from './updates.js';

export const DEFAULT_OFFLINE_COOLDOWN_MS = 15_000;
export const DEFAULT_OFFLINE_TIMEOUT_MS = 3_500;
export const DEFAULT_STARTUP_COOLDOWN_MS = 6 * 3600_000;

/**
 * Whether automatic offline/sleeping WhatsApp notifications are active.
 * Active (true) by default. Can be toggled live via `/sleepnotify on|off`
 * (stored in `store.data.offlineNotify`) or `.env` (`OFFLINE_NOTIFY=false`).
 */
export function isOfflineNotifyEnabled(config = {}, store = null) {
  if (typeof store?.data?.offlineNotify === 'boolean') return store.data.offlineNotify;
  if (typeof config?.offlineNotify === 'boolean') return config.offlineNotify;
  return true;
}

/** Normalize raw signal / power action / D-Bus event names into a clean category. */
export function normalizeOfflineReason(reason = '') {
  const raw = String(reason ?? '').trim().toLowerCase();
  if (['shutdown', 'poweroff', 'power-off', 'halt'].includes(raw)) return 'shutdown';
  if (['reboot', 'restart'].includes(raw)) return 'reboot';
  if (['sleep', 'suspend', 'hibernate', 'hybrid-sleep'].includes(raw)) return 'sleep';
  if (['sigterm', 'sigint', 'sighup', 'stop', 'service-stop', 'exit'].includes(raw)) return 'stop';
  return 'offline';
}

/**
 * Build the WhatsApp message sent right before the agent goes offline / sleeps.
 * Always includes "Agent is sleeping" clearly so the owner knows immediately.
 */
export function buildOfflineMessage({ config = {}, store = null, reason = 'offline' } = {}) {
  const agentName = getAgentName(store, config) || config?.agentName || 'PSD_Ai';
  const custom = String(store?.data?.offlineMessage || config?.offlineMessage || '').trim();
  if (custom) {
    if (/agent\s+is\s+sleeping/i.test(custom)) return custom;
    return `😴 *Agent is sleeping* (${agentName}) — ${custom}`;
  }

  const kind = normalizeOfflineReason(reason);
  if (kind === 'shutdown') {
    return `😴 *Agent is sleeping* (${agentName} offline)\n⏻ PC band (shutdown) ho raha hai — jab PC wapas on hoga to khud online message aa jayega.`;
  }
  if (kind === 'reboot') {
    return `😴 *Agent is sleeping* (${agentName} offline)\n🔄 PC restart ho raha hai — wapas on hote hi khud online message aa jayega.`;
  }
  if (kind === 'sleep') {
    return `😴 *Agent is sleeping* (${agentName} offline)\n🌙 PC sleep/suspend mode me ja raha hai — wake hote hi khud online message aa jayega.`;
  }
  return `😴 *Agent is sleeping* (${agentName} offline)\nPC band ho raha hai ya agent offline ja raha hai — wapas on hote hi khud message aa jayega.`;
}

/**
 * Build the WhatsApp message sent when the agent comes online or wakes from sleep.
 */
export function buildOnlineMessage({ config = {}, store = null, reason = 'startup' } = {}) {
  const agentName = getAgentName(store, config) || config?.agentName || 'PSD_Ai';
  const wokeUp = reason === 'wakeup' || Boolean(store?.data?.stats?.sleeping);
  if (wokeUp) {
    return `🤖 *Observer agent is online* (${agentName} awake & active · free native WhatsApp).\nSend /help, ask me anything, or /observer <task> to use the PC.`;
  }
  return '🤖 *Observer agent is online* (free native WhatsApp).\nSend /help, ask me anything, or /observer <task> to use the PC.';
}

/**
 * True when `observer.sh update` just wrote `data/last-update.json` and is
 * restarting the service — in that case `announceUpdate()` will send the
 * "🔄 Observer updated" message in a couple of seconds, so we skip the
 * sleeping message during the brief update restart.
 */
export function hasFreshUpdateMarker(dataDir, maxAgeMs = 180_000, now = Date.now()) {
  if (!dataDir) return false;
  const marker = readUpdateMarker(dataDir);
  if (!marker) return false;
  if (marker.at) {
    const parsed = Date.parse(marker.at);
    if (Number.isFinite(parsed) && Math.abs(now - parsed) <= maxAgeMs) return true;
  }
  try {
    const stat = fs.statSync(path.join(dataDir, 'last-update.json'));
    return Math.abs(now - stat.mtimeMs) <= maxAgeMs;
  } catch {
    return false;
  }
}

/**
 * Mark in persistent store that the offline/sleeping message was just sent
 * (used when a power command replies directly with the sleeping notice so
 * the subsequent OS shutdown signal doesn't send a duplicate).
 */
export function noteOfflineAnnounced(store, reason = 'offline', now = Date.now()) {
  if (!store?.data) return;
  store.data.stats ||= {};
  store.data.stats.sleeping = true;
  store.data.stats.lastOfflineNotify = now;
  store.data.stats.lastOfflineReason = normalizeOfflineReason(reason);
  if (typeof store.saveNow === 'function') store.saveNow();
  else store.save?.();
}

/**
 * Send the "Agent is sleeping" message to the owner before going offline.
 * Deduplicated with a cooldown window and bounded by a hard timeout so
 * shutdown never hangs if the network is already dead.
 */
export async function announceOffline({
  config = {},
  store = null,
  send = null,
  reason = 'offline',
  log = console,
  timeoutMs = null,
  cooldownMs = DEFAULT_OFFLINE_COOLDOWN_MS,
  flushMs = 0,
  force = false,
  now = Date.now(),
} = {}) {
  if (!force && !isOfflineNotifyEnabled(config, store)) {
    return { sent: false, reason: 'disabled' };
  }
  if (!force && hasFreshUpdateMarker(config?.dataDir, 180_000, now)) {
    return { sent: false, reason: 'updating' };
  }
  const lastAt = Number(store?.data?.stats?.lastOfflineNotify ?? 0);
  if (!force && lastAt > 0 && now - lastAt >= 0 && now - lastAt < cooldownMs) {
    return { sent: false, reason: 'cooldown' };
  }

  const kind = normalizeOfflineReason(reason);
  const text = buildOfflineMessage({ config, store, reason: kind });
  noteOfflineAnnounced(store, kind, now);

  if (typeof send !== 'function') {
    return { sent: false, text, reason: 'no send function' };
  }

  const effTimeout = Math.max(250, Number(timeoutMs ?? config?.offlineTimeoutMs ?? DEFAULT_OFFLINE_TIMEOUT_MS) || DEFAULT_OFFLINE_TIMEOUT_MS);
  let timer = null;
  try {
    await Promise.race([
      Promise.resolve().then(() => send(text)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`offline send timed out after ${effTimeout}ms`)), effTimeout);
        timer.unref?.();
      }),
    ]);
    if (flushMs > 0) {
      await new Promise((r) => {
        const t = setTimeout(r, flushMs);
        t.unref?.();
      });
    }
    log?.info?.(`[lifecycle] announced offline/sleeping (${kind})`);
    return { sent: true, text, reason: kind };
  } catch (err) {
    log?.warn?.(`[lifecycle] offline announcement failed: ${err.message}`);
    return { sent: false, text, reason: `send failed: ${err.message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Send the "Observer agent is online" message on startup or wake-up.
 * If the agent previously announced it was sleeping (`store.data.stats.sleeping === true`),
 * it ALWAYS announces that it is back online regardless of the 6-hour startup cooldown!
 */
export async function announceOnline({
  config = {},
  store = null,
  send = null,
  reason = 'startup',
  log = console,
  startupCooldownMs = DEFAULT_STARTUP_COOLDOWN_MS,
  force = false,
  now = Date.now(),
} = {}) {
  const wasSleeping = Boolean(store?.data?.stats?.sleeping);
  const lastStartup = Number(store?.data?.stats?.lastStartupNotify ?? 0);
  if (!force && !wasSleeping && lastStartup > 0 && now - lastStartup <= startupCooldownMs) {
    return { sent: false, reason: 'cooldown' };
  }

  const effReason = wasSleeping ? 'wakeup' : reason;
  const text = buildOnlineMessage({ config, store, reason: effReason });

  if (store?.data) {
    store.data.stats ||= {};
    store.data.stats.sleeping = false;
    store.data.stats.lastStartupNotify = now;
    store.save?.();
  }

  if (typeof send !== 'function') {
    return { sent: false, text, reason: 'no send function' };
  }

  try {
    await send(text);
    log?.info?.(`[lifecycle] announced online (${effReason})`);
    return { sent: true, text, reason: effReason };
  } catch (err) {
    log?.warn?.(`[lifecycle] online announcement failed: ${err.message}`);
    return { sent: false, text, reason: `send failed: ${err.message}` };
  }
}

/**
 * Parse a `gdbus monitor --system --dest org.freedesktop.login1` line for
 * `PrepareForShutdown` / `PrepareForShutdownWithMetadata` / `PrepareForSleep`.
 */
export function parseLogindSignal(line) {
  const text = String(line ?? '');
  const shutdownMatch = text.match(/PrepareForShutdown(?:WithMetadata)?\s*\(\s*(true|false)\b/i);
  if (shutdownMatch) {
    const active = shutdownMatch[1].toLowerCase() === 'true';
    const isReboot = /['"]type['"]\s*:\s*<*\s*['"]reboot['"]/i.test(text);
    return { kind: isReboot ? 'reboot' : 'shutdown', active };
  }
  const sleepMatch = text.match(/PrepareForSleep\s*\(\s*(true|false)\b/i);
  if (sleepMatch) {
    return { kind: 'sleep', active: sleepMatch[1].toLowerCase() === 'true' };
  }
  return null;
}

/**
 * Watch Linux `systemd-logind` system D-Bus signals (`PrepareForShutdown` and
 * `PrepareForSleep`) and hold a `systemd-inhibit --mode=delay` lock so the
 * WhatsApp sleeping notification is sent *before* Wi-Fi disconnects or the
 * kernel freezes user processes.
 */
export function startPowerLifecycleWatcher({
  config = {},
  log = console,
  onGoingOffline = null,
  onWakeUp = null,
  spawnFn = nodeSpawn,
  findBinFn = findBin,
  platform = process.platform,
  forceStart = false,
} = {}) {
  if (!forceStart && (config?.dryRun || platform !== 'linux')) {
    return { active: false, hasInhibitLock: () => false, stop() {} };
  }
  const gdbusBin = findBinFn('gdbus');
  if (!gdbusBin) {
    return { active: false, hasInhibitLock: () => false, stop() {} };
  }
  const inhibitBin = findBinFn('systemd-inhibit');

  let stopped = false;
  let monitorChild = null;
  let inhibitChild = null;
  let buffer = '';

  function acquireInhibitLock() {
    if (stopped || !inhibitBin || inhibitChild) return;
    try {
      const child = spawnFn(inhibitBin, [
        '--what=shutdown:sleep',
        '--who=PSD_Ai (Observer Agent)',
        '--why=Send WhatsApp sleeping message before PC goes offline',
        '--mode=delay',
        'cat',
      ], { stdio: ['pipe', 'ignore', 'ignore'] });
      inhibitChild = child;
      child.on?.('error', () => {
        if (inhibitChild === child) inhibitChild = null;
      });
      child.on?.('close', () => {
        if (inhibitChild === child) inhibitChild = null;
      });
      child.unref?.();
    } catch {
      inhibitChild = null;
    }
  }

  function releaseInhibitLock() {
    const child = inhibitChild;
    inhibitChild = null;
    if (!child) return;
    try { child.stdin?.end?.(); } catch { /* noop */ }
    try { child.kill?.('SIGTERM'); } catch { /* noop */ }
  }

  async function handleLine(line) {
    const sig = parseLogindSignal(line);
    if (!sig || stopped) return;
    if (sig.active) {
      try {
        await onGoingOffline?.(sig.kind);
      } catch (err) {
        log?.warn?.(`[lifecycle] onGoingOffline (${sig.kind}) error: ${err.message}`);
      } finally {
        // Release the systemd-inhibit delay lock immediately after the WhatsApp
        // packet is sent so the PC can finish sleeping/shutting down right away.
        releaseInhibitLock();
      }
    } else if (sig.kind === 'sleep') {
      // System woke up from suspend/sleep: re-acquire delay lock for next time
      // and notify wake-up handler.
      acquireInhibitLock();
      try {
        await onWakeUp?.();
      } catch (err) {
        log?.warn?.(`[lifecycle] onWakeUp error: ${err.message}`);
      }
    }
  }

  try {
    acquireInhibitLock();
    monitorChild = spawnFn(gdbusBin, [
      'monitor',
      '--system',
      '--dest', 'org.freedesktop.login1',
      '--object-path', '/org/freedesktop/login1',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    monitorChild.stdout?.on?.('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim()) handleLine(line);
      }
    });
    monitorChild.on?.('error', () => {});
    monitorChild.unref?.();
  } catch {
    releaseInhibitLock();
    return { active: false, hasInhibitLock: () => false, stop() {} };
  }

  return {
    active: true,
    hasInhibitLock: () => Boolean(inhibitChild),
    stop() {
      stopped = true;
      releaseInhibitLock();
      const m = monitorChild;
      monitorChild = null;
      if (m) {
        try { m.kill?.('SIGTERM'); } catch { /* noop */ }
      }
    },
  };
}
