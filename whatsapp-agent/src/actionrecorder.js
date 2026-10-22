// actionrecorder.js — Live PC Action Recorder, Learner & Replayer for PSD_Ai.
//
// Lets the owner say:
//   • "mere actions record karo" / "record my actions as /morning"
//   • (Owner performs actions on the PC: opens apps, switches windows, clicks
//      buttons/coords, types text, presses keys, changes volume, copies URLs…)
//   • "stop recording" / "recording band karo aur /morning naam se save karo"
//   • "mere actions repeat karo" / "/morning" / "repeat /morning 2 times"
//
// How it observes the Linux desktop (zero root required):
//   1. Live AT-SPI Accessibility Event Stream (Python `gi.repository.Atspi`
//      listener subprocess when available on the desktop) — captures window
//      activations, widget clicks/focus with exact label + (x,y), and text
//      entry changes.
//   2. High-frequency Desktop State Poller (`wmctrl`, `xdotool`, `pactl`/`wpctl`,
//      `wl-paste`/`xclip`, and `grounding.inspectDesktopElements`) — detects
//      newly opened apps/windows, window focus transitions, cursor clicks,
//      volume changes, and URLs even when AT-SPI events are unavailable.
//   3. Direct event recording API (`recordDesktopEvent`) — records WhatsApp
//      commands performed during the session and supports deterministic testing.
//
// Strictly Owner-Only: non-owners can never start, stop, view, or replay PC
// action recordings.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pc from './pccontrol.js';
import * as apps from './apps.js';
import * as learn from './learn.js';

const execFileAsync = promisify(execFile);

const MAX_RAW_EVENTS = 120;
const MAX_COMPILED_STEPS = 20;
const MAX_SAVED_RECORDINGS = 30;
const DEFAULT_POLL_MS = 1200;

// Active live monitor handles per store instance (in-memory runtime state)
const activeMonitors = new WeakMap();

// Ignore background noise windows/apps
const NOISE_WINDOWS = /^(?:N\/A|Desktop|gnome-shell|plasmashell|waybar|polybar|dunst|notify-osd|xdg-desktop-portal.*)$/i;

// Map common window class / title substrings to clean launchable app names
const WINDOW_APP_MAP = [
  { re: /\b(?:google\s*chrome|chromium)\b/i, app: 'chrome' },
  { re: /\b(?:brave(?:-browser)?)\b/i, app: 'brave' },
  { re: /\b(?:mozilla\s*firefox|firefox)\b/i, app: 'firefox' },
  { re: /\b(?:visual\s*studio\s*code|vs\s*code|\bcode\b)\b/i, app: 'code' },
  { re: /\b(?:spotify)\b/i, app: 'spotify' },
  { re: /\b(?:vlc)\b/i, app: 'vlc' },
  { re: /\b(?:discord)\b/i, app: 'discord' },
  { re: /\b(?:slack)\b/i, app: 'slack' },
  { re: /\b(?:telegram)\b/i, app: 'telegram' },
  { re: /\b(?:obs\s*studio|\bobs\b)\b/i, app: 'obs' },
  { re: /\b(?:gimp)\b/i, app: 'gimp' },
  { re: /\b(?:libreoffice)\b/i, app: 'libreoffice' },
  { re: /\b(?:nautilus|files|dolphin|thunar)\b/i, app: 'files' },
  { re: /\b(?:gnome-terminal|konsole|kitty|alacritty|wezterm|ptyxis|xfce4-terminal|terminal)\b/i, app: 'terminal' },
];

export function inferAppFromWindow(title = '', wmClass = '') {
  const combined = `${wmClass} ${title}`.trim();
  for (const item of WINDOW_APP_MAP) {
    if (item.re.test(combined)) return item.app;
  }
  if (wmClass) {
    const parts = String(wmClass).split('.');
    const candidate = (parts[parts.length - 1] || parts[0] || '').trim().toLowerCase();
    if (candidate && candidate.length >= 2 && !NOISE_WINDOWS.test(candidate)) {
      return candidate;
    }
  }
  // Often window titles end with " — AppName" or " - AppName"
  const tailMatch = String(title).match(/(?:\s[-—–]\s)([A-Za-z0-9_+.-]{2,25})$/);
  if (tailMatch) {
    const tail = tailMatch[1].trim().toLowerCase();
    for (const item of WINDOW_APP_MAP) {
      if (item.re.test(tail)) return item.app;
    }
    return tail;
  }
  return '';
}

export function ensureActionRecorderStore(store) {
  if (!store?.data) return null;
  if (!Array.isArray(store.data.actionRecordings)) {
    store.data.actionRecordings = [];
  }
  if (store.data.activeActionRecording === undefined) {
    store.data.activeActionRecording = null;
  }
  if (store.data.lastActionRecording === undefined) {
    store.data.lastActionRecording = null;
  }
  return store.data;
}

export function getActiveRecording(store) {
  ensureActionRecorderStore(store);
  const rec = store?.data?.activeActionRecording;
  return rec && typeof rec === 'object' ? rec : null;
}

/**
 * Snapshot current desktop state (active window, open windows, cursor pos, volume)
 * for diffing while recording. Never throws.
 */
