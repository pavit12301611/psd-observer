// grounding.js — Agent-S Deterministic Desktop Grounding & ACI Engine for PSD_Ai.
//
// Modelled on Simular's Agent-S (gui_agents/s3/agents/grounding.py,
// code_agent.py, procedural_memory.py):
//   1. Direct OS / CLI / URL / DBus execution BEFORE GUI coordinate guessing.
//   2. Linux AT-SPI Accessibility Tree inspection (`gi.repository.Atspi`) +
//      `wmctrl`/`xdotool` window geometry for 100% exact widget bounding boxes.
//   3. Phrase-aligned OCR grounding (`start` | `center` | `end` alignment,
//      like Agent-S `generate_text_coords`).
//   4. Set-of-Marks (SoM) visual badge + coordinate ruler overlay on screenshots
//      so vision models pick a numbered element `mark` ID instead of guessing (x,y).
//   5. Post-action desktop state verification & cycle reflection.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pc from './pccontrol.js';
import { levenshtein } from './elementfinder.js';
import { screenChanged } from './imaging.js';
import { youtubeSearch } from './reach.js';

const execFileAsync = promisify(execFile);

const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const compact = (s) => normalize(s).replace(/ /g, '');

// Strip trailing generic UI role words ("the login button" → "login")
const ROLE_SUFFIX_RE = /\b(?:button|btn|link|tab|field|box|input|icon|menu|item|option|checkbox|toggle|bar)\b/gi;
const stripRoleWords = (s) => normalize(String(s ?? '').replace(ROLE_SUFFIX_RE, ' '));

// ── 1. Linux AT-SPI Accessibility Tree & Window Inspector ───────────────────

const ATSPI_PYTHON_SCRIPT = `
import json, sys
try:
    import gi
    gi.require_version('Atspi', '2.0')
    from gi.repository import Atspi
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(0)

INTERACTIVE_ROLES = {
    "push button", "button", "toggle button", "check box", "radio button",
    "menu item", "menu", "page tab", "entry", "text", "password text",
    "combo box", "link", "icon", "list item", "spin button", "slider",
    "search box", "tool bar", "heading"
}

results = []
active_win = None

def walk(node, depth=0):
    if not node or depth > 11 or len(results) >= 120:
        return
    try:
        state = node.get_state_set()
        if not state.contains(Atspi.StateType.SHOWING) and not state.contains(Atspi.StateType.VISIBLE):
            return
        role = (node.get_role_name() or "").lower()
        name = (node.get_name() or "").strip()
        desc = (node.get_description() or "").strip()
        focused = state.contains(Atspi.StateType.FOCUSED)
        comp = node.get_component_iface()
        rect = comp.get_extents(Atspi.CoordType.SCREEN) if comp else None
        if rect and rect.width > 4 and rect.height > 4 and rect.x >= 0 and rect.y >= 0:
            if (role in INTERACTIVE_ROLES and (name or desc or focused)) or (name and len(name) <= 80 and rect.height <= 120):
                results.append({
                    "role": role,
                    "name": name[:80],
                    "description": desc[:80],
                    "left": int(rect.x),
                    "top": int(rect.y),
                    "width": int(rect.width),
                    "height": int(rect.height),
                    "x": int(rect.x + rect.width / 2),
                    "y": int(rect.y + rect.height / 2),
                    "focused": bool(focused),
                })
        count = min(node.get_child_count(), 60)
        for i in range(count):
            walk(node.get_child_at_index(i), depth + 1)
    except Exception:
        pass

try:
    desktop = Atspi.get_desktop(0)
    app_count = desktop.get_child_count()
    for a in range(app_count):
        app = desktop.get_child_at_index(a)
        if not app:
            continue
        for w in range(app.get_child_count()):
            win = app.get_child_at_index(w)
            if not win:
                continue
            st = win.get_state_set()
            if st.contains(Atspi.StateType.ACTIVE):
                active_win = {
                    "app": (app.get_name() or "").strip(),
                    "title": (win.get_name() or "").strip(),
                }
                walk(win, 0)
                break
        if active_win:
            break
    print(json.dumps({"ok": True, "window": active_win, "elements": results}))
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
`.trim();

