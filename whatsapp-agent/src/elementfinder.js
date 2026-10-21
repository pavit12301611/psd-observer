// elementfinder.js — "element awareness" for PC control: find a button/field
// ON THE SCREEN by its visible label ("Login", "Search", "Sign in"…) so the
// owner can say /pc tap Login instead of guessing pixel coordinates.
//
// Pipeline, all free + local:
//   1. screenshot (pccontrol.captureScreenshot)
//   2. OCR with tesseract (TSV word boxes) → exact/fuzzy text match. Fast,
//      deterministic, works offline. This finds most real UI labels.
//   3. Fallback: a local Ollama *vision* model is asked for the element's
//      centre as JSON (good for icons / unlabelled controls, approximate).
// The caller clicks the returned centre (tier-2 gated) and sends back an
// annotated screenshot (crosshair) as proof of what was targeted.
//
// Known physics: coordinates are screenshot pixels. With fractional display
// scaling (125%/150%) or multi-monitor layouts, input coordinates can be
// scaled/offset by the compositor — if taps land consistently off-target by a
// fixed ratio, that's scaling; 100% scale is exact.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as pc from './pccontrol.js';
import * as ai from './ai.js';

const execFileAsync = promisify(execFile);

// ── image helpers ─────────────────────────────────────────────────────────────