export async function probeDesktopState() {
  const env = pc.displayEnv();
  const state = {
    ts: Date.now(),
    activeWindowId: '',
    activeTitle: '',
    activeApp: '',
    openWindows: [], // [{ id, wmClass, title, app }]
    mouse: null,     // { x, y, window }
    volume: null,    // number (0..150)
  };

  // 1. Open windows via wmctrl -l -x
  if (pc.findBin('wmctrl')) {
    try {
      const { stdout } = await execFileAsync('wmctrl', ['-l', '-x'], { timeout: 1200, env });
      for (const line of stdout.split(/\r?\n/)) {
        const m = line.match(/^(0x[0-9a-f]+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.*)$/i);
        if (!m) continue;
        const id = m[1].toLowerCase();
        const wmClass = m[3];
        const title = m[5].trim();
        if (!title || NOISE_WINDOWS.test(title) || NOISE_WINDOWS.test(wmClass)) continue;
        state.openWindows.push({
          id,
          wmClass,
          title,
          app: inferAppFromWindow(title, wmClass),
        });
      }
    } catch { /* ignore */ }
  }

  // 2. Active window & mouse location via xdotool
  if (pc.findBin('xdotool')) {
    try {
      const { stdout: winOut } = await execFileAsync('xdotool', ['getactivewindow'], { timeout: 900, env });
      const winIdNum = Number.parseInt(winOut.trim(), 10);
      if (Number.isFinite(winIdNum) && winIdNum > 0) {
        state.activeWindowId = `0x${winIdNum.toString(16).padStart(8, '0')}`;
        const { stdout: titleOut } = await execFileAsync('xdotool', ['getwindowname', String(winIdNum)], { timeout: 900, env }).catch(() => ({ stdout: '' }));
        state.activeTitle = titleOut.trim();
        const matchedWin = state.openWindows.find((w) => Number.parseInt(w.id, 16) === winIdNum);
        state.activeApp = matchedWin?.app || inferAppFromWindow(state.activeTitle, matchedWin?.wmClass || '');
      }
    } catch { /* ignore */ }

    try {
      const { stdout: mouseOut } = await execFileAsync('xdotool', ['getmouselocation', '--shell'], { timeout: 900, env });
      const x = Number(mouseOut.match(/^X=(\d+)/m)?.[1]);
      const y = Number(mouseOut.match(/^Y=(\d+)/m)?.[1]);
      const w = mouseOut.match(/^WINDOW=(\d+)/m)?.[1] || '';
      if (Number.isFinite(x) && Number.isFinite(y)) {
        state.mouse = { x, y, window: w };
      }
    } catch { /* ignore */ }
  }

  // 3. Current volume level (best-effort)
  if (pc.findBin('wpctl')) {
    try {
      const { stdout } = await execFileAsync('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], { timeout: 800, env });
      const m = stdout.match(/Volume:\s*([\d.]+)/i);
      if (m) state.volume = Math.round(Number(m[1]) * 100);
    } catch { /* ignore */ }
  } else if (pc.findBin('pactl')) {
    try {
      const { stdout } = await execFileAsync('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], { timeout: 800, env });
      const m = stdout.match(/(\d{1,3})%/);
      if (m) state.volume = Number(m[1]);
    } catch { /* ignore */ }
  }

  return state;
}

// Python AT-SPI live listener script: emits JSON lines when the user activates
// windows, clicks/focuses buttons/inputs/links, or types text.
const ATSPI_LIVE_MONITOR_PY = `
import json, sys, time
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi, GLib
except Exception as e:
    sys.exit(0)

def emit(payload):
    try:
        payload["ts"] = int(time.time() * 1000)
        sys.stdout.write(json.dumps(payload) + "\\n")
        sys.stdout.flush()
    except Exception:
        pass

def on_window_activate(event):
    try:
        src = event.source
        if not src:
            return
        title = (src.get_name() or "").strip()
        app = src.get_application()
        app_name = (app.get_name() or "").strip() if app else ""
        if title or app_name:
            emit({"type": "window_focus", "app": app_name, "title": title})
    except Exception:
        pass

def on_focus_or_click(event):
    try:
        if not event.detail1:
            return
        src = event.source
        if not src:
            return
        role = (src.get_role_name() or "").lower()
        name = (src.get_name() or "").strip()
        if role in ("push button", "button", "toggle button", "check box", "radio button", "menu item", "page tab", "link", "entry", "search box"):
            comp = src.get_component_iface()
            rect = comp.get_extents(Atspi.CoordType.SCREEN) if comp else None
            x = int(rect.x + rect.width / 2) if rect and rect.width > 0 else None
            y = int(rect.y + rect.height / 2) if rect and rect.height > 0 else None
            app = src.get_application()
            app_name = (app.get_name() or "").strip() if app else ""
            if name or (x is not None and y is not None):
                emit({
                    "type": "click",
                    "target": name[:80],
                    "role": role,
                    "app": app_name,
                    "x": x,
                    "y": y,
                })
    except Exception:
        pass

def on_text_insert(event):
    try:
        text = (event.any_data or "")
        if not text or len(text) > 200:
            return
        src = event.source
        name = (src.get_name() or "").strip() if src else ""
        emit({"type": "type", "text": text, "field": name[:60]})
    except Exception:
        pass

try:
    l_win = Atspi.EventListener.new(on_window_activate)
    l_win.register("window:activate")
    l_foc = Atspi.EventListener.new(on_focus_or_click)
    l_foc.register("object:state-changed:focused")
    l_txt = Atspi.EventListener.new(on_text_insert)
    l_txt.register("object:text-changed:insert")
    Atspi.event_main()
except Exception:
    sys.exit(0)
`.trim();

/**
 * Append a single raw desktop action event to the currently active recording.
 * Supported event types:
 *   • `open_app`      : `{ type: 'open_app', app, title? }`
 *   • `window_focus`  : `{ type: 'window_focus', app?, title }`
 *   • `open_url`      : `{ type: 'open_url', url, title? }`
 *   • `click`         : `{ type: 'click', target?, x?, y?, role?, app? }`
 *   • `type`          : `{ type: 'type', text, field? }`
 *   • `key`           : `{ type: 'key', key }`
 *   • `volume`        : `{ type: 'volume', level }`
 *   • `command`       : `{ type: 'command', cmd, args, raw? }`
 */
export function recordDesktopEvent(store, event = {}) {
  const rec = getActiveRecording(store);
  if (!rec) return null;
  if (!event || typeof event !== 'object' || !event.type) return null;

  const now = Number(event.ts) || Date.now();
  const normalized = { ...event, ts: now };

  // Coalesce consecutive `type` events within 4 seconds into a single string
  // so typing "github.com" character-by-character becomes `"github.com"`
  const prev = rec.events[rec.events.length - 1];
  if (
    normalized.type === 'type'
    && prev?.type === 'type'
    && (now - (prev.ts || 0)) <= 4000
    && (normalized.field || '') === (prev.field || '')
  ) {
    prev.text = `${prev.text || ''}${normalized.text || ''}`.slice(0, 500);
    prev.ts = now;
    store.save?.();
    return prev;
  }

  // Deduplicate identical consecutive events within 2.5 seconds
  if (prev && prev.type === normalized.type && (now - (prev.ts || 0)) <= 2500) {
    const sameApp = (prev.app || '') === (normalized.app || '') && (prev.title || '') === (normalized.title || '');
    const sameClick = (prev.target || '') === (normalized.target || '') && prev.x === normalized.x && prev.y === normalized.y;
    const sameCmd = (prev.cmd || '') === (normalized.cmd || '') && (prev.args || '') === (normalized.args || '');
    if (
      (normalized.type === 'open_app' && (prev.app || '') === (normalized.app || ''))
      || (normalized.type === 'window_focus' && sameApp)
      || (normalized.type === 'click' && sameClick)
      || (normalized.type === 'command' && sameCmd)
      || (normalized.type === 'volume' && prev.level === normalized.level)
    ) {
      return null;
    }
  }

  rec.events.push(normalized);
  if (rec.events.length > MAX_RAW_EVENTS) {
    rec.events = rec.events.slice(-MAX_RAW_EVENTS);
  }
  store.save?.();
  return normalized;
}

/**
 * Compile raw recorded desktop events into a clean, deduplicated list of
 * executable steps (`{ type, cmd, args, raw, label, ... }`) that can be both
 * saved in `store.data.learned` (for `/name`) and replayed directly.
 */
export function compileRecordedActions(events = []) {
  const steps = [];
  const openedApps = new Set();
  let lastFocusedTitle = '';

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;

    if (ev.type === 'open_app') {
      const appName = String(ev.app || inferAppFromWindow(ev.title, '') || '').trim().toLowerCase();
      if (!appName || openedApps.has(appName)) continue;
      openedApps.add(appName);
      steps.push({
        type: 'open_app',
        app: appName,
        cmd: 'open',
        args: appName,
        raw: `/open ${appName}`,
        label: `Open app *${appName}*`,
      });
      continue;
    }

    if (ev.type === 'open_url') {
      const url = String(ev.url || '').trim();
      if (!url) continue;
      steps.push({
        type: 'open_url',
        url,
        cmd: 'open',
        args: url,
        raw: `/open ${url}`,
        label: `Open URL \`${url}\``,
      });
      continue;
    }

    if (ev.type === 'window_focus') {
      const appName = String(ev.app || inferAppFromWindow(ev.title, '') || '').trim().toLowerCase();
      const title = String(ev.title || '').trim();
      if (appName && !openedApps.has(appName)) {
        openedApps.add(appName);
        steps.push({
          type: 'open_app',
          app: appName,
          title,
          cmd: 'open',
          args: appName,
          raw: `/open ${appName}`,
          label: `Open / switch to *${appName}*${title ? ` ("${title.slice(0, 45)}")` : ''}`,
        });
        lastFocusedTitle = title;
        continue;
      }
      if (title && title !== lastFocusedTitle && !NOISE_WINDOWS.test(title)) {
        lastFocusedTitle = title;
        // Extract clean focus keyword from window title
        const focusTarget = appName || title.split(/\s[-—–]\s/).pop()?.trim() || title.slice(0, 40);
        const prevStep = steps[steps.length - 1];
        if (!(prevStep?.type === 'open_app' && prevStep.app === appName)) {
          steps.push({
            type: 'focus_window',
            title,
            app: appName,
            cmd: 'focus',
            args: focusTarget,
            raw: `/focus ${focusTarget}`,
            label: `Focus window *"${title.slice(0, 50)}"*`,
          });
        }
      }
      continue;
    }

    if (ev.type === 'click') {
      const target = String(ev.target || '').trim();
      const hasCoords = Number.isFinite(Number(ev.x)) && Number.isFinite(Number(ev.y));
      if (!target && !hasCoords) continue;
      const x = hasCoords ? Math.round(Number(ev.x)) : null;
      const y = hasCoords ? Math.round(Number(ev.y)) : null;
      const tapArg = target && !/^\d+\s+\d+$/.test(target)
        ? target
        : `${x} ${y}`;
      steps.push({
        type: 'click',
        target,
        x,
        y,
        role: ev.role || '',
        cmd: 'tap',
        args: tapArg,
        raw: `/tap ${tapArg}`,
        label: target
          ? `Click *"${target}"*${x != null ? ` (${x}, ${y})` : ''}`
          : `Click at *(${x}, ${y})*`,
      });
      continue;
    }

    if (ev.type === 'type') {
      const text = String(ev.text || '').replace(/\r?\n/g, ' ').trim();
      if (!text) continue;
      steps.push({
        type: 'type',
        text,
        field: ev.field || '',
        cmd: 'pc',
        args: `type ${text}`,
        raw: `/pc type ${text}`,
        label: `Type \`${text.slice(0, 60)}\`${ev.field ? ` in "${ev.field}"` : ''}`,
      });
      continue;
    }

    if (ev.type === 'key') {
      const key = String(ev.key || '').trim();
      if (!key) continue;
      steps.push({
        type: 'key',
        key,
        cmd: 'pc',
        args: `key ${key}`,
        raw: `/pc key ${key}`,
        label: `Press key \`${key}\``,
      });
      continue;
    }

    if (ev.type === 'volume') {
      const level = Number(ev.level);
      if (!Number.isFinite(level)) continue;
      steps.push({
        type: 'volume',
        level,
        cmd: 'pc',
        args: `volume ${Math.round(level)}`,
        raw: `/pc volume ${Math.round(level)}`,
        label: `Set volume to *${Math.round(level)}%*`,
      });
      continue;
    }

    if (ev.type === 'command') {
      const cmd = String(ev.cmd || '').trim().toLowerCase();
      const args = String(ev.args ?? '').trim();
      if (!cmd) continue;
      const raw = ev.raw || `/${cmd}${args ? ` ${args}` : ''}`;
      steps.push({
        type: 'command',
        cmd,
        args,
        raw,
        label: `Run \`${raw}\``,
      });
    }
  }

  // Deduplicate adjacent identical raw steps
  const deduped = [];
  for (const s of steps) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.raw === s.raw) continue;
    deduped.push(s);
    if (deduped.length >= MAX_COMPILED_STEPS) break;
  }
  return deduped;
}

