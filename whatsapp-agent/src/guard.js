// guard.js — 🛡️ Guard Mode: webcam as a motion-triggered security camera.
// `/guard on|off|status [sensitivity <1-10>]` — on motion the agent snaps a
// photo and alerts the owner on WhatsApp. Alert throttling means one alert
// per cooldown window, never spam.
//
// Motion = frame-brightness delta vs the running baseline (imageStats from
// imaging.js does the pixel work). Everything injectable for tests.

export const DEFAULT_SENSITIVITY = 5; // 1 = elephant, 10 = ghost
export const ALERT_COOLDOWN_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 3000;

let guard = null; // { timer, baseline, sensitivity, alerts, lastAlertAt, startedAt, busy }

export function guardStatus() {
  if (!guard) return '🛡️ Guard mode: *OFF*. Start: `/guard on` (motion → photo alert)';
  return `🛡️ Guard mode: *ON* · sensitivity ${guard.sensitivity}/10 · alerts ${guard.alerts} · checking every ${guard.intervalMs / 1000}s · off: \`/guard off\``;
}

export function stopGuard() {
  if (!guard) return '🛡️ Guard already OFF hai.';
  clearInterval(guard.timer);
  const { alerts } = guard;
  guard = null;
  return `🛡️ Guard mode *OFF* · total ${alerts} motion alerts.`;
}

/** Pure decision: given brightness delta + settings, is this motion? */
export function isMotion(delta, sensitivity) {
  // sensitivity 10 → tiny delta trips; 1 → huge delta only.
  const threshold = 22 - sensitivity * 1.8;
  return Math.abs(delta) >= threshold;
}

/** One watch pass. Returns 'alerted' | 'quiet' | 'off'. */
export async function guardTick(opts = {}) {
  const { capture, statFn, send, now = Date.now, cooldownMs = ALERT_COOLDOWN_MS } = opts;
  if (!guard) return 'off';
  try {
    const frame = await capture();
    const stat = statFn(frame);
    const bright = stat?.brightness ?? stat?.mean ?? 0;
    if (guard.baseline == null) {
      guard.baseline = bright;
      return 'quiet';
    }
    const delta = bright - guard.baseline;
    // slow drift (daylight) follows; sudden jumps alert
    guard.baseline = guard.baseline * 0.7 + bright * 0.3;
    if (!isMotion(delta, guard.sensitivity)) return 'quiet';
    if (now() - guard.lastAlertAt < cooldownMs) return 'quiet'; // throttled
    guard.lastAlertAt = now();
    guard.alerts += 1;
    await send({
      image: frame,
      text: `🛡️ *Motion detected!* (delta ${delta.toFixed(1)}, sensitivity ${guard.sensitivity}/10) — ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}`,
    });
    return 'alerted';
  } catch {
    return 'quiet'; // camera hiccup never crashes the guard
  }
}

export function startGuard(opts = {}) {
  const {
    capture, statFn, send,
    sensitivity = DEFAULT_SENSITIVITY,
    intervalMs = DEFAULT_INTERVAL_MS,
    now = Date.now,
  } = opts;
  if (typeof capture !== 'function' || typeof send !== 'function' || typeof statFn !== 'function') {
    throw new Error('startGuard needs capture(), statFn(), send()');
  }
  if (guard) return `🛡️ Guard already ON hai (sensitivity ${guard.sensitivity}). Off: \`/guard off\``;
  const s = Math.min(10, Math.max(1, Number(sensitivity) || DEFAULT_SENSITIVITY));
  guard = {
    timer: null,
    baseline: null,
    sensitivity: s,
    alerts: 0,
    lastAlertAt: 0,
    startedAt: now(),
    intervalMs,
  };
  const tick = () => guardTick({ capture, statFn, send, now }).catch(() => {});
  guard.timer = setInterval(tick, intervalMs);
  guard.timer.unref?.();
  tick();
  return `🛡️ *Guard mode ON* — motion detect → photo alert (sensitivity ${s}/10, cooldown 60s).\nStatus: \`/guard status\` · Off: \`/guard off\``;
}

export function setGuardSensitivity(value) {
  if (!guard) return '🛡️ Guard OFF hai — pehle `/guard on` karo.';
  guard.sensitivity = Math.min(10, Math.max(1, Number(value) || DEFAULT_SENSITIVITY));
  return `🛡️ Sensitivity → ${guard.sensitivity}/10`;
}
