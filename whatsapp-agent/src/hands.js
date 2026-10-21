// hands.js — actual hands: a computer-use loop that drives the desktop the way
// a person does (look at the screen → do one thing → look again).
//
// Modelled on Simular's Agent-S (the zip the owner dropped in the repo):
//   • one action per turn, never a burst of blind clicks
//   • the model must say what it expects, then we look again next step
//   • text targets are grounded to an on-screen word id (exact pixels), and
//     only falling back to model-supplied coordinates for icons/images
//   • a repeated action that changes nothing is treated as a stuck loop
//
// What this file is NOT: it never runs shell commands and never invents results.
// Every line in the reply comes from an action that actually ran on the PC.
//
// Model flow per step:
//   screenshot → (OCR words, local) → vision model picks ONE action as JSON →
//   we execute it with pccontrol (xdotool / ydotool / wtype) → next step.

import * as pc from './pccontrol.js';
import * as ai from './ai.js';
import * as apps from './apps.js';
import { findTextTarget, pngSize, ocrScreenshot } from './elementfinder.js';
import { imageSignature, screenChanged } from './imaging.js';
import { StoppedError, throwIfStopped, sleepWith } from './cancel.js';
import {
  inspectDesktopElements,
  findElementInTree,
  alignTargetCoords,
  buildSetOfMarks,
  annotateSetOfMarks,
} from './grounding.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every action the model is allowed to ask for. Anything else is rejected. */
export const HANDS_ACTIONS = new Set([
  'click', 'double_click', 'right_click', 'type', 'key', 'scroll',
  'drag', 'move', 'wait', 'open', 'focus', 'done', 'fail',
]);

const CLICK_ACTIONS = new Set(['click', 'double_click', 'right_click']);

// ── parsing ───────────────────────────────────────────────────────────────────

/** First balanced {...} block in a string (models love to wrap JSON in prose). */
export function firstJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 0..1 fractions and 0..1000 integers both mean "relative to the screen".
 * Anything else (a real pixel coordinate, a negative number, NaN) is rejected
 * so a confused model can never click at a random place.
 */
export function normalizePoint(x, y) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) return null;
  if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) return { x: Math.round(nx * 1000), y: Math.round(ny * 1000) };
  if (nx < 0 || ny < 0 || nx > 1000 || ny > 1000) return null;
  return { x: Math.round(nx), y: Math.round(ny) };
}

/** Relative (0..1000) → real pixels for the screenshot we just took. */
export function scalePoint(point, size) {
  if (!point || !size?.width || !size?.height) return null;
  return {
    x: Math.min(size.width - 1, Math.max(0, Math.round((point.x / 1000) * size.width))),
    y: Math.min(size.height - 1, Math.max(0, Math.round((point.y / 1000) * size.height))),
  };
}

const num = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Turn a model reply into a validated action.
 * Returns { ok:true, action } or { ok:false, error } — never guesses.
 */