/**
 * Stop any background desktop polling / AT-SPI subprocess for `store`.
 */
export function stopLiveMonitor(store) {
  const mon = activeMonitors.get(store);
  if (!mon) return;
  if (mon.timer) clearInterval(mon.timer);
  if (mon.atspiProc) {
    try { mon.atspiProc.kill('SIGTERM'); } catch { /* ignore */ }
  }
  activeMonitors.delete(store);
}

/**
 * Start recording the owner's live PC actions (plus any WhatsApp commands).
 */
export async function startActionRecording(store, config = {}, { name = '', liveMonitor = true } = {}) {
  ensureActionRecorderStore(store);
  stopLiveMonitor(store);

  let cleanName = learn.normalizeKeyword(name || '');
  if (cleanName && learn.isReserved(cleanName)) {
    cleanName = `my_${cleanName}`.slice(0, 28);
  }

  const baseline = liveMonitor ? await probeDesktopState() : {
    ts: Date.now(),
    activeWindowId: '',
    activeTitle: '',
    activeApp: '',
    openWindows: [],
    mouse: null,
    volume: null,
  };

  const session = {
    id: Date.now(),
    name: cleanName || '',
    startedTs: Date.now(),
    baselineWindows: (baseline.openWindows || []).map((w) => w.id),
    baselineApps: [...new Set((baseline.openWindows || []).map((w) => w.app).filter(Boolean))],
    lastActiveWindowId: baseline.activeWindowId || '',
    lastActiveTitle: baseline.activeTitle || '',
    lastVolume: baseline.volume,
    events: [],
  };

  store.data.activeActionRecording = session;
  store.save?.();

  if (liveMonitor) {
    const knownWinIds = new Set(session.baselineWindows);
    let lastWindowId = session.lastActiveWindowId;
    let lastTitle = session.lastActiveTitle;
    let lastVol = session.lastVolume;
    let busy = false;

    const timer = setInterval(async () => {
      if (busy) return;
      const currentRec = getActiveRecording(store);
      if (!currentRec || currentRec.id !== session.id) {
        stopLiveMonitor(store);
        return;
      }
      busy = true;
      try {
        const snap = await probeDesktopState();
        // 1. Check for newly opened windows/apps
        for (const win of snap.openWindows) {
          if (!knownWinIds.has(win.id)) {
            knownWinIds.add(win.id);
            if (win.app) {
              recordDesktopEvent(store, {
                type: 'open_app',
                app: win.app,
                title: win.title,
                ts: snap.ts,
              });
            } else if (win.title) {
              recordDesktopEvent(store, {
                type: 'window_focus',
                title: win.title,
                ts: snap.ts,
              });
            }
          }
        }
        // 2. Check for active window / title switch
        if (
          snap.activeTitle
          && (snap.activeWindowId !== lastWindowId || snap.activeTitle !== lastTitle)
          && !NOISE_WINDOWS.test(snap.activeTitle)
        ) {
          lastWindowId = snap.activeWindowId;
          lastTitle = snap.activeTitle;
          recordDesktopEvent(store, {
            type: 'window_focus',
            app: snap.activeApp || inferAppFromWindow(snap.activeTitle, ''),
            title: snap.activeTitle,
            ts: snap.ts,
          });
        }
        // 3. Check for volume change (>= 2% delta)
        if (snap.volume != null && lastVol != null && Math.abs(snap.volume - lastVol) >= 2) {
          lastVol = snap.volume;
          recordDesktopEvent(store, {
            type: 'volume',
            level: snap.volume,
            ts: snap.ts,
          });
        } else if (snap.volume != null && lastVol == null) {
          lastVol = snap.volume;
        }
      } catch { /* ignore poll errors */ } finally {
        busy = false;
      }
    }, Math.max(500, Number(config.actionPollMs) || DEFAULT_POLL_MS));
    timer.unref?.();

    // Also spawn best-effort AT-SPI event stream if python3 is available
    let atspiProc = null;
    if (pc.findBin('python3') && pc.sessionInfo(pc.displayEnv()).graphical) {
      try {
        atspiProc = spawn('python3', ['-c', ATSPI_LIVE_MONITOR_PY], {
          env: pc.displayEnv(),
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let buf = '';
        atspiProc.stdout?.on('data', (chunk) => {
          buf += String(chunk);
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const ev = JSON.parse(line);
              if (ev && ev.type) {
                if (ev.type === 'window_focus') {
                  ev.app = inferAppFromWindow(ev.title || '', ev.app || '') || ev.app || '';
                }
                recordDesktopEvent(store, ev);
              }
            } catch { /* ignore malformed line */ }
          }
        });
        atspiProc.on('error', () => {});
        atspiProc.unref?.();
      } catch {
        atspiProc = null;
      }
    }

    activeMonitors.set(store, { timer, atspiProc });
  }

  return {
    ok: true,
    session,
    text: [
      `🔴 *PC Action Recording Started!*${session.name ? ` (Command: \`/${session.name}\`)` : ''}`,
      '',
      'Ab aap computer pe jo bhi karoge —',
      '• Apps kholna (Chrome, VS Code, Terminal, Spotify…)',
      '• Windows / tabs switch karna',
      '• Buttons / UI elements click karna ya text type karna',
      '• Volume set karna ya WhatsApp pe koi command bhejna',
      '— main sab observe karke step-by-step seekh raha hoon! 👀🖥️',
      '',
      '*Jab kaam pura ho jaye to bolo:*',
      session.name
        ? `• *"stop recording"* ya *"recording band karo"* (ye \`/${session.name}\` me save ho jayega)`
        : '• *"stop recording and save as /<name>"* (e.g. *"recording band karo aur /morning bana do"*)',
      '• Status dekhne ke liye: `/watchme status`',
      '• Cancel karne ke liye: `"cancel recording"`',
    ].join('\n'),
  };
}

/**
 * Stop recording, compile the observed PC actions into repeatable steps,
 * save the recording in `store.data.actionRecordings`, AND register it as a
 * custom `/command` in `store.data.learned`.
 */
export async function stopActionRecording(store, { name = '' } = {}) {
  ensureActionRecorderStore(store);
  const rec = getActiveRecording(store);
  stopLiveMonitor(store);

  if (!rec) {
    return {
      ok: false,
      reason: 'Abhi koi PC action recording chal nahi rahi hai. Shuru karne ke liye bolo: *"mere actions record karo"* ya `/watchme start <name>`.',
    };
  }

  // Do one final desktop probe before closing if no events were captured yet
  if (!rec.events.length) {
    try {
      const finalSnap = await probeDesktopState();
      const baseSet = new Set(rec.baselineWindows || []);
      for (const win of finalSnap.openWindows) {
        if (!baseSet.has(win.id) && win.app) {
          recordDesktopEvent(store, { type: 'open_app', app: win.app, title: win.title });
        }
      }
      if (finalSnap.activeTitle && finalSnap.activeTitle !== rec.lastActiveTitle && !NOISE_WINDOWS.test(finalSnap.activeTitle)) {
        recordDesktopEvent(store, {
          type: 'window_focus',
          app: finalSnap.activeApp || inferAppFromWindow(finalSnap.activeTitle, ''),
          title: finalSnap.activeTitle,
        });
      }
    } catch { /* ignore */ }
  }

  const compiledSteps = compileRecordedActions(rec.events);
  store.data.activeActionRecording = null;

  if (!compiledSteps.length) {
    store.save?.();
    return {
      ok: false,
      reason: '⚠️ Recording ke dauran computer par koi naya action detect nahi hua. Recording band kar di gayi hai.',
    };
  }

  let finalName = learn.normalizeKeyword(name || rec.name || 'my_actions');
  if (!finalName || finalName.length < 2) finalName = 'my_actions';
  if (learn.isReserved(finalName)) finalName = `my_${finalName}`.slice(0, 28);

  const savedRecord = {
    id: rec.id,
    name: finalName,
    startedTs: rec.startedTs,
    stoppedTs: Date.now(),
    events: rec.events,
    steps: compiledSteps,
  };

  // Save in `actionRecordings` (replace existing with same name or prepend)
  store.data.actionRecordings = [
    savedRecord,
    ...(store.data.actionRecordings || []).filter((r) => r.name !== finalName),
  ].slice(0, MAX_SAVED_RECORDINGS);
  store.data.lastActionRecording = savedRecord;

  // Also register in `store.data.learned` so `/<finalName>` and `<finalName>` run it directly!
  const learnedSteps = compiledSteps.map((s) => ({
    cmd: s.cmd,
    args: s.args,
    raw: s.raw,
    label: s.label,
    actionType: s.type,
    x: s.x ?? null,
    y: s.y ?? null,
    target: s.target ?? '',
  }));
  const rawText = compiledSteps.map((s) => s.raw).join(' | ');
  store.addLearned?.(finalName, learnedSteps, rawText);
  store.setLastOwnerTask?.(rawText);
  store.save?.();

  const stepLines = compiledSteps.map((s, idx) => `${idx + 1}. ${s.label} (\`${s.raw}\`)`).join('\n');
  return {
    ok: true,
    name: finalName,
    steps: compiledSteps,
    record: savedRecord,
    text: [
      `✅ *PC Actions Learned & Saved as \`/${finalName}\`!* (${compiledSteps.length} step${compiledSteps.length === 1 ? '' : 's'})`,
      '',
      '*Jo maine aapke computer actions se seekha:*',
      stepLines,
      '',
      '*Ab ise kabhi bhi repeat karne ke liye bolo:*',
      `• \`/${finalName}\` ya \`${finalName}\``,
      '• *"mere actions repeat karo"* / *"repeat my actions"*',
      `• *"repeat /${finalName} 2 times"*`,
    ].join('\n'),
  };
}

export function cancelActionRecording(store) {
  ensureActionRecorderStore(store);
  const rec = getActiveRecording(store);
  stopLiveMonitor(store);
  if (!rec) return { ok: false, text: 'ℹ️ Abhi koi PC action recording chal nahi rahi hai.' };
  store.data.activeActionRecording = null;
  store.save?.();
  return { ok: true, text: '🛑 *PC Action Recording Cancelled.* Kuch save nahi kiya gaya.' };
}

export function formatActionRecorderStatus(store) {
  ensureActionRecorderStore(store);
  const active = getActiveRecording(store);
  const saved = store.data.actionRecordings || [];
  const lines = [];

  if (active) {
    const compiled = compileRecordedActions(active.events);
    lines.push(
      `🔴 *Live PC Action Recording ON*${active.name ? ` — \`/${active.name}\`` : ''}`,
      `• Captured events: ${active.events.length} raw → ${compiled.length} step(s)`,
    );
    if (compiled.length) {
      lines.push('', '*Steps captured so far:*');
      compiled.forEach((s, i) => lines.push(`${i + 1}. ${s.label} (\`${s.raw}\`)`));
    }
    lines.push(
      '',
      '_Stop & save: `"stop recording"` or `/watchme stop [name]` · Cancel: `/watchme cancel`_',
    );
  } else {
    lines.push('⚪ *Live PC Action Recorder: Idle*');
    lines.push('• Start recording: *"mere actions record karo"* ya `/watchme start <name>`');
  }

  if (saved.length) {
    lines.push('', `🎞️ *Saved PC Action Recordings (${saved.length}):*`);
    for (const r of saved.slice(0, 10)) {
      const preview = (r.steps || []).map((s) => s.label.replace(/[*`_]/g, '')).slice(0, 4).join(' → ');
      lines.push(`• \`/${r.name}\` (${r.steps?.length || 0} steps): ${preview}`);
    }
    lines.push('', '_Replay: `"mere actions repeat karo"` ya `/watchme replay <name>` ya seedha `/<name>`_');
  }

  return lines.join('\n');
}

/**
 * Rename / save the most recently recorded PC actions under a new `/command` name.
 */
export function saveLastRecordingAsCommand(store, newNameRaw) {
  ensureActionRecorderStore(store);
  const last = store.data.lastActionRecording || (store.data.actionRecordings || [])[0];
  if (!last || !Array.isArray(last.steps) || !last.steps.length) {
    return {
      ok: false,
      reason: 'Abhi koi recorded PC actions nahi hain. Pehle bolo: *"mere actions record karo"*.',
    };
  }
  const kw = learn.normalizeKeyword(newNameRaw);
  const err = learn.validateKeyword(kw);
  if (err) return { ok: false, reason: err };

  last.name = kw;
  const learnedSteps = last.steps.map((s) => ({
    cmd: s.cmd,
    args: s.args,
    raw: s.raw,
    label: s.label,
    actionType: s.type,
  }));
  const rawText = last.steps.map((s) => s.raw).join(' | ');
  store.addLearned?.(kw, learnedSteps, rawText);
  store.save?.();

  return {
    ok: true,
    name: kw,
    steps: last.steps,
    text: `🧠 *Saved Recorded PC Actions as \`/${kw}\`!* (${last.steps.length} steps)\nAb \`/${kw}\`, \`${kw}\`, ya *"repeat /${kw}"* bolte hi wahi saare PC actions repeat honge.`,
  };
}

/**
 * Replay a saved PC action recording (or the most recent one if `name` is empty)
 * using the provided `runCommand(cmd, args)` callback.
 * Supports `times` (1..5) for repeating multiple times in a row.
 */
export async function replayRecordedActions(store, { name = '', times = 1, runCommand, delayMs = 150 } = {}) {
  ensureActionRecorderStore(store);
  const repeatCount = Math.max(1, Math.min(5, Number.parseInt(times, 10) || 1));
  const cleanName = learn.normalizeKeyword(name || '');

  let record = null;
  if (cleanName) {
    record = (store.data.actionRecordings || []).find((r) => r.name === cleanName) || null;
  } else {
    record = store.data.lastActionRecording || (store.data.actionRecordings || [])[0] || null;
  }

  // Fallback: if the command exists in `store.data.learned`, replay that!
  if (!record && cleanName && store.getLearned?.(cleanName)) {
    const learnedEntry = store.getLearned(cleanName);
    record = {
      name: learnedEntry.keyword,
      steps: (learnedEntry.commands || []).map((c) => ({
        type: c.actionType || 'command',
        cmd: c.inferredOpen ? 'open' : c.cmd,
        args: c.args ?? '',
        raw: c.raw || `/${c.cmd} ${c.args ?? ''}`.trim(),
        label: c.label || `/${c.cmd} ${c.args ?? ''}`.trim(),
      })),
    };
  }

  if (!record || !Array.isArray(record.steps) || !record.steps.length) {
    return {
      ok: false,
      text: cleanName
        ? `⚠️ \`/${cleanName}\` naam ki koi PC action recording nahi mili. (\`/watchme status\` dekhein)`
        : '⚠️ Abhi tak koi PC actions record nahi kiye gaye hain. Pehle bolo: *"mere actions record karo"*!',
    };
  }

  const allRunOutputs = [];
  let lastMedia = null;

  for (let pass = 1; pass <= repeatCount; pass++) {
    const stepOutputs = [];
    for (let i = 0; i < record.steps.length; i++) {
      const step = record.steps[i];
      const res = await runCommand(step.cmd, step.args ?? '');
      const outText = typeof res === 'string' ? res : (res?.text ?? '✅ Done.');
      if (res && typeof res === 'object' && (res.image || res.audio || res.document || res.video)) {
        lastMedia = res;
      }
      stepOutputs.push(`${i + 1}. ${step.label || step.raw} → ${outText}`);
      if (delayMs > 0 && i < record.steps.length - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    if (repeatCount > 1) {
      allRunOutputs.push(`*Pass ${pass}/${repeatCount}:*\n${stepOutputs.join('\n')}`);
    } else {
      allRunOutputs.push(stepOutputs.join('\n'));
    }
  }

  const summaryText = [
    `🔁 *Repeated PC Actions: \`/${record.name}\`* (${record.steps.length} step${record.steps.length === 1 ? '' : 's'}${repeatCount > 1 ? ` × ${repeatCount} times` : ''})`,
    '',
    allRunOutputs.join('\n\n'),
  ].join('\n');

  if (lastMedia) {
    return { ok: true, ...lastMedia, text: summaryText };
  }
  return { ok: true, text: summaryText };
}

/**
 * Parse natural-language owner instructions for recording, stopping, saving,
 * or repeating PC actions (English, Hindi, Hinglish).
 *
 * Returns:
 *   • `{ action: 'start', name }`
 *   • `{ action: 'stop', name }`
 *   • `{ action: 'cancel' }`
 *   • `{ action: 'status' }`
 *   • `{ action: 'save_as', name }`
 *   • `{ action: 'replay', name, times }`
 *   • `null`
 */
export function parseActionRecorderIntent(rawInput, { isRecording = false } = {}) {
  const text = String(rawInput ?? '').trim();
  if (!text || text.startsWith('/')) return null;

  let m = null;

  // ── 1. START recording PC actions ────────────────────────────────────────
  // e.g. "mere actions record karo", "record my actions", "record my pc actions as /morning",
  // "jo main computer me kar raha hoon wo record karo", "mere actions jo main computer me kar raha hoon unhe record karo",
  // "dekh main kya kar raha hoon aur seekh le"
  if (
    (m = text.match(/^(?:start\s+recording|record)\s+(?:my\s+|the\s+|whatever\s+|what\s+i\s+(?:do|am\s+doing)\s*(?:on\s+(?:my\s+)?(?:pc|computer|desktop|laptop))?\s*)?(?:pc\s+|computer\s+|desktop\s+|screen\s+)?(?:actions?|steps?|moves?|workflow|kaam|activity)?(?:\s+(?:as|named|called|into)\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27}))?$/i))
    || (m = text.match(/^(?:mere\s+|meri\s+)?(?:pc\s+|computer\s+|desktop\s+|screen\s+)?(?:ke\s+)?(?:actions?|steps?|moves?|kaam|activities|har\s+action)(?:\s+jo\s+mai(?:n)?\s+(?:abhi\s+)?(?:computer|pc|laptop|screen)\s+(?:me|mein|pe|par)\s+kar\s+raha\s+h(?:oon|u|un))?\s*(?:ko\s+|unhe\s+|usko\s+|use\s+|wo\s+|woh\s+)?(?:\+?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+naam\s+se\s+)?record\s+(?:kar(?:o|\s*do|\s*lo|\s*na|\s*le)?|shuru\s+kar(?:o|\s*do)?)(?:\s+aur\s+seekh(?:\s*lo|\s*o|\s*le)?)?$/i))
    || (m = text.match(/^(?:jo\s+(?:bhi\s+)?mai(?:n)?\s+(?:abhi\s+)?(?:computer|pc|screen|laptop)\s+(?:me|mein|pe|par)\s+kar\s+raha\s+h(?:oon|u|un)|jo\s+mai(?:n)?\s+abhi\s+kar\s+raha\s+h(?:oon|u|un)|watch\s+what\s+i\s+(?:do|am\s+doing)(?:\s+on\s+(?:my\s+)?(?:pc|computer))?)\s*(?:,|\s+aur|\s+and|\s+to)?\s*(?:us[ek]o?\s+|unhe\s+|use\s+|it\s+|wo\s+|woh\s+|sab\s+)?(?:\+?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+naam\s+se\s+)?(?:record\s+kar(?:o|\s*lo|\s*do|\s*le)?|seekh\s*l(?:o|e)|learn\s+it|observe\s+karo)(?:\s+aur\s+seekh(?:\s*lo|\s*o|\s*le)?)?$/i))
  ) {
    if (/\b(?:record|recording|watch|seekh|learn|observe)\b/i.test(text) && !/^\d+\s*second\s+screen\s+record/i.test(text)) {
      return { action: 'start', name: learn.normalizeKeyword(m[1] || '') };
    }
  }

  // ── 2. STOP / FINISH recording ───────────────────────────────────────────
  // e.g. "stop recording", "recording band karo", "stop recording and save as /morning",
  // "recording stop karke /work bana do"
  if (
    (m = text.match(/^(?:stop|finish|end|done|save)\s+(?:action\s+|pc\s+)?recording(?:\s+(?:and\s+)?(?:save|learn|make|create)(?:\s+(?:it|this))?\s+(?:as|named|called)\s+(?:command\s+)?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27}))?$/i))
    || (m = text.match(/^(?:action\s+|pc\s+)?recording\s+(?:band|stop|khatam|save|pura)\s*(?:kar(?:o|\s*do|\s*lo)?)?(?:\s+(?:aur|and)\s+(?:isko|ise)?\s*\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s*(?:naam\s+(?:se|ka)\s+)?(?:save\s+kar(?:\s*lo|\s*do|\s*o)?|command\s+bana(?:\s*do|\s*o|\s*lo)?))?$/i))
    || (isRecording && /^(?:bas\s+ho\s+gaya|ho\s+gaya\s+record|done\s+recording|stop\s+watching)$/i.test(text))
  ) {
    return { action: 'stop', name: learn.normalizeKeyword(m?.[1] || '') };
  }

  // ── 3. CANCEL recording ──────────────────────────────────────────────────
  if (/^(?:cancel|abort|discard)\s+(?:action\s+|pc\s+)?recording$/i.test(text)
    || /^(?:action\s+|pc\s+)?recording\s+(?:cancel|chhodo|hatao)(?:\s+kar(?:o|do))?$/i.test(text)) {
    return { action: 'cancel' };
  }

  // ── 4. SAVE / LEARN recorded actions under a command name ────────────────
  if (
    (m = text.match(/^(?:save|learn|turn)\s+(?:my\s+|the\s+)?recorded\s+(?:pc\s+)?(?:actions?|steps?)\s+(?:as|into)\s+(?:a\s+)?(?:command\s+)?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})$/i))
    || (m = text.match(/^(?:recorded\s+actions?\s+ko|jo\s+actions?\s+record\s+kiye\s+(?:hain|the)\s+unhe)\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s*(?:naam\s+(?:ka|se)\s+)?(?:command\s+)?(?:save|bana)\s*(?:kar\s*do|do|lo|o)?$/i))
  ) {
    return { action: 'save_as', name: learn.normalizeKeyword(m[1]) };
  }

  // ── 5. REPEAT / REPLAY recorded PC actions ───────────────────────────────
  // e.g. "mere actions repeat karo", "repeat my actions", "repeat my actions 3 times",
  // "jo maine abhi kiya wo repeat karo", "repeat /morning 2 times", "mere actions 2 baar repeat karo"
  if (
    (m = text.match(/^(?:repeat|replay|redo)\s+(?:my\s+|the\s+)?(?:last\s+|recorded\s+)?(?:pc\s+|computer\s+)?(?:actions?|steps?|recording|what\s+i\s+(?:just\s+)?did)(?:\s+(\d+)\s*(?:times?|baar))?$/i))
  ) {
    return { action: 'replay', name: '', times: Number(m[1] || 1) };
  }
  if (
    (m = text.match(/^(?:mere\s+|meri\s+)?(?:recorded\s+|pichle\s+|last\s+)?(?:pc\s+|computer\s+)?(?:actions?|steps?|kaam)\s+(?:ko\s+)?(?:(\d+)\s*baar\s+)?(?:repeat|replay|dobara)(?:\s+kar(?:o|\s*do|\s*na)?)?(?:\s+(\d+)\s*(?:baar|times?))?$/i))
    || (m = text.match(/^(?:jo\s+maine\s+(?:abhi\s+)?(?:computer\s+(?:me|pe)\s+)?kiya(?:\s+tha)?|what\s+i\s+just\s+did)\s+(?:wo\s+|use\s+|usko\s+|unhe\s+)?(?:(\d+)\s*baar\s+)?(?:repeat|replay|dobara)(?:\s+kar(?:o|\s*do)?)?$/i))
  ) {
    return { action: 'replay', name: '', times: Number(m[1] || m[2] || 1) };
  }
  if (
    (m = text.match(/^(?:repeat|replay)\s+(?:command\s+|recording\s+)?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})(?:\s+actions?)?(?:\s+(\d+)\s*(?:times?|baar))?$/i))
    || (m = text.match(/^\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+(?:wale\s+)?(?:actions?\s+)?(?:ko\s+)?(?:(\d+)\s*baar\s+)?repeat\s+kar(?:o|\s*do)?$/i))
  ) {
    const candidateName = learn.normalizeKeyword(m[1]);
    if (!['my', 'mere', 'last', 'recorded', 'pc', 'computer', 'the'].includes(candidateName)) {
      return { action: 'replay', name: candidateName, times: Number(m[2] || 1) };
    }
  }

  return null;
}
