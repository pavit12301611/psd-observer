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
  if (!HANDS_ACTIONS.has(name)) return { ok: false, error: `unknown action "${name || '(missing)'}"` };

  const action = { action: name };
  const thought = String(body.thought ?? data.thought ?? '').trim();
  if (thought) action.thought = thought.slice(0, 300);

  if (CLICK_ACTIONS.has(name)) {
    if (body.word != null && Number.isFinite(Number(body.word))) action.word = Math.trunc(Number(body.word));
    const point = normalizePoint(body.x, body.y);
    if (point) Object.assign(action, point);
    const target = String(body.target ?? body.element ?? '').trim();
    if (target) action.target = target.slice(0, 120);
    if (body.button && ['left', 'right', 'middle'].includes(String(body.button).toLowerCase())) {
      action.button = String(body.button).toLowerCase();
    }
    if (action.word == null && action.x == null && !action.target) {
      return { ok: false, error: `${name} ke liye word id, x/y, ya target chahiye` };
    }
    return { ok: true, action };
  }

  if (name === 'type') {
    const text = String(body.text ?? body.content ?? '');
    if (!text) return { ok: false, error: 'type ke liye text chahiye' };
    action.text = text.slice(0, 2000);
    action.submit = Boolean(body.submit ?? body.enter);
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
      const aim = action.target ? `"${clip(action.target, 42)}"` : action.word != null ? `word ${action.word}` : `${action.x ?? '?'},${action.y ?? '?'}`;
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
    action?.action, action?.word ?? '', action?.x ?? '', action?.y ?? '', action?.target ?? '',
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
export function buildHandsPrompt({ task, step, maxSteps, size, words = [], history = [], lastResult = '', lastChange = null }) {
  const relevant = words
    .filter((w) => String(w.text ?? '').trim().length >= 2)
    .slice(0, MAX_WORDS);
  const table = relevant.map((w) => {
    const x = Math.round(((w.left + w.width / 2) / (size?.width || 1)) * 1000);
    const y = Math.round(((w.top + w.height / 2) / (size?.height || 1)) * 1000);
    return `${w.id} | ${String(w.text).replace(/\s+/g, ' ').slice(0, 40)} | ${x},${y}`;
  }).join('\n');

  const hist = history.slice(-6)
    .map((h) => `${h.step}. ${h.summary} → ${h.detail}${h.changed === true ? ' · screen changed' : h.changed === false ? ' · screen NOT changed (do not repeat this blindly)' : ''}`)
    .join('\n');

  return [
    'You are the "hands" of Observer, an agent controlling a Fedora Linux desktop with a real mouse and keyboard.',
    `TASK: ${task}`,
    `STEP: ${step} of ${maxSteps} (one action per step)`,
    `SCREEN: ${size?.width ?? 0}x${size?.height ?? 0} pixels (the screenshot may be scaled — your coordinates are relative)`,
    '',
    'RULES',
    '1. Reply with ONE JSON object and nothing else. No markdown, no explanation outside the JSON.',
    '2. Prefer a text target id from the TEXT LIST — it is pixel-exact: {"action":"click","word":42}.',
    '3. For icons or images that are not text: {"action":"click","target":"blue Send arrow","x":870,"y":940}.',
    '4. x and y are 0-1000 relative to the screen (0=left/top, 1000=right/bottom).',
    '5. Use the keyboard when it is shorter and safer: {"action":"key","keys":"ctrl+l"} for the address bar, {"action":"key","keys":"enter"} to submit.',
    '6. To type into the field that is already focused: {"action":"type","text":"...","submit":true}. Click the field first if it is not focused.',
    '7. Never repeat an action that just failed or changed nothing — choose another way (scroll, keyboard, a different word).',
    '8. Never type passwords, OTPs, card numbers or recovery codes. Never click Delete / Uninstall / Format / Log out unless the TASK explicitly says so.',
    '9. When the TASK is complete: {"action":"done","answer":"short answer for the owner (what they asked for)"}.',
    '10. If it truly cannot be done: {"action":"fail","reason":"one line why"}.',
    '',
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
 * Screenshot + size + OCR words + a cheap signature (for change detection).
 * OCR is local and free; when tesseract is missing we simply lose the word list.
 */
export async function observeScreen(config, log = console) {
  // A loop takes up to 8 screenshots: one stuck portal dialog must not eat the
  // whole run, so each capture gets at most 30s (PORTAL_TIMEOUT_MS still wins
  // when it is smaller).
  const cap = Math.min(Number(config?.portalTimeoutMs ?? 60_000) || 60_000, 30_000);
  const image = await pc.captureScreenshot({ portalTimeoutMs: cap });
  const size = pngSize(image) ?? { width: 0, height: 0 };
  let words = [];
  try {
    words = await ocrScreenshot(image);
  } catch (err) {
    if (err.code !== 'ENOENT') log?.info?.(`[hands] OCR skipped: ${err.message}`);
  }
  // Re-number so the ids in the prompt match this array exactly: a stale id
  // must never end up clicking a random word.
  words = words.map((w, i) => ({ ...w, id: i }));
  return { image, size, words, signature: imageSignature(image) };
}

/** Shrink screenshots for free-tier image limits (best effort; original on failure). */
export async function shrinkForModel(image, maxWidth = 1280) {
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(image).metadata();
    if (!meta.width || meta.width <= maxWidth) return { image, mime: 'image/png' };
    const out = await sharp(image).resize({ width: maxWidth }).jpeg({ quality: 72 }).toBuffer();
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
 * Resolve where a click should land.
 * word id → OCR box (exact) · x,y → scaled · target → OCR phrase → local vision.
 */
export async function resolveTarget(action, ctx) {
  const { words = [], size, config, log } = ctx;
  if (action.word != null) {
    const word = words.find((w) => w.id === action.word);
    if (!word) return { error: `word id ${action.word} screen pe nahi mila` };
    return {
      x: Math.round(word.left + word.width / 2),
      y: Math.round(word.top + word.height / 2),
      how: `OCR "${word.text}"`,
    };
  }
  if (action.x != null && action.y != null) {
    const point = scalePoint({ x: action.x, y: action.y }, size);
    if (!point) return { error: 'x/y screen ke bahar hain' };
    return { ...point, how: 'model coordinates' };
  }
  if (action.target) {
    const hit = findTextTarget(words, action.target);
    if (hit) return { x: hit.x, y: hit.y, how: `OCR "${hit.matched}"` };
    const raw = await ai.locateInImage(config, ctx.imageBase64, action.target, log);
    const rel = raw ? parseVisionPointLoose(raw) : null;
    const point = rel ? scalePoint(rel, size) : null;
    if (point) return { ...point, how: 'local vision' };
    return { error: `"${action.target}" screen pe nahi mila (OCR + local vision dono fail)` };
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

export function formatHandsReply({ label = 'Hands', ok, reason, steps, seconds, answer, model, cloud, usage }) {
  const lines = steps.map((s) => `${s.ok === false ? '❌' : '✅'} ${s.step}. ${s.summary}${s.detail ? ` → ${s.detail}` : ''}`);
  const head = ok
    ? `🖐️ *${label}* — ${steps.length} step${steps.length === 1 ? '' : 's'} · ${seconds}s`
    : !steps.length
      ? `⚠️ *${label}* — shuru hi nahi ho paaya (${seconds}s)`
      : `⚠️ *${label}* — step ${steps.length}/${usage.maxSteps} pe ruk gaya (${seconds}s)`;
  const body = lines.length ? [head, '', ...lines] : [head];
  if (ok) {
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
export async function runHands(task, { config = {}, log = console, maxSteps, onStep, deps = {} } = {}) {
  const startedAll = Date.now();
  const budgetSteps = Math.min(Math.max(Number(maxSteps ?? config.handsMaxSteps ?? DEFAULT_MAX_STEPS) || DEFAULT_MAX_STEPS, 1), 20);
  const budgetMs = Math.max(20, Number(config.handsMaxSeconds ?? DEFAULT_MAX_SECONDS) || DEFAULT_MAX_SECONDS) * 1000;
  const stepDelay = Math.max(200, Number(config.handsStepDelayMs ?? 900) || 900);

  const observe = deps.observe ?? ((cfg, lg) => observeScreen(cfg, lg));
  const think = deps.think ?? ((prompt, imageBase64, mime) => ai.screenStep(config, prompt, imageBase64, log, { mime }));
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
    return {
      ok,
      steps,
      image: lastImage,
      answer: extra.answer ?? null,
      reason: extra.reason ?? null,
      model: usedModel,
      cloud,
      seconds,
      text: formatHandsReply({
        ok, steps, seconds, answer: extra.answer, reason: extra.reason,
        model: usedModel, cloud, usage,
      }),
    };
  };

  for (let step = 1; step <= budgetSteps; step++) {
    if (Date.now() - startedAll > budgetMs) {
      return finish(false, { reason: `time budget khatam (${Math.round(budgetMs / 1000)}s) — task chhota karke bhejo` });
    }

    let shot;
    try {
      shot = await observe(config, log);
    } catch (err) {
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

    const { image: modelImage, mime } = await shrinkForModel(shot.image, config.handsImageWidth ?? 1280);
    const prompt = buildHandsPrompt({
      task, step, maxSteps: budgetSteps, size: shot.size, words: shot.words,
      history, lastResult, lastChange,
    });

    let parsed = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const askPrompt = attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous reply was rejected: ${parsed?.error ?? 'unparseable'}.\nReply again with exactly ONE valid JSON object from the RULES.`;
      let res;
      try {
        res = await think(askPrompt, modelImage.toString('base64'), mime);
        visionCalls += 1;
      } catch (err) {
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
        config, log, size: shot.size, words: shot.words, imageBase64: modelImage.toString('base64'),
      });
      detail = result?.detail ?? '';
      if (result?.done) return finish(true, { answer: result.answer ?? '' });
    } catch (err) {
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
    await sleep(stepDelay);
  }

  return finish(false, { reason: `${budgetSteps} steps me task poora nahi hua` });
}