export function parseHandsAction(raw) {
  const json = firstJsonObject(raw);
  if (!json) return { ok: false, error: 'reply me JSON object nahi mila' };
  let data;
  try {
    data = JSON.parse(json);
  } catch (err) {
    return { ok: false, error: `JSON parse fail: ${err.message}` };
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'JSON object nahi hai' };

  // Accept {"action":"click",…}, {"action":{"type":"click",…}} and {"type":"click",…}.
  let name = data.action;
  let body = data;
  if (name && typeof name === 'object') {
    body = { ...data, ...name };
    name = name.type ?? name.action ?? name.name;
  }
  if (!name) name = data.type ?? data.name;
  name = String(name ?? '').trim().toLowerCase();
  if (name === 'hotkey' || name === 'shortcut') name = 'key';
  if (!HANDS_ACTIONS.has(name)) return { ok: false, error: `unknown action "${name || '(missing)'}"` };

  const action = { action: name };
  const thought = String(body.thought ?? data.thought ?? '').trim();
  if (thought) action.thought = thought.slice(0, 300);

  if (CLICK_ACTIONS.has(name)) {
    if (body.mark != null && Number.isFinite(Number(body.mark))) action.mark = Math.trunc(Number(body.mark));
    if (body.word != null && Number.isFinite(Number(body.word))) action.word = Math.trunc(Number(body.word));
    const point = normalizePoint(body.x, body.y);
    if (point) Object.assign(action, point);
    const target = String(body.target ?? body.element ?? '').trim();
    if (target) action.target = target.slice(0, 120);
    if (body.align || body.alignment) {
      const al = String(body.align ?? body.alignment).toLowerCase();
      if (['start', 'center', 'end', 'left', 'right'].includes(al)) action.align = al;
    }
    if (body.button && ['left', 'right', 'middle'].includes(String(body.button).toLowerCase())) {
      action.button = String(body.button).toLowerCase();
    }
    if (action.mark == null && action.word == null && action.x == null && !action.target) {
      return { ok: false, error: `${name} ke liye word id, x/y, ya target chahiye` };
    }
    return { ok: true, action };
  }

  if (name === 'type') {
    const text = String(body.text ?? body.content ?? '');
    if (!text) return { ok: false, error: 'type ke liye text chahiye' };
    action.text = text.slice(0, 2000);
    action.submit = Boolean(body.submit ?? body.enter);
    if (body.overwrite != null) action.overwrite = Boolean(body.overwrite);
    const target = String(body.target ?? body.element ?? '').trim();
    if (target) action.target = target.slice(0, 120);
    return { ok: true, action };
  }

  if (name === 'key') {
    const keys = String(body.keys ?? body.combo ?? body.key ?? '').trim();
    if (!keys) return { ok: false, error: 'key ke liye keys chahiye (e.g. "ctrl+l")' };
    action.keys = keys.slice(0, 60);
    return { ok: true, action };
  }

  if (name === 'scroll') {
    const direction = String(body.direction ?? body.dir ?? 'down').toLowerCase();
    action.direction = ['up', 'down'].includes(direction) ? direction : 'down';
    action.amount = Math.min(Math.max(Math.trunc(num(body.amount ?? body.clicks ?? 3) ?? 3), 1), 25);
    return { ok: true, action };
  }

  if (name === 'drag') {
    const from = normalizePoint(body.x1 ?? body.from_x, body.y1 ?? body.from_y);
    const to = normalizePoint(body.x2 ?? body.to_x, body.y2 ?? body.to_y);
    if (!from || !to) return { ok: false, error: 'drag ke liye x1,y1 aur x2,y2 (0-1000) chahiye' };
    Object.assign(action, { x1: from.x, y1: from.y, x2: to.x, y2: to.y });
    return { ok: true, action };
  }

  if (name === 'move') {
    const point = normalizePoint(body.x, body.y);
    if (!point) return { ok: false, error: 'move ke liye x aur y (0-1000) chahiye' };
    Object.assign(action, point);
    return { ok: true, action };
  }

  if (name === 'wait') {
    action.ms = Math.min(Math.max(Math.trunc(num(body.ms ?? body.time ?? 1000) ?? 1000), 100), 10_000);
    return { ok: true, action };
  }

  if (name === 'open') {
    const target = String(body.target ?? body.app ?? body.url ?? '').trim();
    if (!target) return { ok: false, error: 'open ke liye target (app naam ya URL) chahiye' };
    action.target = target.slice(0, 300);
    return { ok: true, action };
  }

  if (name === 'focus') {
    const title = String(body.target ?? body.title ?? '').trim();
    if (!title) return { ok: false, error: 'focus ke liye target (window title ka hissa) chahiye' };
    action.target = title.slice(0, 120);
    return { ok: true, action };
  }

  if (name === 'done') {
    action.answer = String(body.answer ?? body.result ?? body.text ?? '').trim().slice(0, 1500);
    return { ok: true, action };
  }

  // fail
  action.reason = String(body.reason ?? body.answer ?? 'model ne kaha kaam nahi ho sakta').trim().slice(0, 400);
  return { ok: true, action };
}

/** Short human line for the reply/log, no coordinate noise. */
export function summarizeAction(action) {
  if (!action) return '(none)';
  const clip = (s, n) => {
    const v = String(s ?? '').replace(/\s+/g, ' ').trim();
    return v.length > n ? `${v.slice(0, n)}…` : v;
  };
  switch (action.action) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      const verb = action.action === 'click' ? 'click' : action.action === 'double_click' ? 'double-click' : 'right-click';
      const aim = action.target
        ? `"${clip(action.target, 42)}"`
        : action.mark != null
        ? `mark #${action.mark}`
        : action.word != null
        ? `word ${action.word}`
        : `${action.x ?? '?'},${action.y ?? '?'}`;
      return `${verb} ${aim}`;
    }
    case 'type': return `type "${clip(action.text, 40)}"${action.submit ? ' + Enter' : ''}`;
    case 'key': return `key ${action.keys}`;
    case 'scroll': return `scroll ${action.direction} ${action.amount}`;
    case 'drag': return `drag ${action.x1},${action.y1} → ${action.x2},${action.y2}`;
    case 'move': return `move ${action.x},${action.y}`;
    case 'wait': return `wait ${action.ms}ms`;
    case 'open': return `open "${clip(action.target, 40)}"`;
    case 'focus': return `focus "${clip(action.target, 40)}"`;
    case 'done': return 'done';
    default: return action.action;
  }
}