/** Width/height of a PNG from its IHDR chunk (screenshots are PNG). */
export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!PNG_SIG.every((b, i) => buffer[i] === b)) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Draw a crosshair marker at (x,y). Uses optional sharp; plain buffer if absent. */
export async function annotateScreenshot(buffer, x, y, width, height) {
  try {
    const sharp = (await import('sharp')).default;
    const r = Math.max(14, Math.round(width / 60));
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#ff2222" stroke-width="4"/>
      <line x1="${x - r - 10}" y1="${y}" x2="${x + r + 10}" y2="${y}" stroke="#ff2222" stroke-width="3"/>
      <line x1="${x}" y1="${y - r - 10}" x2="${x}" y2="${y + r + 10}" stroke="#ff2222" stroke-width="3"/>
    </svg>`;
    return await sharp(buffer).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
  } catch {
    return buffer; // sharp not installed (optional dep) — send the raw shot
  }
}

// ── OCR (tesseract TSV) ───────────────────────────────────────────────────────

export function parseOcrTsv(tsv) {
  const lines = String(tsv ?? '').trim().split('\n').filter(Boolean);
  if (!lines.length) return [];
  // The CLI prints a header row; some builds/bindings omit it. Handle both:
  // with a header we map by name, without one we use the canonical order.
  const CANONICAL = ['level', 'page_num', 'block_num', 'par_num', 'line_num', 'word_num', 'left', 'top', 'width', 'height', 'conf', 'text'];
  const hasHeader = lines[0].startsWith('level\t') || lines[0].includes('page_num');
  const header = hasHeader ? lines[0].split('\t') : CANONICAL;
  const col = (name) => header.indexOf(name);
  const [iLevel, iBlock, iPar, iLine, iWord, iLeft, iTop, iW, iH, iConf, iText] =
    ['level', 'block_num', 'par_num', 'line_num', 'word_num', 'left', 'top', 'width', 'height', 'conf', 'text'].map(col);
  const words = [];
  for (const row of hasHeader ? lines.slice(1) : lines) {
    const cells = row.split('\t');
    if (cells[iLevel] !== '5') continue; // word level only
    const text = (cells[iText] ?? '').trim();
    if (!text) continue;
    words.push({
      text,
      left: Number(cells[iLeft]) || 0,
      top: Number(cells[iTop]) || 0,
      width: Number(cells[iW]) || 0,
      height: Number(cells[iH]) || 0,
      conf: Number(cells[iConf]) || 0,
      lineKey: `${cells[iBlock]}/${cells[iPar]}/${cells[iLine]}`,
      wordNum: Number(cells[iWord]) || 0,
    });
  }
  return words;
}

const normalize = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const compact = (s) => normalize(s).replace(/ /g, '');

export function levenshtein(a, b) {
  const m = a.length; const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

function phraseScore(candidate, query) {
  const cNorm = normalize(candidate);
  const qNorm = normalize(query);
  if (!cNorm || !qNorm) return 0;
  if (cNorm === qNorm) return 1;
  if (compact(candidate) === compact(query)) return 0.97; // "Log in" vs "Login"
  if (cNorm.includes(qNorm)) return 0.9; // candidate "Login to your account"
  if (qNorm.includes(cNorm) && cNorm.length >= 3) return 0.78; // query "the login button" vs label "Login"
  const cToks = new Set(cNorm.split(' '));
  const qToks = new Set(qNorm.split(' '));
  const overlap = [...qToks].filter((t) => cToks.has(t)).length;
  const jaccard = overlap / Math.max(1, new Set([...cToks, ...qToks]).size);
  const sim = 1 - levenshtein(compact(candidate), compact(query)) / Math.max(compact(candidate).length, compact(query).length, 1);
  return Math.max(jaccard * 0.85, sim >= 0.72 ? sim * 0.8 : 0);
}

/**
 * Find the best on-screen text target for `query` among OCR words.
 * Tries every contiguous word-window within each OCR line (so "Sign in",
 * "Add to cart" match as phrases). Returns centre + box + confidence or null.
 */
export function findTextTarget(words, query) {
  const byLine = new Map();
  for (const w of words) {
    if (!byLine.has(w.lineKey)) byLine.set(w.lineKey, []);
    byLine.get(w.lineKey).push(w);
  }
  let best = null;
  for (const lineWords of byLine.values()) {
    const sorted = [...lineWords].sort((a, b) => a.wordNum - b.wordNum || a.left - b.left);
    for (let start = 0; start < sorted.length; start++) {
      for (let size = 1; size <= Math.min(5, sorted.length - start); size++) {
        const windowWords = sorted.slice(start, start + size);
        const phrase = windowWords.map((w) => w.text).join(' ');
        const avgConf = windowWords.reduce((sum, w) => sum + Math.max(w.conf, 0), 0) / windowWords.length;
        const score = phraseScore(phrase, query) * (0.75 + 0.25 * (avgConf / 100));
        if (!best || score > best.score) {
          const left = Math.min(...windowWords.map((w) => w.left));
          const top = Math.min(...windowWords.map((w) => w.top));
          const right = Math.max(...windowWords.map((w) => w.left + w.width));
          const bottom = Math.max(...windowWords.map((w) => w.top + w.height));
          best = {
            score,
            matched: phrase,
            confidence: Math.round(avgConf),
            box: { left, top, width: right - left, height: bottom - top },
            x: Math.round((left + right) / 2),
            y: Math.round((top + bottom) / 2),
          };
        }
      }
    }
  }
  return best && best.score >= 0.55 ? best : null;
}

export async function ocrScreenshot(pngBuffer) {
  // PSM 11 = "sparse text", the right mode for scattered UI labels.
  const { stdout } = await execFileAsync('tesseract', ['stdin', 'stdout', '--psm', '11', 'tsv'], {
    input: pngBuffer,
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    env: pc.displayEnv(),
  });
  return parseOcrTsv(stdout);
}

// ── vision-model fallback ─────────────────────────────────────────────────────

/** Parse a vision model's reply into a point in 0..1000 relative coordinates. */
export function parseVisionPoint(text) {
  const m = String(text ?? '').match(/\{[^{}]*"x"\s*:\s*([\d.]+)[^{}]*"y"\s*:\s*([\d.]+)[^{}]*\}/);
  if (m) {
    let [x, y] = [Number(m[1]), Number(m[2])];
    if (x <= 1 && y <= 1) { x *= 1000; y *= 1000; } // fraction form
    if (x > 1000 || y > 1000) return null;
    return { x: Math.round(x), y: Math.round(y) };
  }
  if (/found"\s*:\s*false/i.test(String(text ?? ''))) return null;
  return null;
}

// ── the orchestrator ──────────────────────────────────────────────────────────

export const TESSERACT_HINT = 'sudo dnf install tesseract';

/**
 * Locate `query` on the current screen using Agent-S 3-layer grounding:
 *   1. Linux AT-SPI accessibility widget tree (100% exact OS widget bounding box)
 *   2. Tesseract OCR word/phrase bounding box (`start` | `center` | `end` alignment)
 *   3. Set-of-Marks (SoM) + coordinate grid vision model fallback
 * Returns { x, y, width, height, source: 'atspi'|'ocr'|'vision', matched, confidence, screenshot }.
 */
export async function locateOnScreen(config, query, log = console, { alignment = 'center' } = {}) {
  const label = String(query ?? '').trim();
  if (!label) throw new Error('usage: /pc tap <PIN> <button or field label, e.g. Login>');
  const screenshot = await pc.captureScreenshot({ portalTimeoutMs: config?.portalTimeoutMs });
  const size = pngSize(screenshot);
  if (!size) throw new Error('Screenshot captured but its size could not be read (not a PNG?) — cannot map click coordinates.');

  // Layer 1: Linux AT-SPI Accessibility Tree (exact widget coordinates, zero guessing)
  try {
    const { inspectDesktopElements, findElementInTree, alignTargetCoords } = await import('./grounding.js');
    const desktop = await inspectDesktopElements({ timeoutMs: 2000 });
    const atspiHit = findElementInTree(desktop.elements, label);
    if (atspiHit) {
      const aligned = alignTargetCoords(atspiHit, alignment) ?? { x: atspiHit.x, y: atspiHit.y };
      return {
        ...atspiHit,
        ...aligned,
        ...size,
        source: 'atspi',
        screenshot,
      };
    }
  } catch { /* AT-SPI optional — continue to OCR */ }

  // Layer 2: Local Tesseract OCR phrase match
  let ocrMissing = false;
  let ocrWords = [];
  try {
    ocrWords = await ocrScreenshot(screenshot);
    const hit = findTextTarget(ocrWords, label);
    if (hit) {
      if (alignment && alignment !== 'center') {
        const { alignTargetCoords } = await import('./grounding.js');
        const aligned = alignTargetCoords(hit, alignment);
        if (aligned) Object.assign(hit, aligned);
      }
      return { ...hit, ...size, source: 'ocr', screenshot };
    }
    log.info?.(`[pc] locate "${label}": OCR miss (${ocrWords.length} words), trying vision model`);
  } catch (err) {
    if (err.code === 'ENOENT') ocrMissing = true;
    else log.warn?.(`[pc] OCR failed (${err.message}), trying vision model`);
  }

  // Layer 3: Vision model with Set-of-Marks + coordinate ruler overlay
  let visionShot = screenshot;
  try {
    const { buildSetOfMarks, annotateSetOfMarks } = await import('./grounding.js');
    const marks = buildSetOfMarks({ ocrWords, size });
    visionShot = await annotateSetOfMarks(screenshot, marks, size);
  } catch { /* raw screenshot fallback */ }

  const raw = await ai.locateInImage(config, visionShot.toString('base64'), label, log);
  const point = raw ? parseVisionPoint(raw) : null;
  if (point) {
    return {
      x: Math.round((point.x / 1000) * size.width),
      y: Math.round((point.y / 1000) * size.height),
      ...size,
      source: 'vision',
      matched: label,
      confidence: null,
      screenshot,
    };
  }

  const parts = [
    `🔎 I couldn't find "${label}" on the screen.`,
    ocrMissing
      ? `OCR isn't installed — that's the accurate text-finder: ${TESSERACT_HINT} then try again.`
      : 'Check the exact label text (try /pc screenshot to look), or scroll the page first with /pc key pagedown.',
    !ocrMissing && !config.ollamaVisionModel
      ? 'Tip: setting OLLAMA_VISION_MODEL (e.g. qwen2.5-vl or llava) also lets me find icons and unlabelled controls.'
      : '',
  ].filter(Boolean);
  throw new Error(parts.join('\n'));
}
