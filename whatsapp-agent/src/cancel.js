// cancel.js — the one thing every long command needs: a way to be stopped.
//
// `/stop` has to work *while* `/arena`, `/use`, `/agent`, a download or a shell
// command is running. That means three separate pieces:
//
//   1. a registry of live tasks, each with its own AbortSignal (so several can
//      be cancelled at once — "stacked" work included),
//   2. helpers that long code paths can call at every loop iteration
//      (throwIfStopped / sleepWith), and
//   3. a StoppedError that callers catch to say "roka gaya", never "fail".
//
// Nothing here imports the desktop, the AI or WhatsApp, so it is cheap to use
// everywhere and trivial to test.

/** Thrown by any task that was cancelled with /stop (not an error to report). */
export class StoppedError extends Error {
  constructor(label = 'Task') {
    super(`${label} roka gaya (/stop)`);
    this.name = 'StoppedError';
    this.code = 'ESTOPPED';
    this.stopped = true;
  }
}

export function isStoppedError(err) {
  return err?.code === 'ESTOPPED' || err?.stopped === true || err?.name === 'StoppedError';
}

/** AbortSignal → throws StoppedError. Safe to call with no signal. */
export function throwIfStopped(signal, label = 'Task') {
  if (signal?.aborted) throw new StoppedError(label);
}

/** setTimeout that rejects immediately when the signal aborts. */
export function sleepWith(ms, signal, label = 'Task') {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new StoppedError(label));
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, Number(ms) || 0));
    const onAbort = () => {
      cleanup();
      reject(new StoppedError(label));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Registry of running work. `begin()` returns a handle with a signal; the
 * caller must `end()` it (use `run()` and you cannot forget).
 */
export function createTaskRegistry({ log = console, now = Date.now } = {}) {
  const live = new Map();
  let seq = 0;

  function begin(label, { detail = '', kind = 'command' } = {}) {
    const id = ++seq;
    const controller = new AbortController();
    const task = {
      id,
      label: String(label || 'Task'),
      detail: String(detail || ''),
      kind,
      startedAt: now(),
      controller,
      signal: controller.signal,
    };
    live.set(id, task);
    let ended = false;
    return {
      id,
      label: task.label,
      detail: task.detail,
      startedAt: task.startedAt,
      signal: task.signal,
      get aborted() { return task.signal.aborted; },
      end() {
        if (ended) return;
        ended = true;
        live.delete(id);
      },
    };
  }

  /** Live tasks, oldest first (public shape — no controllers leak out). */
  function active() {
    const ts = now();
    return [...live.values()].map((t) => ({
      id: t.id,
      label: t.label,
      detail: t.detail,
      kind: t.kind,
      startedAt: t.startedAt,
      elapsedMs: Math.max(0, ts - t.startedAt),
    }));
  }

  /** Abort every live task. Returns what was stopped (before it unwinds). */
  function stopAll(reason = 'stop') {
    const stopped = active();
    for (const task of live.values()) {
      try {
        task.controller.abort(reason);
      } catch (err) {
        log?.warn?.(`[cancel] abort failed: ${err.message}`);
      }
    }
    return stopped;
  }

  /** Abort one task by id (used by /stop <id>). */
  function stop(id) {
    const task = live.get(Number(id));
    if (!task) return null;
    const info = { id: task.id, label: task.label, detail: task.detail, startedAt: task.startedAt, elapsedMs: Math.max(0, now() - task.startedAt) };
    task.controller.abort('stop');
    return info;
  }

  /** Run fn(signal, handle) and always unregister, even when it throws. */
  async function run(label, fn, opts = {}) {
    const handle = begin(label, opts);
    try {
      return await fn(handle.signal, handle);
    } finally {
      handle.end();
    }
  }

  return { begin, run, stop, stopAll, active, get size() { return live.size; } };
}

/** Process-wide registry: /stop talks to this, every command registers here. */
export const tasks = createTaskRegistry();

const STOP_WORDS = /^\/(?:stop|stopp|cancel|abort|ruko|band)\b/i;

/** Is this message a stop request? (`/stop`, `/stop all`, `/ruko`, `/cancel`) */
export function isStopCommand(text) {
  return STOP_WORDS.test(String(text ?? '').trim());
}

/** Mask a task's text for a one-line reply ("/use youtube kholo" → "use youtube kholo"). */
export function taskDetailFromMessage(text) {
  return String(text ?? '')
    .replace(/^\//, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
}