/** Identical action + identical screen = stuck. Used for cycle detection. */
export function actionSignature(action) {
  return [
    action?.action, action?.mark ?? '', action?.word ?? '', action?.x ?? '', action?.y ?? '', action?.target ?? '',
    action?.text ?? '', action?.keys ?? '', action?.direction ?? '', action?.amount ?? '',
    action?.x1 ?? '', action?.y1 ?? '', action?.x2 ?? '', action?.y2 ?? '',
  ].join('|');
}

// ── prompt ────────────────────────────────────────────────────────────────────

const MAX_WORDS = 140;

/**
 * The model's whole world for one step: the task, the rules, the text it can
 * aim at, and what already happened. Kept deliberately short — free vision
 * models get worse as prompts grow.
 */
export function buildHandsPrompt({ task, step, maxSteps, size, words = [], atspi = [], windowInfo = null, history = [], lastResult = '', lastChange = null, visionFirst = true }) {
  const relevant = words
    .filter((w) => String(w.text ?? '').trim().length >= 2)
    .slice(0, MAX_WORDS);
  const table = relevant.map((w) => {
    const x = Math.round(((w.left + w.width / 2) / (size?.width || 1)) * 1000);
    const y = Math.round(((w.top + w.height / 2) / (size?.height || 1)) * 1000);
    return `${w.id} | ${String(w.text).replace(/\s+/g, ' ').slice(0, 40)} | ${x},${y}`;
  }).join('\n');

  const uiTreeTable = (atspi || [])
    .filter((el) => String(el.name || el.description || '').trim().length >= 1)
    .slice(0, 50)
    .map((el) => {
      const rx = Math.round((el.x / (size?.width || 1)) * 1000);
      const ry = Math.round((el.y / (size?.height || 1)) * 1000);
      const label = String(el.name || el.description).replace(/\s+/g, ' ').slice(0, 40);
      return `[${el.role}] "${label}" @ ${rx},${ry}${el.focused ? ' (FOCUSED)' : ''}`;
    })
    .join('\n');

  const hist = history.slice(-6)
    .map((h) => `${h.step}. ${h.summary} → ${h.detail}${h.changed === true ? ' · screen changed' : h.changed === false ? ' · screen NOT changed (do not repeat this blindly)' : ''}`)
    .join('\n');

  return [
    'You are the "hands" of Observer, an agent controlling a Fedora Linux desktop with a real mouse and keyboard.',
    `TASK: ${task}`,
    `STEP: ${step} of ${maxSteps} (one action per step)`,
    `SCREEN: ${size?.width ?? 0}x${size?.height ?? 0} pixels (the screenshot may be scaled — your coordinates are relative)`,
    windowInfo?.title ? `ACTIVE WINDOW: "${windowInfo.title}"${windowInfo.app ? ` (${windowInfo.app})` : ''}` : '',
    '',
    'RULES',
    '1. Reply with ONE JSON object and nothing else. No markdown, no explanation outside the JSON.',
    ...(visionFirst ? [
      '2. Look at the screenshot yourself (no text extraction happens). Click exactly where you see the thing:',
      '   {"action":"click","target":"Search box","x":500,"y":120} — target is your one-line description, x/y is where it is.',
      '3. If the element has visible text you can read, the target text alone is enough: {"action":"click","target":"Sign in"}.',
      '   It is snapped to the exact OS accessibility widget (AT-SPI) or OCR pixels of that word when possible, so prefer it for text buttons.',
      '4. x and y are 0-1000 relative to the screen (0=left/top, 500=middle, 1000=right/bottom). Estimate carefully from the image.',
    ] : [
      '2. Prefer a text target id from the TEXT LIST — it is pixel-exact: {"action":"click","word":42}.',
      '3. For icons or images that are not text: {"action":"click","target":"blue Send arrow","x":870,"y":940}.',
      '4. x and y are 0-1000 relative to the screen (0=left/top, 1000=right/bottom).',
    ]),
    '5. Use the keyboard when it is shorter and safer: {"action":"key","keys":"ctrl+l"} for the address bar, {"action":"key","keys":"enter"} to submit.',
    '6. To type into the field that is already focused: {"action":"type","text":"...","submit":true}. Click the field first if it is not focused.',
    '7. Never repeat an action that just failed or changed nothing — choose another way (scroll, keyboard, a different word).',
    '8. Never type passwords, OTPs, card numbers or recovery codes. Never click Delete / Uninstall / Format / Log out unless the TASK explicitly says so.',
    '9. When the TASK is complete: {"action":"done","answer":"short answer for the owner (what they asked for)"}.',
    '10. If it truly cannot be done: {"action":"fail","reason":"one line why"}.',
    '',
    uiTreeTable ? `ACCESSIBILITY WIDGETS (exact OS coordinates):\n${uiTreeTable}` : '',
    table ? `TEXT LIST (id | text | x,y):\n${table}` : 'TEXT LIST: (OCR found no text — use coordinates)',
    '',
    hist ? `HISTORY:\n${hist}` : 'HISTORY: (nothing yet)',
    lastResult ? `LAST RESULT: ${lastResult}${lastChange === false ? ' — the screen did NOT change, so this action had no effect.' : ''}` : '',
    '',
    'Reply with ONE JSON action now.',
  ].filter((line) => line !== '').join('\n');
}