/** Inspect the active window & live AT-SPI accessibility widgets on the Linux desktop. */
export async function inspectDesktopElements({ timeoutMs = 2500 } = {}) {
  const env = pc.displayEnv();
  let windowInfo = null;
  let elements = [];

  // 1. Try fast AT-SPI inspection via python3
  try {
    const { stdout } = await execFileAsync('python3', ['-c', ATSPI_PYTHON_SCRIPT], {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env,
    });
    const parsed = JSON.parse(stdout.trim());
    if (parsed?.ok && Array.isArray(parsed.elements)) {
      windowInfo = parsed.window || null;
      elements = parsed.elements.map((el, idx) => ({ ...el, id: idx }));
    }
  } catch { /* python3-atspi not installed or headless */ }

  // 2. Supplement active window title/geometry via xdotool / wmctrl if needed
  if (!windowInfo?.title) {
    try {
      const { stdout: idOut } = await execFileAsync('xdotool', ['getactivewindow'], { timeout: 1200, env });
      const winId = idOut.trim();
      if (winId) {
        const [{ stdout: nameOut }, { stdout: geomOut }] = await Promise.all([
          execFileAsync('xdotool', ['getwindowname', winId], { timeout: 1200, env }).catch(() => ({ stdout: '' })),
          execFileAsync('xdotool', ['getwindowgeometry', '--shell', winId], { timeout: 1200, env }).catch(() => ({ stdout: '' })),
        ]);
        const geom = {};
        for (const line of String(geomOut).split('\n')) {
          const [k, v] = line.split('=');
          if (k && v !== undefined) geom[k.trim()] = Number(v.trim());
        }
        windowInfo = {
          id: winId,
          title: String(nameOut).trim(),
          left: geom.X ?? 0,
          top: geom.Y ?? 0,
          width: geom.WIDTH ?? 0,
          height: geom.HEIGHT ?? 0,
        };
      }
    } catch { /* xdotool unavailable or Wayland without XWayland window */ }
  }

  return {
    ok: Boolean(elements.length > 0 || windowInfo?.title),
    window: windowInfo,
    elements,
  };
}

/** Score an AT-SPI accessibility widget against a target label/description. */
export function scoreAccessibilityElement(el, query) {
  const qNorm = normalize(query);
  const qCore = stripRoleWords(query) || qNorm;
  const label = normalize(el.name || el.description || '');
  const role = normalize(el.role || '');
  if (!label || !qCore) return 0;

  let score = 0;
  if (label === qNorm || label === qCore) score = 1.0;
  else if (compact(label) === compact(qCore)) score = 0.98;
  else if (label.includes(qCore) && qCore.length >= 2) score = 0.9;
  else if (qCore.includes(label) && label.length >= 3) score = 0.82;
  else {
    const sim = 1 - levenshtein(compact(label), compact(qCore)) / Math.max(compact(label).length, compact(qCore).length, 1);
    if (sim >= 0.72) score = sim * 0.85;
  }

  // Boost interactive controls when query mentions button/input/search/etc.
  if (score > 0 && /button|link|entry|text|tab|menu|check|search/.test(role)) {
    score = Math.min(1, score + 0.04);
  }
  return score;
}

/** Find the best matching widget in an AT-SPI element list. */
export function findElementInTree(elements, query) {
  if (!Array.isArray(elements) || !elements.length || !query) return null;
  let best = null;
  for (const el of elements) {
    const score = scoreAccessibilityElement(el, query);
    if (score >= 0.65 && (!best || score > best.score)) {
      best = {
        score,
        matched: el.name || el.description,
        role: el.role || 'widget',
        confidence: Math.round(score * 100),
        box: { left: el.left, top: el.top, width: el.width, height: el.height },
        x: el.x,
        y: el.y,
        source: 'atspi',
      };
    }
  }
  return best;
}

// ── 2. Agent-S Phrase-Aligned OCR Grounding (`start` | `center` | `end`) ────

/**
 * Given a target `hit` (from `findTextTarget` or `findElementInTree`), compute
 * exact coordinates for `alignment` ('center' | 'start' | 'end'), matching
 * Agent-S `generate_text_coords`.
 */
export function alignTargetCoords(hit, alignment = 'center') {
  if (!hit?.box) return hit ? { x: hit.x, y: hit.y } : null;
  const { left, top, width, height } = hit.box;
  const cy = Math.round(top + height / 2);
  const mode = String(alignment ?? 'center').toLowerCase();
  if (mode === 'start' || mode === 'left') {
    return { x: Math.round(left + Math.min(6, width / 4)), y: cy };
  }
  if (mode === 'end' || mode === 'right') {
    return { x: Math.round(left + width - Math.min(6, width / 4)), y: cy };
  }
  return { x: Math.round(left + width / 2), y: cy };
}

