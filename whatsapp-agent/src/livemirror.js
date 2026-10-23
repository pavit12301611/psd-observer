// Bounded live screenshots. Stop invalidates the entire session, including
// captures still awaiting a portal/camera; it cannot undo a send already begun.
export const MAX_FRAMES = 180;
export const MAX_DURATION_MS = 30 * 60_000;
export const DEFAULT_INTERVAL_SEC = 10;
let live = null;

export function liveStatus() {
  if (!live) return '🎥 Live mirror: *OFF*. Start: `/live [interval-sec]` (default 10s)';
  const mins = Math.floor((Date.now() - live.startedAt) / 60_000);
  return `🎥 Live mirror: *ON* — har ${live.intervalSec}s ek frame · ${live.sent}/${live.maxFrames} bheje · ${mins} min chal raha · off: \`/live off\``;
}

export function stopLive(reason = '') {
  if (!live) return '🎥 Live mirror already OFF hai.';
  const state = live; live = null;
  clearInterval(state.timer); clearTimeout(state.kill);
  return `🎥 Live mirror *OFF* ${reason}· total ${state.sent}/${state.frames} frames bheji.`;
}

export async function startLive(opts = {}) {
  const { intervalSec = DEFAULT_INTERVAL_SEC, capture, send, maxFrames = MAX_FRAMES, maxDurationMs = MAX_DURATION_MS } = opts;
  if (typeof capture !== 'function' || typeof send !== 'function') throw new Error('startLive needs capture() and send()');
  if (live) return `🎥 Live mirror already ON hai (${live.sent} frames). Pehle: \`/live off\``;
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || !Number.isFinite(maxDurationMs) || maxDurationMs <= 0) throw new RangeError('Live frame and duration budgets must be positive and finite');
  const sec = Math.min(300, Math.max(3, Number(intervalSec) || DEFAULT_INTERVAL_SEC));
  const budget = Math.min(MAX_FRAMES, maxFrames), duration = Math.min(MAX_DURATION_MS, maxDurationMs);
  const state = { timer: null, kill: null, frames: 0, sent: 0, busy: false, startedAt: Date.now(), intervalSec: sec, maxFrames: budget };
  live = state;
  const tick = async () => {
    if (live !== state || state.busy) return;
    state.busy = true; state.frames++;
    try {
      const image = await capture();
      if (live !== state) return;
      if (image) {
        await send({ image, text: `🎥 Live ${state.sent + 1} · ${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}` });
        state.sent++;
      }
    } catch { /* one bad frame never kills the stream */ }
    finally {
      state.busy = false;
      if (live === state && state.frames >= budget) stopLive('(frame budget khatam)');
    }
  };
  state.timer = setInterval(tick, sec * 1000); state.timer.unref?.();
  state.kill = setTimeout(() => { if (live === state) stopLive('(duration limit)'); }, duration); state.kill.unref?.();
  await tick();
  if (live !== state) return `🎥 Live mirror *OFF* — session stopped; ${state.sent}/${state.frames} frames bheji.`;
  return `🎥 *Live mirror ON* — har ${sec}s ek screenshot yahan aayega (max ${budget} frames / ${Math.round(duration / 60000)} min).\nOff: \`/live off\``;
}