// ── screen work ───────────────────────────────────────────────────────────────

/**
 * Screenshot + size + AT-SPI accessibility widgets + OCR words + a cheap signature (for change detection).
 * OCR is local and free; when tesseract is missing we simply lose the word list.
 */
export async function observeScreen(config, log = console, { useOcr = false, signal } = {}) {
  throwIfStopped(signal);
  // A loop takes up to 8 screenshots: one stuck portal dialog must not eat the
  // whole run, so each capture gets at most 25s (PORTAL_TIMEOUT_MS still wins
  // when it is smaller).
  const cap = Math.min(Number(config?.portalTimeoutMs ?? 60_000) || 60_000, 25_000);
  const [image, desktop] = await Promise.all([
    pc.captureScreenshot({ portalTimeoutMs: cap }),
    inspectDesktopElements({ timeoutMs: 1800 }).catch(() => ({ ok: false, window: null, elements: [] })),
  ]);
  const size = pngSize(image) ?? { width: 0, height: 0 };
  let words = [];
  // Vision-first (default): the model reads the screenshot itself. tesseract is
  // slow and only earns its keep when we need to snap a named target to exact
  // pixels — that happens lazily in resolveTarget(), not here.
  if (useOcr) {
    try {
      words = await ocrScreenshot(image);
    } catch (err) {
      if (err.code !== 'ENOENT') log?.info?.(`[hands] OCR skipped: ${err.message}`);
    }
  }
  // Re-number so the ids in the prompt match this array exactly: a stale id
  // must never end up clicking a random word.
  words = words.map((w, i) => ({ ...w, id: i }));
  const atspi = desktop?.elements ?? [];
  const marks = buildSetOfMarks({ atspiElements: atspi, ocrWords: words, size });
  return {
    image,
    size,
    words,
    atspi,
    windowInfo: desktop?.window ?? null,
    marks,
    signature: imageSignature(image),
  };
}

/** OCR words for a screenshot we already have (no second capture). */
export async function wordsForShot(shot, log = console) {
  if (shot?.words?.length) return shot.words;
  if (shot?._ocrWords) return shot._ocrWords;
  if (!shot?.image) return [];
  try {
    shot._ocrWords = (await ocrScreenshot(shot.image)).map((w, i) => ({ ...w, id: i }));
  } catch (err) {
    if (err.code !== 'ENOENT') log?.info?.(`[hands] OCR skipped: ${err.message}`);
    shot._ocrWords = [];
  }
  return shot._ocrWords;
}

