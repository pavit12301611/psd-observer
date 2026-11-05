// notch.js — the wire between PSD and the GNOME extension.
//
// The notch is the fastest surface PSD has: no browser, no app launch, just a
// D-Bus method call into the already-running Shell extension. PSD talks to it
// two ways, and picks whichever is available:
//
//   1. D-Bus (instant, push): io.github.pavit12301611.Notch.PsdMessage(json)
//      on the session bus. This is the primary path.
//   2. Event ring (pull): PSD keeps a bounded ring of events and the notch
//      polls /psd/notch?since=<seq> if D-Bus is unavailable. Same payloads.
//
// Nothing here throws into a chat turn: the notch being closed or disabled is a
// normal state, not an error.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const RING_MAX = 200;

export function createNotch(config, { log = console } = {}) {
  const ring = [];
  let seq = 0;
  let available = null;      // null = unknown, true/false once probed
  let lastPushAt = 0;
  let lastError = '';

  function record(event) {
    const entry = { seq: ++seq, at: Date.now(), ...event };
    ring.push(entry);
    if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
    return entry;
  }

  /** Push straight into the Shell extension. */
  async function viaDbus(payload) {
    const json = JSON.stringify({ ...payload, seq, at: Date.now(), from: 'psd' });
    await execFileAsync('gdbus', [
      'call', '--session',
      '--dest', config.notchBus,
      '--object-path', config.notchPath,
      '--method', `${config.notchBus}.PsdMessage`,
      json,
    ], { timeout: 4000 });
    return true;
  }

  async function probe() {
    try {
      const { stdout } = await execFileAsync('gdbus', [
        'call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
        '--method', 'org.freedesktop.DBus.NameHasOwner', config.notchBus,
      ], { timeout: 2500 });
      available = /true/.test(stdout);
      if (!available) lastError = `extension ${config.notchBus} is not running on the session bus`;
    } catch (err) {
      available = false;
      lastError = err.message;
    }
    return available;
  }

  /** Fire-and-forget toward the notch. Always returns a boolean, never throws. */
  async function push(event) {
    record(event);
    if (config.notchBus === 'off') { available = false; return false; }
    try {
      await viaDbus(event);
      available = true;
      lastPushAt = Date.now();
      lastError = '';
      return true;
    } catch (err) {
      available = false;
      lastError = err.message;
      return false;
    }
  }

  return {
    push,
    probe,
    /**
     * A friendly message the notch renders as a card. `open` expands it now;
     * `tab` selects chat/music/alerts/system after expanding.
     */
    show: ({ title, body = '', tab = 'chat', open = false }) =>
      push({ kind: 'card', title: String(title ?? '').slice(0, 120), body: String(body ?? '').slice(0, 800), tab, open }),
    /** Live "thinking…" state for the closed-notch indicator. */
    status: (state) => push({ kind: 'status', ...state }),
    /** Mirror one streamed token chunk so the notch types along with the reply. */
    token: (text, meta = {}) => push({ kind: 'token', text, ...meta }),
    /** Let the notch drive the system tab without polling. */
    system: (snapshot) => push({ kind: 'system', ...snapshot }),
    events: (since = 0) => ring.filter((entry) => entry.seq > since),
    get seq() { return seq; },
    get info() {
      return {
        available, lastPushAt, lastError, events: ring.length,
        bus: config.notchBus, path: config.notchPath,
      };
    },
  };
}