// ── 3. Set-of-Marks (SoM) Visual Grounding & Screenshot Annotation ──────────

/**
 * Combine AT-SPI interactive widgets + OCR word boxes into a unified,
 * deduplicated Set-of-Marks (`marks`) array so every clickable element on the
 * screen has a deterministic integer `mark` ID.
 */
export function buildSetOfMarks({ atspiElements = [], ocrWords = [], size = { width: 1920, height: 1080 }, maxMarks = 80 } = {}) {
  const marks = [];
  const nearExisting = (x, y) => marks.some((m) => Math.hypot(m.x - x, m.y - y) < 18);

  // 1. Add AT-SPI accessibility widgets first (highest fidelity)
  for (const el of atspiElements) {
    if (marks.length >= maxMarks) break;
    const label = String(el.name || el.description || '').trim();
    if (!label && !el.focused) continue;
    if (nearExisting(el.x, el.y)) continue;
    marks.push({
      mark: marks.length,
      source: 'atspi',
      role: el.role || 'widget',
      text: label || `(${el.role || 'focused'})`,
      left: el.left,
      top: el.top,
      width: el.width,
      height: el.height,
      x: el.x,
      y: el.y,
      relX: size?.width ? Math.round((el.x / size.width) * 1000) : 0,
      relY: size?.height ? Math.round((el.y / size.height) * 1000) : 0,
    });
  }

  // 2. Add OCR words that are not already covered by an AT-SPI mark
  for (const w of ocrWords) {
    if (marks.length >= maxMarks) break;
    const text = String(w.text ?? '').trim();
    if (text.length < 2) continue;
    const cx = Math.round(w.left + w.width / 2);
    const cy = Math.round(w.top + w.height / 2);
    if (nearExisting(cx, cy)) continue;
    marks.push({
      mark: marks.length,
      wordId: w.id,
      source: 'ocr',
      role: 'text',
      text: text.slice(0, 40),
      left: w.left,
      top: w.top,
      width: w.width,
      height: w.height,
      x: cx,
      y: cy,
      relX: size?.width ? Math.round((cx / size.width) * 1000) : 0,
      relY: size?.height ? Math.round((cy / size.height) * 1000) : 0,
    });
  }

  return marks;
}

/**
 * Draw Set-of-Marks (`#0`, `#1`, ...) badges + a 0..1000 coordinate ruler grid
 * on a screenshot PNG so vision models can see exact element IDs & grid lines.
 */