/** Shrink screenshots for free-tier image limits (best effort; original on failure). */
export async function shrinkForModel(image, maxWidth = 1024, quality = 70) {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(image).metadata();
    if (!meta.width || meta.width <= maxWidth) return { image, mime: 'image/png' };
    // Smaller + JPEG = fewer vision tokens, faster upload, faster answer. At
    // 1024px a 1440p screen keeps every label readable.
    const out = await sharp(image).resize({ width: maxWidth }).jpeg({ quality }).toBuffer();
    return { image: out, mime: 'image/jpeg' };
  } catch {
    return { image, mime: 'image/png' };
  }
}

// ── execution ─────────────────────────────────────────────────────────────────

function parseVisionPointLoose(text) {
  const m = String(text ?? '').match(/\{\s*"x"\s*:\s*([\d.]+)[^}]*"y"\s*:\s*([\d.]+)/)
    ?? String(text ?? '').match(/([\d.]+)\s*,\s*([\d.]+)/);
  if (!m) return null;
  return normalizePoint(Number(m[1]), Number(m[2]));
}

/**
 * Resolve where a click should land (Agent-S Multi-Layer Grounding):
 *   0. mark id → Set-of-Marks exact bounding box
 *   1. word id → OCR box (exact)
 *   2. target → AT-SPI widget tree (exact) → OCR phrase (`start`/`center`/`end`) → x,y → local vision
 *   3. x,y → scaled
 */
export async function resolveTarget(action, ctx) {
  const { size, config, log } = ctx;
  let words = ctx.words ?? [];
  const atspi = ctx.atspi ?? [];
  const marks = ctx.marks ?? [];

  // 0. Set-of-Marks (SoM) mark id
  if (action.mark != null) {
    const m = marks.find((item) => item.mark === action.mark);
    if (!m) return { error: `mark #${action.mark} screen pe nahi mila` };
    return {
      x: m.x,
      y: m.y,
      how: `${m.source === 'atspi' ? 'AT-SPI' : 'SoM'} #${m.mark} "${m.text}"`,
    };
  }

  // 1. A word id from a prompt WITH a text list is already pixel-exact.
  if (action.word != null) {
    const word = words.find((w) => w.id === action.word);
    if (!word) return { error: `word id ${action.word} screen pe nahi mila` };
    const box = { left: word.left, top: word.top, width: word.width, height: word.height };
    const aligned = action.align ? alignTargetCoords({ box, x: Math.round(word.left + word.width / 2), y: Math.round(word.top + word.height / 2) }, action.align) : null;
    return {
      x: aligned ? aligned.x : Math.round(word.left + word.width / 2),
      y: aligned ? aligned.y : Math.round(word.top + word.height / 2),
      how: `OCR "${word.text}"`,
    };
  }

  // 2. Named target: check AT-SPI accessibility tree FIRST, then OCR phrase, then coordinates / local vision.
  if (action.target) {
    if (atspi.length) {
      const atspiHit = findElementInTree(atspi, action.target);
      if (atspiHit) {
        const coords = action.align ? alignTargetCoords(atspiHit, action.align) : { x: atspiHit.x, y: atspiHit.y };
        return { x: coords.x, y: coords.y, how: `AT-SPI [${atspiHit.role}] "${atspiHit.matched}"` };
      }
    }
    if (!words.length && ctx.ensureWords) {
      try { words = await ctx.ensureWords(); } catch { words = []; }
    }
    const hit = words.length ? findTextTarget(words, action.target) : null;
    if (hit) {
      const coords = action.align ? alignTargetCoords(hit, action.align) : { x: hit.x, y: hit.y };
      return { x: coords.x, y: coords.y, how: `OCR "${hit.matched}"` };
    }
    if (action.x != null && action.y != null) {
      const point = scalePoint({ x: action.x, y: action.y }, size);
      if (point) return { ...point, how: `vision (${action.target})` };
    }
    const raw = await ai.locateInImage(config, ctx.imageBase64, action.target, log);
    const rel = raw ? parseVisionPointLoose(raw) : null;
    const point = rel ? scalePoint(rel, size) : null;
    if (point) return { ...point, how: 'local vision' };
    return { error: `"${action.target}" screen pe nahi mila (AT-SPI + OCR + local vision sab fail)` };
  }

  // 3. Pure coordinates.
  if (action.x != null && action.y != null) {
    const point = scalePoint({ x: action.x, y: action.y }, size);
    if (!point) return { error: 'x/y screen ke bahar hain' };
    return { ...point, how: 'model coordinates' };
  }
  return { error: 'click ke liye word, x/y ya target chahiye' };
}

