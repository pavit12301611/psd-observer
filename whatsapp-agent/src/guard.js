// Motion camera: session-scoped, one capture/send at a time. A stopped or
// superseded capture cannot alert or mutate a replacement session.
export const DEFAULT_SENSITIVITY = 5;
export const ALERT_COOLDOWN_MS = 60_000;
export const DEFAULT_INTERVAL_MS = 3000;
let guard = null;

export function guardStatus() {
  if (!guard) return '🛡️ Guard mode: *OFF*. Start: `/guard on` (motion → photo alert)';
  return `🛡️ Guard mode: *ON* · sensitivity ${guard.sensitivity}/10 · alerts ${guard.alerts} · checking every ${guard.intervalMs / 1000}s · off: \`/guard off\``;
}

export function stopGuard() {
  if (!guard) return '🛡️ Guard already OFF hai.';
  clearInterval(guard.timer);
  const { alerts } = guard; guard = null;
  return `🛡️ Guard mode *OFF* · total ${alerts} motion alerts.`;
}

export function isMotion(delta, sensitivity) {
  return Math.abs(delta) >= 22 - sensitivity * 1.8;
}

export async function guardTick(opts = {}) {
  const { capture, statFn, send, now = Date.now, cooldownMs = ALERT_COOLDOWN_MS } = opts;
  const state = guard;
  if (!state) return 'off';
  if (state.busy) return 'quiet';
  state.busy = true;
  try {
    const frame = await capture();
    if (guard !== state) return 'off';
    const stat = statFn(frame), bright = stat?.brightness ?? stat?.mean;
    if (!Number.isFinite(bright)) return 'quiet';
    if (state.baseline == null) { state.baseline = bright; return 'quiet'; }
    const delta = bright - state.baseline;
    state.baseline = state.baseline * 0.7 + bright * 0.3;
    if (!isMotion(delta, state.sensitivity)) return 'quiet';
    const ts = now();
    if (state.lastAlertAt !== null && ts - state.lastAlertAt < cooldownMs) return 'quiet';
    // Throttle attempts even if delivery is offline, but count only sends
    // whose promises actually resolve. Already-started sends cannot be unsent.
    state.lastAlertAt = ts;
    await send({ image: frame, text: `🛡️ *Motion detected!* (delta ${delta.toFixed(1)}, sensitivity ${state.sensitivity}/10) — ${new Date(ts).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}` });
    state.alerts++;
    return guard === state ? 'alerted' : 'off';
  } catch { return guard === state ? 'quiet' : 'off'; }
  finally { state.busy = false; }
}

export function startGuard(opts = {}) {
  const { capture, statFn, send, sensitivity = DEFAULT_SENSITIVITY, intervalMs = DEFAULT_INTERVAL_MS, now = Date.now } = opts;
  if (typeof capture !== 'function' || typeof send !== 'function' || typeof statFn !== 'function') throw new Error('startGuard needs capture(), statFn(), send()');
  if (guard) return `🛡️ Guard already ON hai (sensitivity ${guard.sensitivity}). Off: \`/guard off\``;
  if (!Number.isFinite(intervalMs) || intervalMs < 100) throw new RangeError('Guard intervalMs must be finite and at least 100ms');
  const state = { timer: null, baseline: null, sensitivity: Math.min(10, Math.max(1, Number(sensitivity) || DEFAULT_SENSITIVITY)), alerts: 0, lastAlertAt: null, startedAt: now(), intervalMs, busy: false };
  guard = state;
  const tick = () => {
    if (guard === state) return guardTick({ capture, statFn, send, now }).catch(() => {});
  };
  state.timer = setInterval(tick, intervalMs); state.timer.unref?.(); tick();
  return `🛡️ *Guard mode ON* — motion detect → photo alert (sensitivity ${state.sensitivity}/10, cooldown 60s).\nStatus: \`/guard status\` · Off: \`/guard off\``;
}

export function setGuardSensitivity(value) {
  if (!guard) return '🛡️ Guard OFF hai — pehle `/guard on` karo.';
  guard.sensitivity = Math.min(10, Math.max(1, Number(value) || DEFAULT_SENSITIVITY));
  return `🛡️ Sensitivity → ${guard.sensitivity}/10`;
}
