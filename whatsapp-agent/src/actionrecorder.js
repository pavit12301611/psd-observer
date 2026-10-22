// actionrecorder.js — High-Precision Live PC Micro-Action & Button-Click
// Recorder, Learner & Replayer for PSD_Ai.
//
// Recognizes even the smallest actions on the computer:
//   • Every mouse button click: Left click, Right click, Middle click, Double click
//   • Exact UI button / widget clicked: Push buttons, Toggle buttons, Checkboxes,
//     Radio buttons, Browser/Editor Tabs, Menu items, Links, Toolbar icons,
//     Dropdowns, Sliders, Input boxes — with BOTH widget label AND exact (x, y)
//     screen coordinates
//   • Mouse drag (from x1,y1 to x2,y2) & Mouse wheel scroll (up/down ticks)
//   • Every keystroke, text entry (with live Backspace editing), and keyboard
//     shortcut (Enter, Tab, Escape, Ctrl+C, Ctrl+V, Ctrl+S, Ctrl+T, Alt+Tab…)
//   • App launches, window switches, dialog popups, clipboard copies, volume &
//     brightness changes, and WhatsApp commands
//
// 5-Layer Sensor Architecture (works on Fedora Linux Wayland & X11 without root):
//   1. Deep AT-SPI Live Event Stream (`gi.repository.Atspi`):
//      Subscribes to `mouse:button:1p/1r/2p/3p`, `object:state-changed:pressed`,
//      `object:state-changed:checked`, `object:state-changed:selected`,
//      `object:state-changed:expanded`, `object:state-changed:focused`,
//      `object:selection-changed`, `object:value-changed`,
//      `object:text-changed:insert/delete`, and `window:activate/create/close`
//      + real-time point hit-testing (`find_widget_at_point(x, y)`).
//   2. Raw XInput2 Hardware Stream (`xinput test-xi2 --root`):
//      Captures every physical mouse click (buttons 1/2/3), wheel scroll (4/5),
//      drag release, and key/shortcut press with exact screen `(x, y)`.
//   3. Live Widget Bounding-Box Cache (`inspectDesktopElements` / AT-SPI tree):
//      Maps any raw `(x, y)` click coordinate to the exact button/tab/widget at
//      that pixel even when the app didn't emit a widget-level signal.
//   4. High-Frequency Desktop State Poller (`wmctrl`, `xdotool`, `wpctl`/`pactl`,
//      `wl-paste`/`xclip`):
//      Detects new windows/apps, title/tab changes, cursor clicks, clipboard
//      changes, and audio volume changes.
//   5. Direct Event API (`recordDesktopEvent`):
//      Merges WhatsApp/voice commands and supports deterministic unit testing.
//
// Strictly Owner-Only: non-owners are 100% blocked from recording or replaying.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pc from './pccontrol.js';
import * as learn from './learn.js';
import { inspectDesktopElements } from './grounding.js';

const execFileAsync = promisify(execFile);

const MAX_RAW_EVENTS = 300;
const MAX_COMPILED_STEPS = 50;
const MAX_SAVED_RECORDINGS = 30;
const DEFAULT_POLL_MS = 700;

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

// Standard Linux X11/evdev hardware keycode (evdev + 8) -> key name table
const X11_KEYCODE_MAP = {
  9: 'Escape',
  10: '1', 11: '2', 12: '3', 13: '4', 14: '5', 15: '6', 16: '7', 17: '8', 18: '9', 19: '0',
  20: '-', 21: '=', 22: 'BackSpace', 23: 'Tab',
  24: 'q', 25: 'w', 26: 'e', 27: 'r', 28: 't', 29: 'y', 30: 'u', 31: 'i', 32: 'o', 33: 'p',
  34: '[', 35: ']', 36: 'Return', 37: 'Control_L',
  38: 'a', 39: 's', 40: 'd', 41: 'f', 42: 'g', 43: 'h', 44: 'j', 45: 'k', 46: 'l',
  47: ';', 48: "'", 49: '`', 50: 'Shift_L', 51: '\\',
  52: 'z', 53: 'x', 54: 'c', 55: 'v', 56: 'b', 57: 'n', 58: 'm',
  59: ',', 60: '.', 61: '/', 62: 'Shift_R',
  64: 'Alt_L', 65: 'space', 66: 'Caps_Lock',
  67: 'F1', 68: 'F2', 69: 'F3', 70: 'F4', 71: 'F5', 72: 'F6',
  73: 'F7', 74: 'F8', 75: 'F9', 76: 'F10', 95: 'F11', 96: 'F12',
  105: 'Control_R', 108: 'Alt_R',
  110: 'Home', 111: 'Up', 112: 'Prior', 113: 'Left', 114: 'Right', 115: 'End', 116: 'Down', 117: 'Next',
  118: 'Insert', 119: 'Delete',
  133: 'Super_L', 134: 'Super_R',
};

const MODIFIER_KEYS = new Set(['Control_L', 'Control_R', 'Shift_L', 'Shift_R', 'Alt_L', 'Alt_R', 'Super_L', 'Super_R']);

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

/**
 * Given screen coordinates `(x, y)` and a list of UI widgets (`elements` with
 * `{ left, top, width, height, name, description, role }`), find the smallest
 * (most specific) button/widget containing `(x, y)`.
 */
export function matchWidgetAtPoint(x, y, elements = []) {
  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py) || !Array.isArray(elements) || !elements.length) {
    return null;
  }
  let best = null;
  let bestArea = Infinity;
  for (const el of elements) {
    const width = Number(el.width ?? el.w ?? 0);
    const height = Number(el.height ?? el.h ?? 0);
    const left = Number(
      el.left !== undefined
        ? el.left
        : (el.w !== undefined ? el.x : (Number(el.x) - width / 2)),
    );
    const top = Number(
      el.top !== undefined
        ? el.top
        : (el.h !== undefined ? el.y : (Number(el.y) - height / 2)),
    );
    if (!Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) continue;
    // Allow 4px tolerance around small buttons/icons
    if (px >= left - 4 && px <= left + width + 4 && py >= top - 4 && py <= top + height + 4) {
      const area = width * height;
      const labelText = String(el.name || el.label || el.description || '').trim();
      const hasLabel = Boolean(labelText);
      // Prefer labeled interactive elements and smaller (innermost) bounding boxes
      const effectiveArea = hasLabel ? area * 0.5 : area;
      if (effectiveArea < bestArea) {
        bestArea = effectiveArea;
        best = {
          target: labelText,
          label: labelText,
          role: String(el.role || 'widget').trim().toLowerCase(),
          x: Math.round(px),
          y: Math.round(py),
          widgetCenterX: Math.round(left + width / 2),
          widgetCenterY: Math.round(top + height / 2),
          rect: { left: Math.round(left), top: Math.round(top), width: Math.round(width), height: Math.round(height) },
        };
      }
    }
  }
  return best;
}