/** Run one validated action. Throws on failure (the loop turns that into history). */
export async function executeHandsAction(action, ctx) {
  const { log, size } = ctx;
  switch (action.action) {
    case 'click':
    case 'double_click':
    case 'right_click': {
      const point = await resolveTarget(action, ctx);
      if (point.error) throw new Error(point.error);
      const button = action.action === 'right_click' ? 'right' : (action.button ?? 'left');
      const repeat = action.action === 'double_click' ? 2 : 1;
      await pc.click(point.x, point.y, button, repeat);
      return { detail: `🖱️ clicked ${point.x},${point.y} · ${point.how}` };
    }
    case 'move': {
      const point = scalePoint({ x: action.x, y: action.y }, size);
      if (!point) throw new Error('move ke liye valid x/y chahiye');
      await pc.moveMouse(point.x, point.y);
      return { detail: `🖱️ pointer ${point.x},${point.y}` };
    }
    case 'drag': {
      const from = scalePoint({ x: action.x1, y: action.y1 }, size);
      const to = scalePoint({ x: action.x2, y: action.y2 }, size);
      if (!from || !to) throw new Error('drag ke coordinates screen ke bahar hain');
      await pc.dragMouse(from.x, from.y, to.x, to.y);
      return { detail: `🖱️ dragged ${from.x},${from.y} → ${to.x},${to.y}` };
    }
    case 'type': {
      // Optional target click before typing (Agent-S `agent.type(element_description, text, overwrite, enter)`)
      if (action.target) {
        const point = await resolveTarget({ target: action.target, x: action.x, y: action.y }, ctx);
        if (!point.error) {
          await pc.click(point.x, point.y, 'left', 1);
          await sleep(180);
        }
      }
      if (action.overwrite) {
        await pc.keyCombo('ctrl+a');
        await sleep(80);
        await pc.keyCombo('BackSpace');
        await sleep(80);
      }
      try {
        await pc.pasteText(action.text);
      } catch (err) {
        log?.info?.(`[hands] paste failed (${err.message}) — typing char by char`);
        await pc.typeText(action.text);
      }
      if (action.submit) {
        await sleep(250);
        await pc.keyCombo('enter');
        return { detail: `⌨️ typed ${action.text.length} chars + Enter` };
      }
      return { detail: `⌨️ typed ${action.text.length} chars` };
    }
    case 'key':
      await pc.keyCombo(action.keys);
      return { detail: `⌨️ key ${action.keys}` };
    case 'scroll':
      await pc.scrollMouse(action.direction, action.amount);
      return { detail: `🖱️ scrolled ${action.direction} ${action.amount}` };
    case 'wait':
      await sleep(action.ms);
      return { detail: `⏳ waited ${action.ms}ms`, unchanged: true };
    case 'open': {
      const text = await pc.openTarget(action.target);
      return { detail: `🌐 ${text}`, unchanged: true };
    }
    case 'focus': {
      await apps.windowAction('focus', action.target);
      return { detail: `🪟 focused "${action.target}"`, unchanged: true };
    }
    default:
      throw new Error(`action "${action.action}" execute nahi hota`);
  }
}

// ── the loop ──────────────────────────────────────────────────────────────────

const DEFAULT_MAX_STEPS = 8;
const DEFAULT_MAX_SECONDS = 240;

export function formatHandsReply({ label = 'Hands', ok, stopped, reason, steps, seconds, answer, model, cloud, usage }) {
  const lines = steps.map((s) => `${s.ok === false ? '❌' : '✅'} ${s.step}. ${s.summary}${s.detail ? ` → ${s.detail}` : ''}`);
  const head = stopped
    ? `⏹ *${label}* — /stop se roka gaya (${steps.length} step${steps.length === 1 ? '' : 's'}, ${seconds}s)`
    : ok
      ? `🖐️ *${label}* — ${steps.length} step${steps.length === 1 ? '' : 's'} · ${seconds}s`
      : !steps.length
        ? `⚠️ *${label}* — shuru hi nahi ho paaya (${seconds}s)`
        : `⚠️ *${label}* — step ${steps.length}/${usage.maxSteps} pe ruk gaya (${seconds}s)`;
  const body = lines.length ? [head, '', ...lines] : [head];
  if (stopped) {
    body.push('', '_Aage kuch nahi kiya. Naya kaam karne ke liye dobara bhejo._');
  } else if (ok) {
    body.push('', answer ? `✅ ${answer}` : '✅ Ho gaya.');
  } else {
    body.push('', `❌ ${reason || 'kaam poora nahi hua'}`);
    body.push('_Jo kiya wahi bataya hai — kuch bhi banaya nahi gaya. Dobara bhejo ya /auto se exact steps do._');
  }
  if (model) {
    body.push('', `_🧠 ${model} · ${usage.visionCalls} vision call${usage.visionCalls === 1 ? '' : 's'}${cloud ? ' · screen cloud model ko gayi (band karna ho: ALLOW_CLOUD_SCREEN=false)' : ' · sab local'}_`);
  }
  return body.join('\n');
}