export async function annotateSetOfMarks(pngBuffer, marks = [], size = null) {
  if (!Buffer.isBuffer(pngBuffer) || !size?.width || !size?.height) return pngBuffer;
  try {
    const sharp = (await import('sharp')).default;
    const { width, height } = size;

    // Subtle 10% ruler ticks along top and left edges (100, 200, ... 900)
    const gridLines = [];
    for (let pct = 100; pct <= 900; pct += 100) {
      const gx = Math.round((pct / 1000) * width);
      const gy = Math.round((pct / 1000) * height);
      gridLines.push(
        `<line x1="${gx}" y1="0" x2="${gx}" y2="${height}" stroke="rgba(0,220,255,0.16)" stroke-width="1" stroke-dasharray="4,6"/>`,
        `<text x="${gx + 3}" y="13" fill="#00e5ff" font-family="monospace" font-size="11" font-weight="bold">${pct}</text>`,
        `<line x1="0" y1="${gy}" x2="${width}" y2="${gy}" stroke="rgba(0,220,255,0.16)" stroke-width="1" stroke-dasharray="4,6"/>`,
        `<text x="3" y="${gy - 3}" fill="#00e5ff" font-family="monospace" font-size="11" font-weight="bold">${pct}</text>`,
      );
    }

    const badgeSvgs = marks.slice(0, 60).map((m) => {
      const bx = Math.max(2, Math.min(width - 34, m.left));
      const by = Math.max(14, Math.min(height - 4, m.top));
      const color = m.source === 'atspi' ? '#ff1744' : '#ff9100';
      const label = String(m.mark);
      const pillW = Math.max(18, label.length * 8 + 8);
      return [
        `<rect x="${m.left}" y="${m.top}" width="${Math.max(8, m.width)}" height="${Math.max(8, m.height)}" fill="none" stroke="${color}" stroke-width="1.5"/>`,
        `<rect x="${bx}" y="${by - 14}" width="${pillW}" height="15" rx="3" fill="${color}"/>`,
        `<text x="${bx + 4}" y="${by - 3}" fill="#ffffff" font-family="monospace" font-size="11" font-weight="bold">${label}</text>`,
      ].join('');
    });

    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${gridLines.join('')}${badgeSvgs.join('')}</svg>`;
    return await sharp(pngBuffer)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .png()
      .toBuffer();
  } catch {
    return pngBuffer;
  }
}

// ── 4. Post-Action Desktop State Verification & Reflection ──────────────────

/** Capture a lightweight desktop state snapshot before/after an action. */
export async function captureDesktopState({ signature = null } = {}) {
  const inspected = await inspectDesktopElements({ timeoutMs: 1800 }).catch(() => ({ ok: false, window: null, elements: [] }));
  const focused = inspected.elements?.find((e) => e.focused) || null;
  return {
    windowTitle: inspected.window?.title || '',
    windowApp: inspected.window?.app || '',
    focusedElement: focused ? `${focused.role}:${focused.name || focused.description || ''}` : '',
    elementCount: inspected.elements?.length ?? 0,
    signature,
    ts: Date.now(),
  };
}

/**
 * Compare `before` and `after` desktop states (screen pixels + active window
 * title + focused accessibility widget) and return an honest verification verdict.
 */
export function verifyStateTransition(before, after, action = {}) {
  const pixelDiff = (before?.signature && after?.signature)
    ? screenChanged(before.signature, after.signature)
    : { changed: null, similarity: null };

  const titleChanged = Boolean(
    before?.windowTitle && after?.windowTitle && before.windowTitle !== after.windowTitle,
  );
  const focusChanged = Boolean(
    before?.focusedElement !== after?.focusedElement && (before?.focusedElement || after?.focusedElement),
  );

  const changed = pixelDiff.changed === true || titleChanged || focusChanged;
  const notes = [];
  if (titleChanged) notes.push(`window → "${after.windowTitle.slice(0, 45)}"`);
  if (focusChanged && after?.focusedElement) notes.push(`focus → ${after.focusedElement.slice(0, 40)}`);
  if (pixelDiff.changed === true) notes.push('screen updated');
  if (changed === false && pixelDiff.changed === false) {
    notes.push(
      `No screen/focus change after ${action?.action || 'action'}. Avoid repeating this exact click; use keyboard shortcut (e.g. ctrl+l, tab, enter, escape) or a different target.`,
    );
  }

  return {
    changed: pixelDiff.changed === null && !titleChanged && !focusChanged ? null : changed,
    pixelChanged: pixelDiff.changed,
    titleChanged,
    focusChanged,
    note: notes.join(' · '),
  };
}

// ── 5. Agent-S Direct Action Bypass (Zero-Guesswork Fast Path) ──────────────

/**
 * Check if a GUI task ("youtube pe lofi music chalao", "google pe X search karo")
 * can be completed deterministically via direct URL/CLI resolution rather than
 * opening a blank page and guessing where to click.
 */
export async function tryDirectDesktopAction(task, { openUrl = pc.openTarget, fetchImpl = fetch } = {}) {
  const raw = String(task ?? '').trim();
  if (!raw) return null;

  // 1. Direct YouTube video play: "youtube pe <query> play/chala/chalao/lagao" or "play <query> on youtube"
  const ytPlayMatch = raw.match(/^(?:youtube\s+(?:pe|par|me|on)\s+(.+?)\s+(?:play|chala|chalao|chala\s+do|lagao|laga\s+do|sunao)|(?:play|chala|chalao)\s+(.+?)\s+(?:on|in|pe|par)\s+youtube)$/i);
  if (ytPlayMatch) {
    const query = (ytPlayMatch[1] || ytPlayMatch[2] || '').trim();
    if (query && !/^(?:video|first|pehla|second|button)$/i.test(query)) {
      const search = await youtubeSearch(query, { limit: 1, timeoutMs: 10_000, fetchImpl }).catch(() => null);
      const top = search?.videos?.[0];
      if (top?.url) {
        await openUrl(top.url);
        return {
          ok: true,
          direct: true,
          kind: 'youtube_play',
          title: top.title,
          url: top.url,
          backend: search.backend,
          text: `🎬 *YouTube Direct Play (Agent-Reach × Agent-S)*\n▶️ *${top.title}*\n🔗 ${top.url}\n_Opened exact video URL directly in browser — zero blind clicking!_`,
        };
      }
    }
  }

  return null;
}