/**
 * Parse a single event block from `xinput test-xi2 --root` into a normalized
 * raw input event (`button_press`, `button_release`, `scroll`, `key_press`, `key_release`).
 */
export function parseXi2EventBlock(block = '', fallbackState = {}) {
  const text = String(block ?? '');
  const header = text.match(/EVENT\s+type\s+(\d+)\s*\(([^)]+)\)/i);
  if (!header) return null;
  const typeName = header[2].trim();
  const detail = Number(text.match(/\bdetail:\s*(\d+)/i)?.[1]);
  if (!Number.isFinite(detail)) return null;

  const rootMatch = text.match(/\broot:\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/i);
  const x = rootMatch
    ? Math.round(Number(rootMatch[1]))
    : (Number.isFinite(Number(fallbackState?.mouseX)) ? Math.round(Number(fallbackState.mouseX)) : null);
  const y = rootMatch
    ? Math.round(Number(rootMatch[2]))
    : (Number.isFinite(Number(fallbackState?.mouseY)) ? Math.round(Number(fallbackState.mouseY)) : null);
  const isRaw = /^Raw/i.test(typeName);

  if (/^(?:ButtonPress|RawButtonPress)$/i.test(typeName)) {
    if (detail === 4 || detail === 5) {
      return {
        kind: 'scroll',
        direction: detail === 4 ? 'up' : 'down',
        amount: 3,
        buttonCode: detail,
        x,
        y,
        isRaw,
      };
    }
    const button = detail === 1 ? 'left' : detail === 2 ? 'middle' : detail === 3 ? 'right' : 'left';
    return { kind: 'button_press', buttonCode: detail, button, x, y, isRaw };
  }
  if (/^(?:ButtonRelease|RawButtonRelease)$/i.test(typeName)) {
    const button = detail === 1 ? 'left' : detail === 2 ? 'middle' : detail === 3 ? 'right' : 'left';
    return { kind: 'button_release', buttonCode: detail, button, x, y, isRaw };
  }
  if (/^(?:KeyPress|RawKeyPress)$/i.test(typeName)) {
    return { kind: 'key_press', keycode: detail, key: X11_KEYCODE_MAP[detail] || '', isRaw };
  }
  if (/^(?:KeyRelease|RawKeyRelease)$/i.test(typeName)) {
    return { kind: 'key_release', keycode: detail, key: X11_KEYCODE_MAP[detail] || '', isRaw };
  }
  return null;
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

  if (pc.findBin('wmctrl')) {
    try {
      const { stdout } = await execFileAsync('wmctrl', ['-l', '-x'], { timeout: 1000, env });
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

  if (pc.findBin('xdotool')) {
    try {
      const { stdout: winOut } = await execFileAsync('xdotool', ['getactivewindow'], { timeout: 800, env });
      const winIdNum = Number.parseInt(winOut.trim(), 10);
      if (Number.isFinite(winIdNum) && winIdNum > 0) {
        state.activeWindowId = `0x${winIdNum.toString(16).padStart(8, '0')}`;
        const { stdout: titleOut } = await execFileAsync('xdotool', ['getwindowname', String(winIdNum)], { timeout: 800, env }).catch(() => ({ stdout: '' }));
        state.activeTitle = titleOut.trim();
        const matchedWin = state.openWindows.find((w) => Number.parseInt(w.id, 16) === winIdNum);
        state.activeApp = matchedWin?.app || inferAppFromWindow(state.activeTitle, matchedWin?.wmClass || '');
      }
    } catch { /* ignore */ }

    try {
      const { stdout: mouseOut } = await execFileAsync('xdotool', ['getmouselocation', '--shell'], { timeout: 800, env });
      const x = Number(mouseOut.match(/^X=(\d+)/m)?.[1]);
      const y = Number(mouseOut.match(/^Y=(\d+)/m)?.[1]);
      const w = mouseOut.match(/^WINDOW=(\d+)/m)?.[1] || '';
      if (Number.isFinite(x) && Number.isFinite(y)) {
        state.mouse = { x, y, window: w };
      }
    } catch { /* ignore */ }
  }

  if (pc.findBin('wpctl')) {
    try {
      const { stdout } = await execFileAsync('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], { timeout: 700, env });
      const m = stdout.match(/Volume:\s*([\d.]+)/i);
      if (m) state.volume = Math.round(Number(m[1]) * 100);
    } catch { /* ignore */ }
  } else if (pc.findBin('pactl')) {
    try {
      const { stdout } = await execFileAsync('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], { timeout: 700, env });
      const m = stdout.match(/(\d{1,3})%/);
      if (m) state.volume = Number(m[1]);
    } catch { /* ignore */ }
  }

  return state;
}

// Deep Python AT-SPI Micro-Event & Button-Click Listener:
// Captures every mouse button click (`mouse:button:1p/1r/2p/3p`) with real-time
// widget hit-testing at `(x, y)`, every button press (`state-changed:pressed`),
// every checkbox/toggle (`state-changed:checked`), every tab/menu/list selection
// (`state-changed:selected`, `selection-changed`), every dropdown expansion
// (`state-changed:expanded`), every focus change, slider value change, text
// insertion/deletion, and window activation.
const ATSPI_LIVE_MONITOR_PY = `
import json, sys, time
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception:
    sys.exit(0)

CLICKABLE_ROLES = {
    "push button", "button", "toggle button", "check box", "radio button",
    "menu item", "check menu item", "radio menu item", "menu", "page tab",
    "link", "entry", "search box", "password text", "text", "combo box",
    "icon", "list item", "tree item", "spin button", "slider", "tool bar",
    "table cell", "heading"
}

def emit(payload):
    try:
        payload["ts"] = int(time.time() * 1000)
        sys.stdout.write(json.dumps(payload) + "\\n")
        sys.stdout.flush()
    except Exception:
        pass

def node_info(node):
    if not node:
        return None
    try:
        role = (node.get_role_name() or "").lower()
        name = (node.get_name() or "").strip()
        desc = (node.get_description() or "").strip()
        if not name and node.get_child_count() > 0 and node.get_child_count() <= 4:
            for i in range(node.get_child_count()):
                ch = node.get_child_at_index(i)
                if ch:
                    cn = (ch.get_name() or "").strip()
                    if cn:
                        name = cn
                        break
        comp = node.get_component_iface()
        rect = comp.get_extents(Atspi.CoordType.SCREEN) if comp else None
        x = int(rect.x + rect.width / 2) if rect and rect.width > 0 else None
        y = int(rect.y + rect.height / 2) if rect and rect.height > 0 else None
        app = node.get_application()
        app_name = (app.get_name() or "").strip() if app else ""
        return {
            "target": (name or desc)[:90],
            "role": role,
            "app": app_name,
            "x": x,
            "y": y,
            "w": int(rect.width) if rect else 0,
            "h": int(rect.height) if rect else 0,
        }
    except Exception:
        return None

def hit_test_point(px, py):
    best = None
    best_area = 10**12
    def walk(node, depth=0):
        nonlocal best, best_area
        if not node or depth > 12:
            return
        try:
            st = node.get_state_set()
            if not st.contains(Atspi.StateType.SHOWING) and not st.contains(Atspi.StateType.VISIBLE):
                return
            comp = node.get_component_iface()
            rect = comp.get_extents(Atspi.CoordType.SCREEN) if comp else None
            if rect and rect.width > 2 and rect.height > 2:
                if (rect.x - 4) <= px <= (rect.x + rect.width + 4) and (rect.y - 4) <= py <= (rect.y + rect.height + 4):
                    role = (node.get_role_name() or "").lower()
                    name = (node.get_name() or "").strip()
                    desc = (node.get_description() or "").strip()
                    area = rect.width * rect.height
                    eff_area = area * 0.4 if (role in CLICKABLE_ROLES and (name or desc)) else (area * 0.7 if role in CLICKABLE_ROLES else area)
                    if eff_area < best_area and (name or desc or role in CLICKABLE_ROLES):
                        best_area = eff_area
                        app = node.get_application()
                        best = {
                            "target": (name or desc)[:90],
                            "role": role,
                            "app": (app.get_name() or "").strip() if app else "",
                            "x": int(px),
                            "y": int(py),
                        }
            cnt = min(node.get_child_count(), 65)
            for i in range(cnt):
                walk(node.get_child_at_index(i), depth + 1)
        except Exception:
            pass
    try:
        desktop = Atspi.get_desktop(0)
        for a in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(a)
            if not app:
                continue
            for w in range(app.get_child_count()):
                win = app.get_child_at_index(w)
                if not win:
                    continue
                if win.get_state_set().contains(Atspi.StateType.ACTIVE):
                    walk(win, 0)
                    return best
    except Exception:
        pass
    return best

last_press_xy = None

def on_mouse_button(event):
    global last_press_xy
    try:
        ev_type = (event.type or "")
        px = int(event.detail1)
        py = int(event.detail2)
        if ev_type.endswith(":1p"):
            last_press_xy = (px, py, time.time())
            hit = hit_test_point(px, py) or {}
            emit({
                "type": "click",
                "button": "left",
                "x": px,
                "y": py,
                "target": hit.get("target", ""),
                "role": hit.get("role", ""),
                "app": hit.get("app", ""),
            })
        elif ev_type.endswith(":1r") and last_press_xy:
            x0, y0, _ = last_press_xy
            last_press_xy = None
            if ((px - x0) ** 2 + (py - y0) ** 2) ** 0.5 >= 28:
                emit({"type": "drag", "fromX": x0, "fromY": y0, "toX": px, "toY": py})
        elif ev_type.endswith(":2p"):
            hit = hit_test_point(px, py) or {}
            emit({
                "type": "middle_click",
                "button": "middle",
                "x": px,
                "y": py,
                "target": hit.get("target", ""),
                "role": hit.get("role", ""),
                "app": hit.get("app", ""),
            })
        elif ev_type.endswith(":3p"):
            hit = hit_test_point(px, py) or {}
            emit({
                "type": "right_click",
                "button": "right",
                "x": px,
                "y": py,
                "target": hit.get("target", ""),
                "role": hit.get("role", ""),
                "app": hit.get("app", ""),
            })
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

def on_state_changed(event):
    try:
        sub = (event.type or "").split(":")[-1]
        if not event.detail1:
            return
        info = node_info(event.source)
        if not info:
            return
        role = info["role"]
        target = info["target"]
        x, y = info["x"], info["y"]
        if sub == "pressed":
            emit({
                "type": "click",
                "button": "left",
                "target": target,
                "role": role or "push button",
                "app": info["app"],
                "x": x,
                "y": y,
                "source": "atspi_pressed",
            })
        elif sub == "checked":
            emit({
                "type": "click",
                "button": "left",
                "target": target,
                "role": role or "check box",
                "app": info["app"],
                "x": x,
                "y": y,
                "checked": bool(event.detail1),
            })
        elif sub in ("selected", "expanded"):
            if role in CLICKABLE_ROLES and (target or (x is not None and y is not None)):
                emit({
                    "type": "click",
                    "button": "left",
                    "target": target,
                    "role": role,
                    "app": info["app"],
                    "x": x,
                    "y": y,
                })
        elif sub == "focused":
            if role in CLICKABLE_ROLES and (target or (x is not None and y is not None)):
                emit({
                    "type": "click",
                    "button": "left",
                    "target": target,
                    "role": role,
                    "app": info["app"],
                    "x": x,
                    "y": y,
                    "source": "atspi_focus",
                })
    except Exception:
        pass

def on_text_insert(event):
    try:
        text = (event.any_data or "")
        if not text or len(text) > 300:
            return
        src = event.source
        name = (src.get_name() or "").strip() if src else ""
        emit({"type": "type", "text": text, "field": name[:60]})
    except Exception:
        pass

def on_text_delete(event):
    try:
        src = event.source
        name = (src.get_name() or "").strip() if src else ""
        emit({"type": "key", "key": "BackSpace", "field": name[:60]})
    except Exception:
        pass

try:
    l_mouse = Atspi.EventListener.new(on_mouse_button)
    for ev in ("mouse:button:1p", "mouse:button:1r", "mouse:button:2p", "mouse:button:3p"):
        try:
            l_mouse.register(ev)
        except Exception:
            pass
    l_win = Atspi.EventListener.new(on_window_activate)
    l_win.register("window:activate")
    l_st = Atspi.EventListener.new(on_state_changed)
    for st_ev in (
        "object:state-changed:pressed",
        "object:state-changed:checked",
        "object:state-changed:selected",
        "object:state-changed:expanded",
        "object:state-changed:focused",
    ):
        try:
            l_st.register(st_ev)
        except Exception:
            pass
    l_txt = Atspi.EventListener.new(on_text_insert)
    l_txt.register("object:text-changed:insert")
    l_del = Atspi.EventListener.new(on_text_delete)
    l_del.register("object:text-changed:delete")
    Atspi.event_main()
except Exception:
    sys.exit(0)
`.trim();

function distancePx(x1, y1, x2, y2) {
  if (![x1, y1, x2, y2].every((n) => Number.isFinite(Number(n)))) return Infinity;
  return Math.hypot(Number(x2) - Number(x1), Number(y2) - Number(y1));
}

/**
 * Append a single raw desktop micro-action event to the currently active
 * recording. Handles:
 *   • `click`         : `{ type: 'click', button?: 'left'|'right'|'middle', target?, x?, y?, role?, app? }`
 *   • `double_click`  : `{ type: 'double_click', target?, x?, y?, role?, app? }`
 *   • `right_click`   : `{ type: 'right_click', target?, x?, y?, role?, app? }`
 *   • `middle_click`  : `{ type: 'middle_click', target?, x?, y?, role?, app? }`
 *   • `drag`          : `{ type: 'drag', fromX, fromY, toX, toY }`
 *   • `scroll`        : `{ type: 'scroll', direction: 'up'|'down', amount?, x?, y? }`
 *   • `type`          : `{ type: 'type', text, field? }`
 *   • `key`           : `{ type: 'key', key, field? }`
 *   • `open_app`      : `{ type: 'open_app', app, title? }`
 *   • `window_focus`  : `{ type: 'window_focus', app?, title }`
 *   • `open_url`      : `{ type: 'open_url', url, title? }`
 *   • `volume`        : `{ type: 'volume', level }`
 *   • `clipboard`     : `{ type: 'clipboard', text }`
 *   • `command`       : `{ type: 'command', cmd, args, raw? }`
 */
export function recordDesktopEvent(store, event = {}) {
  const rec = getActiveRecording(store);
  if (!rec) return null;
  if (!event || typeof event !== 'object' || !event.type) return null;

  const now = Number(event.ts) || Date.now();
  const normalized = { ...event, ts: now };

  // Support `{ type: 'backspace', count }` as shorthand for BackSpace key presses
  if (normalized.type === 'backspace') {
    normalized.type = 'key';
    normalized.key = 'BackSpace';
    normalized.count = Math.max(1, Number(event.count) || 1);
  }

  // Keep `target` and `label` synchronized on click events
  if (['click', 'double_click', 'right_click', 'middle_click'].includes(normalized.type)) {
    const lbl = String(normalized.target || normalized.label || '').trim();
    if (lbl) {
      normalized.target = lbl;
      normalized.label = lbl;
    }
  }

  // Normalize right/middle button clicks passed as `{ type: 'click', button: 'right' }`
  if (normalized.type === 'click') {
    const btn = String(normalized.button || 'left').toLowerCase();
    if (btn === 'right' || btn === '3') {
      normalized.type = 'right_click';
      normalized.button = 'right';
      normalized.clicks = 1;
    } else if (btn === 'middle' || btn === '2') {
      normalized.type = 'middle_click';
      normalized.button = 'middle';
      normalized.clicks = 1;
    } else if (Number(normalized.clicks) >= 2) {
      normalized.type = 'double_click';
      normalized.button = 'left';
      normalized.clicks = 2;
    } else {
      normalized.button = 'left';
      normalized.clicks = 1;
    }
  } else if (normalized.type === 'right_click') {
    normalized.button = 'right';
    normalized.clicks = 1;
  } else if (normalized.type === 'middle_click') {
    normalized.button = 'middle';
    normalized.clicks = 1;
  } else if (normalized.type === 'double_click') {
    normalized.button = 'left';
    normalized.clicks = 2;
  }

  // Enrich raw (x, y) click with cached AT-SPI widget map if target is missing
  if (
    ['click', 'double_click', 'right_click', 'middle_click'].includes(normalized.type)
    && !normalized.target
    && Number.isFinite(Number(normalized.x))
    && Number.isFinite(Number(normalized.y))
    && Array.isArray(rec.widgetCache)
    && rec.widgetCache.length
  ) {
    const matchedWidget = matchWidgetAtPoint(normalized.x, normalized.y, rec.widgetCache);
    if (matchedWidget) {
      normalized.target = matchedWidget.target || '';
      normalized.label = matchedWidget.label || matchedWidget.target || '';
      normalized.role = normalized.role || matchedWidget.role || '';
    }
  }

  const prev = rec.events[rec.events.length - 1];

  // 1. Coalesce consecutive `type` events within 4 seconds into one string
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

  // 2. If user presses BackSpace right after typing (within 3s), edit the typed string in-place!
  if (
    normalized.type === 'key'
    && /^backspace$/i.test(String(normalized.key || ''))
    && prev?.type === 'type'
    && prev.text?.length > 0
    && (now - (prev.ts || 0)) <= 3000
  ) {
    const delCount = Math.max(1, Number(normalized.count) || 1);
    prev.text = prev.text.slice(0, -delCount);
    prev.ts = now;
    if (!prev.text) rec.events.pop();
    store.save?.();
    return prev;
  }

  // 3. Coalesce consecutive scroll wheel ticks in the same direction within 1.5s
  if (
    normalized.type === 'scroll'
    && prev?.type === 'scroll'
    && (prev.direction || 'down') === (normalized.direction || 'down')
    && (now - (prev.ts || 0)) <= 1500
  ) {
    prev.amount = Math.min(25, (Number(prev.amount) || 1) + (Number(normalized.amount) || 1));
    prev.ts = now;
    store.save?.();
    return prev;
  }

  // 4. Smart Click Handling:
  //    a) Sensor fusion (< 300ms): if xinput emitted raw (x, y) without a widget label
  //       and shortly after AT-SPI emitted the button's `target`/`label` & `role` for the
  //       same click, merge them into a single rich click event!
  //    b) Double-click detection (95ms..420ms at same spot / same button):
  //       automatically upgrade two rapid left clicks on the same spot into `double_click`!
  if (normalized.type === 'click' && prev?.type === 'click') {
    const dt = now - (prev.ts || 0);
    const dist = distancePx(prev.x, prev.y, normalized.x, normalized.y);
    const sameSpot = dist <= 14 || (prev.target && normalized.target && prev.target === normalized.target);
    const FocusFollowup = normalized.source === 'atspi_focus' && dt <= 220;
    const complementaryFusion = dt <= 350 && (
      (!prev.target && normalized.target && (normalized.x == null || sameSpot))
      || (prev.target && !normalized.target && prev.x == null)
    );

    if ((dt <= 95 && (sameSpot || !prev.target || !normalized.target)) || FocusFollowup || complementaryFusion) {
      if (normalized.target && !prev.target) {
        prev.target = normalized.target;
        prev.label = normalized.target;
      }
      if (normalized.role && !prev.role) prev.role = normalized.role;
      if (normalized.app && !prev.app) prev.app = normalized.app;
      if (prev.x == null && normalized.x != null) prev.x = normalized.x;
      if (prev.y == null && normalized.y != null) prev.y = normalized.y;
      return prev;
    }

    if (dt > 95 && dt <= 420 && sameSpot && normalized.source !== 'atspi_focus') {
      prev.type = 'double_click';
      prev.clicks = 2;
      if (normalized.target && !prev.target) {
        prev.target = normalized.target;
        prev.label = normalized.target;
      }
      if (normalized.role && !prev.role) prev.role = normalized.role;
      prev.ts = now;
      store.save?.();
      return prev;
    }
  }

  // 5. Deduplicate non-click identical consecutive events (window focus, volume, command)
  if (prev && prev.type === normalized.type && (now - (prev.ts || 0)) <= 2000) {
    const sameApp = (prev.app || '') === (normalized.app || '') && (prev.title || '') === (normalized.title || '');
    const sameCmd = (prev.cmd || '') === (normalized.cmd || '') && (prev.args || '') === (normalized.args || '');
    if (
      (normalized.type === 'open_app' && (prev.app || '') === (normalized.app || ''))
      || (normalized.type === 'window_focus' && sameApp)
      || (normalized.type === 'command' && sameCmd)
      || (normalized.type === 'volume' && prev.level === normalized.level)
      || (normalized.type === 'clipboard' && prev.text === normalized.text)
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

function formatRoleLabel(role = '') {
  const r = String(role || '').toLowerCase();
  if (r.includes('check')) return 'checkbox';
  if (r.includes('toggle')) return 'toggle button';
  if (r.includes('radio')) return 'radio button';
  if (r.includes('tab')) return 'tab';
  if (r.includes('menu')) return 'menu item';
  if (r.includes('link')) return 'link';
  if (r.includes('entry') || r.includes('search') || r.includes('text')) return 'input box';
  if (r.includes('combo')) return 'dropdown';
  if (r.includes('slider')) return 'slider';
  if (r.includes('icon')) return 'icon';
  if (r.includes('button')) return 'button';
  return '';
}

/**
 * Compile raw recorded desktop micro-events into a clean, ordered list of
 * repeatable steps (`{ type, cmd, args, raw, label, x, y, target, ... }`).
 * Every distinct button click, double-click, right-click, drag, scroll,
 * keystroke, shortcut, app open, and window focus is preserved!
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

    if (['click', 'double_click', 'right_click', 'middle_click'].includes(ev.type)) {
      const target = String(ev.target || '').trim();
      const hasCoords = Number.isFinite(Number(ev.x)) && Number.isFinite(Number(ev.y));
      if (!target && !hasCoords) continue;
      const x = hasCoords ? Math.round(Number(ev.x)) : null;
      const y = hasCoords ? Math.round(Number(ev.y)) : null;
      const roleTag = formatRoleLabel(ev.role);
      const rolePrefix = roleTag ? `${roleTag} ` : '';

      if (ev.type === 'double_click') {
        const clickArgs = hasCoords ? `click double ${x} ${y}` : `tap ${target}`;
        steps.push({
          type: 'double_click',
          button: 'left',
          clicks: 2,
          target,
          role: ev.role || '',
          x,
          y,
          cmd: hasCoords ? 'pc' : 'tap',
          args: hasCoords ? clickArgs : target,
          raw: hasCoords ? `/pc ${clickArgs}` : `/tap ${target}`,
          label: target
            ? `Double-click ${rolePrefix}*"${target}"*${hasCoords ? ` at (${x}, ${y})` : ''}`
            : `Double-click at *(${x}, ${y})*`,
        });
        continue;
      }

      if (ev.type === 'right_click') {
        const clickArgs = hasCoords ? `click right ${x} ${y}` : `tap ${target}`;
        steps.push({
          type: 'right_click',
          button: 'right',
          clicks: 1,
          target,
          role: ev.role || '',
          x,
          y,
          cmd: hasCoords ? 'pc' : 'tap',
          args: hasCoords ? clickArgs : target,
          raw: hasCoords ? `/pc ${clickArgs}` : `/tap ${target}`,
          label: target
            ? `Right-click ${rolePrefix}*"${target}"*${hasCoords ? ` at (${x}, ${y})` : ''}`
            : `Right-click at *(${x}, ${y})*`,
        });
        continue;
      }

      if (ev.type === 'middle_click') {
        const clickArgs = hasCoords ? `click middle ${x} ${y}` : `tap ${target}`;
        steps.push({
          type: 'middle_click',
          button: 'middle',
          clicks: 1,
          target,
          role: ev.role || '',
          x,
          y,
          cmd: hasCoords ? 'pc' : 'tap',
          args: hasCoords ? clickArgs : target,
          raw: hasCoords ? `/pc ${clickArgs}` : `/tap ${target}`,
          label: target
            ? `Middle-click ${rolePrefix}*"${target}"*${hasCoords ? ` at (${x}, ${y})` : ''}`
            : `Middle-click at *(${x}, ${y})*`,
        });
        continue;
      }

      // Standard left click on a button / checkbox / tab / icon / coordinate
      const tapArg = hasCoords ? `click ${x} ${y}` : target;
      steps.push({
        type: 'click',
        button: 'left',
        clicks: 1,
        target,
        role: ev.role || '',
        x,
        y,
        cmd: hasCoords ? 'pc' : 'tap',
        args: tapArg,
        raw: hasCoords ? `/pc click ${x} ${y}` : `/tap ${target}`,
        label: target
          ? `Click ${rolePrefix}*"${target}"*${hasCoords ? ` at (${x}, ${y})` : ''}`
          : `Click at *(${x}, ${y})*`,
      });
      continue;
    }

    if (ev.type === 'drag') {
      const coords = [ev.fromX, ev.fromY, ev.toX, ev.toY].map((n) => Math.round(Number(n)));
      if (!coords.every(Number.isFinite)) continue;
      const [x1, y1, x2, y2] = coords;
      steps.push({
        type: 'drag',
        fromX: x1,
        fromY: y1,
        toX: x2,
        toY: y2,
        cmd: 'pc',
        args: `drag ${x1} ${y1} ${x2} ${y2}`,
        raw: `/pc drag ${x1} ${y1} ${x2} ${y2}`,
        label: `Drag mouse *(${x1}, ${y1}) → (${x2}, ${y2})*`,
      });
      continue;
    }

    if (ev.type === 'scroll') {
      const dir = String(ev.direction || 'down').toLowerCase() === 'up' ? 'up' : 'down';
      const amount = Math.max(1, Math.min(25, Number.parseInt(ev.amount, 10) || 3));
      const hasCoords = Number.isFinite(Number(ev.x)) && Number.isFinite(Number(ev.y));
      const x = hasCoords ? Math.round(Number(ev.x)) : null;
      const y = hasCoords ? Math.round(Number(ev.y)) : null;
      steps.push({
        type: 'scroll',
        direction: dir,
        amount,
        x,
        y,
        cmd: 'pc',
        args: `scroll ${dir} ${amount}`,
        raw: `/pc scroll ${dir} ${amount}`,
        label: `Scroll *${dir}* (${amount} step${amount === 1 ? '' : 's'})${hasCoords ? ` at (${x}, ${y})` : ''}`,
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

    if (ev.type === 'clipboard') {
      const text = String(ev.text || '').trim();
      if (!text) continue;
      steps.push({
        type: 'clipboard',
        text,
        cmd: 'pc',
        args: `clipset ${text}`,
        raw: `/pc clipset ${text}`,
        label: `Copy to clipboard: \`${text.slice(0, 45)}\``,
      });
      continue;
    }

    if (ev.type === 'volume') {
      const level = Number(ev.level);
      if (!Number.isFinite(level)) continue;
      steps.push({
        type: 'volume',
        level: Math.round(level),
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

  // Only deduplicate adjacent non-click steps (never drop intentional repeated button clicks!)
  const deduped = [];
  for (const s of steps) {
    s.actionType = s.type;
    const prev = deduped[deduped.length - 1];
    const isClickStep = ['click', 'double_click', 'right_click', 'middle_click', 'key'].includes(s.type);
    if (!isClickStep && prev && prev.raw === s.raw) continue;
    deduped.push(s);
    if (deduped.length >= MAX_COMPILED_STEPS) break;
  }
  return deduped;
}

/**
 * Stop any background desktop polling / AT-SPI / XInput2 subprocesses for `store`.
 */
export function stopLiveMonitor(store) {
  const mon = activeMonitors.get(store);
  if (!mon) return;
  if (mon.timer) clearInterval(mon.timer);
  if (mon.widgetTimer) clearInterval(mon.widgetTimer);
  if (mon.atspiProc) {
    try { mon.atspiProc.kill('SIGTERM'); } catch { /* ignore */ }
  }
  if (mon.xi2Proc) {
    try { mon.xi2Proc.kill('SIGTERM'); } catch { /* ignore */ }
  }
  activeMonitors.delete(store);
}

/**
 * Start recording the owner's live PC micro-actions & button clicks.
 */
export async function startActionRecording(store, configOrOpts = {}, maybeOpts) {
  ensureActionRecorderStore(store);
  stopLiveMonitor(store);

  const isTwoArgOpts = maybeOpts === undefined && configOrOpts && (
    'name' in configOrOpts || 'liveMonitor' in configOrOpts
  ) && !('actionPollMs' in configOrOpts) && !('ownerNumber' in configOrOpts);

  const config = isTwoArgOpts ? {} : (configOrOpts || {});
  const opts = isTwoArgOpts ? configOrOpts : (maybeOpts || {});
  const name = opts.name || '';
  const liveMonitor = opts.liveMonitor !== undefined ? Boolean(opts.liveMonitor) : !isTwoArgOpts;

  let cleanName = learn.normalizeKeyword(name || '');
  if (cleanName && learn.isReserved(cleanName)) {
    cleanName = `my_${cleanName}`.slice(0, 28);
  }

  const desktopEnv = {
    ...pc.displayEnv(),
    ACCESSIBILITY_ENABLED: '1',
    GNOME_ACCESSIBILITY: '1',
    QT_ACCESSIBILITY: '1',
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON: '1',
  };

  // Best-effort: enable GNOME/GTK toolkit accessibility so buttons/tabs/inputs expose AT-SPI nodes
  if (liveMonitor && pc.findBin('gsettings')) {
    execFileAsync('gsettings', ['set', 'org.gnome.desktop.interface', 'toolkit-accessibility', 'true'], {
      timeout: 800,
      env: desktopEnv,
    }).catch(() => {});
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
    widgetCache: [],
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
    let widgetBusy = false;

    // Refresh active window's AT-SPI widget bounding-box cache so any raw (x,y) click
    // immediately knows which button/tab/checkbox/icon sits at that pixel!
    const refreshWidgetCache = async () => {
      if (widgetBusy) return;
      const currentRec = getActiveRecording(store);
      if (!currentRec || currentRec.id !== session.id) return;
      widgetBusy = true;
      try {
        const res = await inspectDesktopElements({ timeoutMs: 1400 });
        if (Array.isArray(res?.elements) && res.elements.length) {
          currentRec.widgetCache = res.elements;
        }
      } catch { /* ignore */ } finally {
        widgetBusy = false;
      }
    };
    refreshWidgetCache().catch(() => {});
    const widgetTimer = setInterval(refreshWidgetCache, 1500);
    widgetTimer.unref?.();

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
          refreshWidgetCache().catch(() => {});
        }
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
    }, Math.max(400, Number(config.actionPollMs) || DEFAULT_POLL_MS));
    timer.unref?.();

    const isGraphical = pc.sessionInfo(desktopEnv).graphical;

    // Sensor 1: Deep Python AT-SPI Micro-Event & Point Hit-Test Listener
    let atspiProc = null;
    if (pc.findBin('python3') && isGraphical) {
      try {
        atspiProc = spawn('python3', ['-c', ATSPI_LIVE_MONITOR_PY], {
          env: desktopEnv,
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

    // Sensor 2: Raw XInput2 Hardware Mouse Click, Drag, Scroll & Key Listener (`xinput test-xi2 --root`)
    let xi2Proc = null;
    if (pc.findBin('xinput') && isGraphical) {
      try {
        xi2Proc = spawn('xinput', ['test-xi2', '--root'], {
          env: desktopEnv,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        let xiBuf = '';
        let activeMods = new Set();
        let lastPressCoords = null;
        let lastXiEventTs = 0;

        const handleXiBlock = async (block) => {
          const parsed = parseXi2EventBlock(block);
          if (!parsed) return;
          const nowTs = Date.now();
          // Avoid duplicate Processing of RawButtonPress + ButtonPress for the same hardware tick
          if (parsed.isRaw && (nowTs - lastXiEventTs) < 25) return;
          lastXiEventTs = nowTs;

          if (parsed.kind === 'button_press') {
            let { x, y } = parsed;
            if ((x == null || y == null) && pc.findBin('xdotool')) {
              try {
                const { stdout } = await execFileAsync('xdotool', ['getmouselocation', '--shell'], { timeout: 250, env: desktopEnv });
                x = Number(stdout.match(/^X=(\d+)/m)?.[1]);
                y = Number(stdout.match(/^Y=(\d+)/m)?.[1]);
              } catch { /* ignore */ }
            }
            if (parsed.buttonCode === 1) {
              lastPressCoords = { x, y, ts: nowTs };
              recordDesktopEvent(store, { type: 'click', button: 'left', x, y, ts: nowTs });
            } else if (parsed.buttonCode === 2) {
              recordDesktopEvent(store, { type: 'middle_click', button: 'middle', x, y, ts: nowTs });
            } else if (parsed.buttonCode === 3) {
              recordDesktopEvent(store, { type: 'right_click', button: 'right', x, y, ts: nowTs });
            } else if (parsed.buttonCode === 4) {
              recordDesktopEvent(store, { type: 'scroll', direction: 'up', amount: 1, x, y, ts: nowTs });
            } else if (parsed.buttonCode === 5) {
              recordDesktopEvent(store, { type: 'scroll', direction: 'down', amount: 1, x, y, ts: nowTs });
            }
          } else if (parsed.kind === 'scroll') {
            recordDesktopEvent(store, {
              type: 'scroll',
              direction: parsed.direction || 'down',
              amount: 1,
              x: parsed.x,
              y: parsed.y,
              ts: nowTs,
            });
          } else if (parsed.kind === 'button_release' && parsed.buttonCode === 1 && lastPressCoords) {
            const { x: x0, y: y0 } = lastPressCoords;
            lastPressCoords = null;
            if (parsed.x != null && parsed.y != null && x0 != null && y0 != null && distancePx(x0, y0, parsed.x, parsed.y) >= 28) {
              recordDesktopEvent(store, {
                type: 'drag',
                fromX: x0,
                fromY: y0,
                toX: parsed.x,
                toY: parsed.y,
                ts: nowTs,
              });
            }
          } else if (parsed.kind === 'key_press') {
            const keyName = X11_KEYCODE_MAP[parsed.keycode];
            if (!keyName) return;
            if (MODIFIER_KEYS.has(keyName)) {
              activeMods.add(keyName);
              return;
            }
            const hasCtrl = activeMods.has('Control_L') || activeMods.has('Control_R');
            const hasAlt = activeMods.has('Alt_L') || activeMods.has('Alt_R');
            const hasSuper = activeMods.has('Super_L') || activeMods.has('Super_R');
            const hasShift = activeMods.has('Shift_L') || activeMods.has('Shift_R');

            if (hasCtrl || hasAlt || hasSuper) {
              const mods = [];
              if (hasCtrl) mods.push('ctrl');
              if (hasAlt) mods.push('alt');
              if (hasShift) mods.push('shift');
              if (hasSuper) mods.push('super');
              recordDesktopEvent(store, {
                type: 'key',
                key: `${mods.join('+')}+${keyName.toLowerCase()}`,
                ts: nowTs,
              });
            } else if (keyName.length === 1 || keyName === 'space') {
              const ch = keyName === 'space' ? ' ' : (hasShift ? keyName.toUpperCase() : keyName);
              recordDesktopEvent(store, { type: 'type', text: ch, ts: nowTs });
            } else {
              recordDesktopEvent(store, { type: 'key', key: keyName, ts: nowTs });
            }
          } else if (parsed.kind === 'key_release') {
            const keyName = X11_KEYCODE_MAP[parsed.keycode];
            if (keyName && MODIFIER_KEYS.has(keyName)) {
              activeMods.delete(keyName);
            }
          }
        };

        xi2Proc.stdout?.on('data', (chunk) => {
          xiBuf += String(chunk);
          const parts = xiBuf.split(/(?=EVENT\s+type\s+\d+)/g);
          xiBuf = parts.pop() ?? '';
          for (const block of parts) {
            if (block.trim()) handleXiBlock(block).catch(() => {});
          }
        });
        xi2Proc.on('error', () => {});
        xi2Proc.unref?.();
      } catch {
        xi2Proc = null;
      }
    }

    activeMonitors.set(store, { timer, widgetTimer, atspiProc, xi2Proc });
  }

  return {
    ok: true,
    session,
    text: [
      `🔴 *PC Action Recording Started!* (High-Precision Micro-Action & Button-Click Mode)${session.name ? ` — \`/${session.name}\`` : ''}`,
      '',
      'Ab main aapke chhote se chhote computer actions observe kar raha hoon:',
      '• 🖱️ *Har Button Click*: Left-click, Double-click, Right-click, Checkboxes, Tabs, Menus, Icons (exact button naam + `(x, y)` coordinates ke saath)',
      '• ↕️ *Mouse Drag & Wheel Scroll*: Upar/neeche scroll aur drag moves',
      '• ⌨️ *Har Keystroke & Shortcut*: Typing, Backspace, Enter, Tab, `Ctrl+C`, `Ctrl+V`, `Alt+Tab`…',
      '• 🪟 *Apps, Windows & Volume*: Har naya app, window switch, aur volume change',
      '',
      '*Jab kaam pura ho jaye to bolo:*',
      session.name
        ? `• *"stop recording"* ya *"recording band karo"* (ye \`/${session.name}\` me save ho jayega)`
        : '• *"recording band karo aur /<name> command bana do"*',
      '• Live steps dekhne ke liye: `/watchme status`',
    ].join('\n'),
  };
}

/**
 * Stop recording, compile all observed PC micro-actions & button clicks into
 * repeatable steps, save in `store.data.actionRecordings`, AND register as a
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

  store.data.actionRecordings = [
    savedRecord,
    ...(store.data.actionRecordings || []).filter((r) => r.name !== finalName),
  ].slice(0, MAX_SAVED_RECORDINGS);
  store.data.lastActionRecording = savedRecord;

  const learnedSteps = compiledSteps.map((s) => ({
    cmd: s.cmd,
    args: s.args,
    raw: s.raw,
    label: s.label,
    actionType: s.type,
    button: s.button ?? 'left',
    clicks: s.clicks ?? 1,
    x: s.x ?? null,
    y: s.y ?? null,
    fromX: s.fromX ?? null,
    fromY: s.fromY ?? null,
    toX: s.toX ?? null,
    toY: s.toY ?? null,
    direction: s.direction ?? null,
    amount: s.amount ?? null,
    text: s.text ?? null,
    key: s.key ?? null,
    target: s.target ?? '',
    role: s.role ?? '',
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
      '*Jo maine aapke computer actions & button clicks se seekha:*',
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
      lines.push('', '*Micro-actions & button clicks captured so far:*');
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
    button: s.button ?? 'left',
    clicks: s.clicks ?? 1,
    x: s.x ?? null,
    y: s.y ?? null,
    fromX: s.fromX ?? null,
    fromY: s.fromY ?? null,
    toX: s.toX ?? null,
    toY: s.toY ?? null,
    direction: s.direction ?? null,
    amount: s.amount ?? null,
    text: s.text ?? null,
    key: s.key ?? null,
    target: s.target ?? '',
    role: s.role ?? '',
  }));
  const rawText = last.steps.map((s) => s.raw).join(' | ');
  store.addLearned?.(kw, learnedSteps, rawText);
  store.save?.();

  return {
    ok: true,
    name: kw,
    steps: last.steps,
    text: `🧠 *Saved Recorded PC Actions as \`/${kw}\`!* (${last.steps.length} steps)\nAb \`/${kw}\`, \`${kw}\`, ya *"repeat /${kw}"* bolte hi wahi saare PC actions aur button clicks repeat honge.`,
  };
}

/**
 * Self-Heal a recorded click step's (x, y) coordinates if the target UI button
 * moved on screen (using `liveWidgets` from AT-SPI / grounding).
 */
export function selfHealRecordedStep(step, liveWidgets = []) {
  if (!step || !step.target || !Array.isArray(liveWidgets) || !liveWidgets.length) {
    return { step, healed: false };
  }
  const targetNorm = String(step.target).trim().toLowerCase();
  if (!targetNorm) return { step, healed: false };

  const match = liveWidgets.find((w) => {
    const label = String(w.label || w.name || w.target || '').trim().toLowerCase();
    return label && (label === targetNorm || label.includes(targetNorm) || targetNorm.includes(label));
  });
  if (!match) return { step, healed: false };

  const newX = Number.isFinite(Number(match.x))
    ? Math.round(Number(match.x))
    : Number.isFinite(Number(match.left)) && Number.isFinite(Number(match.width))
    ? Math.round(Number(match.left) + Number(match.width) / 2)
    : null;
  const newY = Number.isFinite(Number(match.y))
    ? Math.round(Number(match.y))
    : Number.isFinite(Number(match.top)) && Number.isFinite(Number(match.height))
    ? Math.round(Number(match.top) + Number(match.height) / 2)
    : null;
  if (newX === null || newY === null) return { step, healed: false };

  const moved = step.x != null && step.y != null && (Math.abs(step.x - newX) > 5 || Math.abs(step.y - newY) > 5);
  const healedStep = {
    ...step,
    x: newX,
    y: newY,
    args: String(step.args || '').replace(/(-?\d+)\s+(-?\d+)$/, `${newX} ${newY}`),
  };
  return {
    step: healedStep,
    healed: Boolean(moved || step.x == null),
    from: [step.x, step.y],
    to: [newX, newY],
  };
}

/**
 * Execute a single recorded micro-action step directly on the desktop (when a
 * graphical session is active) or through the fallback `runCommand(cmd, args)`.
 */
export async function executeRecordedStep(rawStep, { runCommand, liveWidgets = [] } = {}) {
  const { step } = selfHealRecordedStep(rawStep, liveWidgets);
  const type = step?.type || step?.actionType || 'command';
  const hasDesktop = pc.sessionInfo(pc.displayEnv()).graphical;

  if (hasDesktop) {
    try {
      if (['click', 'double_click', 'right_click', 'middle_click'].includes(type)) {
        const x = Number(step.x);
        const y = Number(step.y);
        const button = type === 'right_click' ? 'right' : type === 'middle_click' ? 'middle' : (step.button || 'left');
        const clicks = type === 'double_click' ? 2 : (Number(step.clicks) || 1);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          return await pc.click(x, y, button, clicks);
        }
      } else if (type === 'drag') {
        const coords = [step.fromX, step.fromY, step.toX, step.toY].map(Number);
        if (coords.every(Number.isFinite)) {
          return await pc.dragMouse(coords[0], coords[1], coords[2], coords[3]);
        }
      } else if (type === 'scroll') {
        const x = Number(step.x);
        const y = Number(step.y);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          await pc.moveMouse(x, y).catch(() => {});
        }
        return await pc.scrollMouse(step.direction || 'down', step.amount || 3);
      } else if (type === 'type' && step.text) {
        return await pc.typeText(step.text);
      } else if (type === 'key' && step.key) {
        return await pc.keyCombo(step.key);
      }
    } catch {
      // Fall back to runCommand below
    }
  }

  if (typeof runCommand === 'function') {
    return runCommand(step.cmd, step.args ?? '');
  }
  return '✅ Done.';
}

/**
 * Replay a saved PC action recording (or the most recent one if `name` is empty).
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

  if (!record && cleanName && store.getLearned?.(cleanName)) {
    const learnedEntry = store.getLearned(cleanName);
    record = {
      name: learnedEntry.keyword,
      steps: (learnedEntry.commands || []).map((c) => ({
        ...c,
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
      const res = await executeRecordedStep(step, { runCommand });
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
 */
export function parseActionRecorderIntent(rawInput, { isRecording = false } = {}) {
  const text = String(rawInput ?? '').trim();
  if (!text || text.startsWith('/')) return null;

  let m = null;

  // ── 1. START recording PC actions ────────────────────────────────────────
  if (
    (m = text.match(/^(?:start\s+recording|record)\s+(?:my\s+|the\s+|whatever\s+|what\s+i\s+(?:do|am\s+doing)\s*(?:on\s+(?:my\s+)?(?:pc|computer|desktop|laptop))?\s*)?(?:pc\s+|computer\s+|desktop\s+|screen\s+)?(?:actions?|steps?|moves?|clicks?|workflow|kaam|activity)?(?:\s+(?:as|named|called|into)\s+\/?([a-zA-Z][a-zA-Z0-9_-]{1,27}))?$/i))
    || (m = text.match(/^(?:mere\s+|meri\s+)?(?:pc\s+|computer\s+|desktop\s+|screen\s+)?(?:ke\s+)?(?:actions?|steps?|moves?|clicks?|kaam|activities|har\s+action)(?:\s+jo\s+mai(?:n)?\s+(?:abhi\s+)?(?:computer|pc|laptop|screen)\s+(?:me|mein|pe|par)\s+kar\s+raha\s+h(?:oon|u|un))?\s*(?:ko\s+|unhe\s+|usko\s+|use\s+|wo\s+|woh\s+)?(?:\+?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+naam\s+se\s+)?record\s+(?:kar(?:o|\s*do|\s*lo|\s*na|\s*le)?|shuru\s+kar(?:o|\s*do)?)(?:\s+aur\s+seekh(?:\s*lo|\s*o|\s*le)?)?$/i))
    || (m = text.match(/^(?:jo\s+(?:bhi\s+)?mai(?:n)?\s+(?:abhi\s+)?(?:computer|pc|screen|laptop)\s+(?:me|mein|pe|par)\s+kar\s+raha\s+h(?:oon|u|un)|jo\s+mai(?:n)?\s+abhi\s+kar\s+raha\s+h(?:oon|u|un)|watch\s+what\s+i\s+(?:do|am\s+doing)(?:\s+on\s+(?:my\s+)?(?:pc|computer))?)\s*(?:,|\s+aur|\s+and|\s+to)?\s*(?:us[ek]o?\s+|unhe\s+|use\s+|it\s+|wo\s+|woh\s+|sab\s+)?(?:\+?\/?([a-zA-Z][a-zA-Z0-9_-]{1,27})\s+naam\s+se\s+)?(?:record\s+kar(?:o|\s*lo|\s*do|\s*le)?|seekh\s*l(?:o|e)|learn\s+it|observe\s+karo)(?:\s+aur\s+seekh(?:\s*lo|\s*o|\s*le)?)?$/i))
  ) {
    if (/\b(?:record|recording|watch|seekh|learn|observe)\b/i.test(text) && !/^\d+\s*second\s+screen\s+record/i.test(text)) {
      return { action: 'start', name: learn.normalizeKeyword(m[1] || '') };
    }
  }

  // ── 2. STOP / FINISH recording ───────────────────────────────────────────
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
  if (
    (m = text.match(/^(?:repeat|replay|redo)\s+(?:my\s+|the\s+)?(?:last\s+|recorded\s+)?(?:pc\s+|computer\s+)?(?:actions?|steps?|clicks?|recording|what\s+i\s+(?:just\s+)?did)(?:\s+(\d+)\s*(?:times?|baar))?$/i))
  ) {
    return { action: 'replay', name: '', times: Number(m[1] || 1) };
  }
  if (
    (m = text.match(/^(?:mere\s+|meri\s+)?(?:recorded\s+|pichle\s+|last\s+)?(?:pc\s+|computer\s+)?(?:actions?|steps?|clicks?|kaam)\s+(?:ko\s+)?(?:(\d+)\s*baar\s+)?(?:repeat|replay|dobara)(?:\s+kar(?:o|\s*do|\s*na)?)?(?:\s+(\d+)\s*(?:baar|times?))?$/i))
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