/**
 * Drive the desktop until the task is done, the model gives up, or the budget
 * runs out. `deps` exists so tests can run this without a real desktop.
 */
export async function runHands(task, { config = {}, log = console, maxSteps, onStep, deps = {}, signal } = {}) {
  const startedAll = Date.now();
  const budgetSteps = Math.min(Math.max(Number(maxSteps ?? config.handsMaxSteps ?? DEFAULT_MAX_STEPS) || DEFAULT_MAX_STEPS, 1), 20);
  const budgetMs = Math.max(20, Number(config.handsMaxSeconds ?? DEFAULT_MAX_SECONDS) || DEFAULT_MAX_SECONDS) * 1000;
  const stepDelay = Math.max(150, Number(config.handsStepDelayMs ?? 550) || 550);

  const observe = deps.observe ?? ((cfg, lg, opts) => observeScreen(cfg, lg, opts));
  const visionFirst = config.handsUseOcr !== true;
  const think = deps.think ?? ((prompt, imageBase64, mime) => ai.screenStep(config, prompt, imageBase64, log, {
    mime, signal, maxTokens: config.handsMaxTokens ?? 512,
  }));
  const act = deps.act ?? ((action, ctx) => executeHandsAction(action, ctx));

  const steps = [];
  const history = [];
  let lastShot = null;
  let lastResult = '';
  let lastChange = null;
  let lastImage = null;
  let visionCalls = 0;
  let usedModel = null;
  let cloud = false;
  let signatureRun = { sig: null, count: 0 };
  let doneAsked = false;

  const finish = (ok, extra = {}) => {
    const seconds = Math.max(1, Math.round((Date.now() - startedAll) / 1000));
    const usage = { maxSteps: budgetSteps, visionCalls };
    const stopped = Boolean(extra.stopped);
    return {
      ok,
      stopped,
      steps,
      image: lastImage,
      answer: extra.answer ?? null,
      reason: extra.reason ?? null,
      model: usedModel,
      cloud,
      seconds,
      text: formatHandsReply({
        ok, stopped, steps, seconds, answer: extra.answer, reason: extra.reason,
        model: usedModel, cloud, usage,
      }),
    };
  };

  try {
  for (let step = 1; step <= budgetSteps; step++) {
    throwIfStopped(signal, 'Hands');
    if (Date.now() - startedAll > budgetMs) {
      return finish(false, { reason: `time budget khatam (${Math.round(budgetMs / 1000)}s) — task chhota karke bhejo` });
    }

    let shot;
    try {
      shot = await observe(config, log, { useOcr: !visionFirst, signal });
    } catch (err) {
      if (err?.code === 'ESTOPPED' || signal?.aborted) return finish(false, { stopped: true, reason: '/stop' });
      return finish(false, { reason: `screenshot nahi mila: ${String(err.message).split('\n')[0]}` });
    }
    if (!shot?.image) return finish(false, { reason: 'screenshot empty aaya' });
    lastImage = shot.image;
    if (lastShot?.signature && shot.signature) {
      const diff = screenChanged(lastShot.signature, shot.signature);
      if (diff.known) {
        lastChange = diff.changed;
        // Tell the model, in the history, whether its last action did anything.
        const prev = history[history.length - 1];
        if (prev) prev.changed = diff.changed;
      }
    }

    const annotatedRaw = (shot.marks?.length && config.handsAnnotateMarks !== false)
      ? await annotateSetOfMarks(shot.image, shot.marks, shot.size)
      : shot.image;
    const { image: modelImage, mime } = await shrinkForModel(annotatedRaw, config.handsImageWidth ?? 1024, config.handsJpegQuality ?? 70);
    const prompt = buildHandsPrompt({
      task, step, maxSteps: budgetSteps, size: shot.size, words: shot.words,
      atspi: shot.atspi, windowInfo: shot.windowInfo,
      history, lastResult, lastChange, visionFirst,
    });

    let parsed = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const askPrompt = attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous reply was rejected: ${parsed?.error ?? 'unparseable'}.\nReply again with exactly ONE valid JSON object from the RULES.`;
      let res;
      try {
        throwIfStopped(signal, 'Hands');
        res = await think(askPrompt, modelImage.toString('base64'), mime);
        visionCalls += 1;
      } catch (err) {
        if (err?.code === 'ESTOPPED' || signal?.aborted) return finish(false, { stopped: true, reason: '/stop' });
        if (err?.name === 'AbortError' && signal?.aborted) return finish(false, { stopped: true, reason: '/stop' });
        return finish(false, { reason: `vision model fail: ${err.message}` });
      }
      if (!res?.text) {
        return finish(false, {
          reason: 'koi vision model jawab nahi de raha — /brains dekho. Free cloud: GEMINI_API_KEY ya GROQ_API_KEY; local: OLLAMA_VISION_MODEL',
        });
      }
      if (res.model) usedModel = res.model;
      if (res.local === false) cloud = true;
      parsed = parseHandsAction(res.text);
      if (parsed.ok) break;
    }
    if (!parsed?.ok) {
      steps.push({ step, ok: false, summary: 'model reply', detail: parsed?.error ?? 'invalid JSON' });
      return finish(false, { reason: `model ne valid action nahi diya: ${parsed?.error ?? 'invalid JSON'}` });
    }

    const action = parsed.action;
    if (action.action === 'done') {
      // "Done" on step 1 without a single action is the classic fabrication.
      // Give the model exactly one chance to actually do something first.
      if (!steps.length && !doneAsked) {
        doneAsked = true;
        lastResult = 'You replied "done" but no action has been taken yet. If the task really already is complete on this screen, reply done again; otherwise do the next action now.';
        await sleep(stepDelay);
        continue;
      }
      // Best-effort proof: what the screen looks like AFTER the last action.
      try {
        const finalShot = await observe(config, log);
        if (finalShot?.image) lastImage = finalShot.image;
      } catch { /* keep the previous screenshot */ }
      const note = !steps.length ? ' (koi action nahi kiya — screen pehle se hi aisi thi)' : '';
      return finish(true, { answer: `${action.answer || ''}${note}`.trim() });
    }
    if (action.action === 'fail') return finish(false, { reason: action.reason });

    // Stuck detection: same action repeatedly with no visible progress.
    const sig = actionSignature(action);
    signatureRun = sig === signatureRun.sig ? { sig, count: signatureRun.count + 1 } : { sig, count: 1 };

    let detail = '';
    let ok = true;
    try {
      const result = await act(action, {
        config, log, size: shot.size, words: shot.words,
        atspi: shot.atspi ?? [], marks: shot.marks ?? [],
        imageBase64: modelImage.toString('base64'),
        // Lazy OCR on the ORIGINAL screenshot: only when a named target needs
        // snapping to exact pixels. Never on the normal coordinate path.
        ensureWords: () => wordsForShot(shot, log),
      });
      detail = result?.detail ?? '';
      if (result?.done) return finish(true, { answer: result.answer ?? '' });
    } catch (err) {
      if (err?.code === 'ESTOPPED' || signal?.aborted) return finish(false, { stopped: true, reason: '/stop' });
      ok = false;
      detail = `❌ ${String(err.message).split('\n')[0].slice(0, 220)}`;
    }

    const entry = { step, ok, summary: summarizeAction(action), detail };
    steps.push(entry);
    history.push(entry);
    lastResult = detail;
    onStep?.(entry);
    log?.info?.(`[hands] ${step}. ${entry.summary} → ${detail}`);

    if (signatureRun.count >= 3 && lastChange === false) {
      return finish(false, { reason: `same action "${summarizeAction(action)}" 3 baar, screen nahi badli — stuck` });
    }
    lastShot = shot;
    await sleepWith(stepDelay, signal, 'Hands');
  }
  } catch (err) {
    if (err?.code === 'ESTOPPED' || signal?.aborted) return finish(false, { stopped: true, reason: '/stop' });
    throw err;
  }

  return finish(false, { reason: `${budgetSteps} steps me task poora nahi hua` });
}
