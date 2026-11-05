// bus.js — a tiny in-process event bus.
//
// Everything PSD does funnels through here: a tool starts, a token streams, an
// approval is parked, a reminder fires. The server mirrors it to SSE clients,
// the notch mirrors it to D-Bus, and the trace file keeps the history.

export function createBus() {
  const listeners = new Set();
  const history = [];

  function emit(event) {
    const entry = { at: Date.now(), ...event };
    history.push(entry);
    if (history.length > 300) history.shift();
    for (const listener of [...listeners]) {
      try { listener(entry); } catch { /* a bad listener must not break a turn */ }
    }
    return entry;
  }

  emit.subscribe = (fn) => {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  emit.history = (limit = 50) => history.slice(-limit);
  emit.listeners = () => listeners.size;
  return emit;
}
