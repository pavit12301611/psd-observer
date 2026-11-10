// sendbutton.js — 🖱️ Gmail ka *Send* button khud dabao, bina owner ke click ke.
//
// Why this file exists (the actual failure modes it fixes):
//   Gmail's Send button is **white text on a blue fill**. Two things go wrong
//   with the obvious approach:
//     1. tesseract reads dark-on-light far better than light-on-dark, so a plain
//        screenshot often yields nothing → the old code told the owner
//        "khud Send dabao".
//     2. Even after negating the frame, a 12 px label on a 3840-wide screenshot
//        is too small for OCR — and if tesseract is not installed at all, every
//        OCR pass simply throws.
//   So the click tries, in order, and stops at the first hit:
//     a. OCR the plain frame, then the **negated** frame (white-on-blue).
//     b. OCR a **2× zoom** of the lower half — the button is small, not dark.
//     c. Find the button **by colour** (Gmail blue connected component with a
//        light ring around it) — no OCR, no tesseract, works on any locale.
//     d. Last resort: **Ctrl+Enter**, Gmail's own send shortcut — no
//        coordinates at all, so it cannot click the wrong thing.
//   A click is only ever *tried* on something located (label or button blob) —
//   blind coordinates are never used, because a stray click in Gmail can discard
//   the draft, which is worse than an honest "nahi mila".

import * as finder from './elementfinder.js';

export const SEND_LABELS = ['Send', 'Send message', 'Send mail', 'Senden', 'Enviar', 'Verzenden'];

// ── OCR label matching ───────────────────────────────────────────────────────

/**
 * OCR words → the best clickable "Send" target, or null.
 * Pure: tests feed word lists, no screen needed.
 */
export function pickSendTarget(words, labels = SEND_LABELS) {
  if (!Array.isArray(words) || !words.length) return null;
  let best = null;
  for (const label of labels) {
    const hit = finder.findTextTarget(words, label);
    if (hit && (!best || hit.score > best.score)) best = { ...hit, label };
  }
  return best;
}

// ── PNG plumbing (pngjs, no native build) ────────────────────────────────────

async function pngLib() {
  try {
    return (await import('pngjs')).PNG;
  } catch {
    return null;
  }
}

/** Decode a PNG buffer → {width, height, data} or null (JPEG/blank/garbage). */
export async function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!SIG.every((b, i) => buffer[i] === b)) return null;
  const PNG = await pngLib();
  if (!PNG) return null;
  try {
    return PNG.sync.read(buffer);
  } catch {
    return null;
  }
}

export async function encodePng(png) {
  const PNG = await pngLib();
  if (!PNG || !png) return null;
  try {
    return PNG.sync.write(png);
  } catch {
    return null;
  }
}

// ── colour search: the blue button, without OCR ──────────────────────────────

/** Gmail's blue (#1a73e8 / #0b57d0 family): saturated, low red, high blue. */
export function isGmailBlue(r, g, b) {
  return b >= 140 && b - r >= 60 && b - g >= 30 && r <= 130 && g <= 170;
}

/**
 * Connected components of "Gmail blue" pixels → button-shaped boxes.
 * Pure over decoded pixels so tests can build a fake screen in memory.
 *
 * Filters that remove everything that is *not* a filled button: minimum size,
 * a wide-ish aspect ratio (a split "Send ▾" control is ~1.5:1), height small
 * enough to be a toolbar control, and a **light ring** around the box — dock
 * icons and dark-theme chrome sit on dark pixels and are dropped here.
 */
export function blueBlobCandidates(png, {
  minWidth = 34,
  minHeight = 12,
  maxHeight = 90,
  minArea = 500,
  ringLightMin = 0.4,
} = {}) {
  if (!png?.data || !png.width || !png.height) return [];
  const { width: w, height: h, data } = png;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      if (isGmailBlue(data[i], data[i + 1], data[i + 2])) mask[y * w + x] = 1;
    }
  }

  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const out = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    let count = 0;
    let minX = w; let maxX = -1; let minY = h; let maxY = -1;
    while (sp > 0) {
      const idx = stack[--sp];
      const x = idx % w;
      const y = (idx - x) / w;
      count += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[sp++] = idx - 1; }
      if (x < w - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[sp++] = idx + 1; }
      if (y > 0 && mask[idx - w] && !seen[idx - w]) { seen[idx - w] = 1; stack[sp++] = idx - w; }
      if (y < h - 1 && mask[idx + w] && !seen[idx + w]) { seen[idx + w] = 1; stack[sp++] = idx + w; }
    }

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    // Fill ratio: a button is a filled rectangle, not a thin line of blue text.
    const fill = count / Math.max(1, bw * bh);
    if (count < minArea || bw < minWidth || bh < minHeight || bh > maxHeight) continue;
    if (bw / bh < 1.1 || bw / bh > 7 || fill < 0.55) continue;
    // Toolbars live in the lower part of the window; skip the very top (tabs).
    if (minY < h * 0.08) continue;

    const ring = ringLightness(data, w, h, { left: minX, top: minY, width: bw, height: bh }, 4);
    if (ring < ringLightMin) continue;
    out.push({
      left: minX,
      top: minY,
      width: bw,
      height: bh,
      area: count,
      fill: Number(fill.toFixed(2)),
      ringLight: Number(ring.toFixed(2)),
      // 40 % from the left, not the exact centre: Gmail's Send is a *split*
      // button and the right edge is the ▾ arrow — hitting that opens a menu
      // instead of sending. 40 % is inside the label area either way.
      x: minX + Math.round(bw * 0.4),
      y: minY + Math.round(bh / 2),
      method: 'blue-button',
    });
  }
  return out.sort((a, b) => b.area - a.area);
}

/** Fraction of light pixels in the frame drawn `pad` px outside the box. */
export function ringLightness(data, w, h, box, pad = 4) {
  const x0 = Math.max(0, box.left - pad);
  const y0 = Math.max(0, box.top - pad);
  const x1 = Math.min(w - 1, box.left + box.width + pad);
  const y1 = Math.min(h - 1, box.top + box.height + pad);
  let light = 0;
  let total = 0;
  const isLight = (x, y) => {
    const i = (y * w + x) * 4;
    return (data[i] + data[i + 1] + data[i + 2]) / 3 > 170;
  };
  for (let x = x0; x <= x1; x += 1) {
    for (const y of [y0, y1]) { total += 1; if (isLight(x, y)) light += 1; }
  }
  for (let y = y0; y <= y1; y += 1) {
    for (const x of [x0, x1]) { total += 1; if (isLight(x, y)) light += 1; }
  }
  return total ? Math.max(light / total, light / Math.max(1, total)) : 0;
}

/**
 * The one blue box we are willing to click. When two similar-sized blue boxes
 * are on screen we decline (returns null) — a 50/50 guess can hit "Discard".
 */
export function pickSendBlob(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  const sorted = [...candidates].sort((a, b) => b.area - a.area);
  if (sorted.length > 1 && sorted[0].area < sorted[1].area * 1.6) return null;
  return sorted[0];
}

// ── inverted frame (white-on-blue → black-on-white) ──────────────────────────

/**
 * White-on-blue → black-on-white so tesseract can read the button.
 * `sharp` first (optional dep), then a pure-JS `pngjs` negation; returns null
 * only when neither can decode the frame, and callers keep the plain frame.
 */
export async function invertForOcr(buffer) {
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(buffer).negate({ alpha: false }).png().toBuffer();
  } catch { /* fall through to the pure-JS path */ }
  return invertPngJs(buffer);
}

/** Pure-JS negation: RGB inverted, alpha kept. Null on anything it cannot decode. */
export async function invertPngJs(buffer) {
  const png = await decodePng(buffer);
  if (!png) return null;
  const { data } = png;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255 - data[i];
    data[i + 1] = 255 - data[i + 1];
    data[i + 2] = 255 - data[i + 2];
  }
  return encodePng(png);
}

// ── zoomed crop OCR (a 12 px label is small, not dark) ───────────────────────

/**
 * Bottom `fromY…1` slice of the frame, nearest-neighbour upscaled.
 * Returns {buffer, offsetY, factor} so OCR coordinates can be mapped back, or
 * null when the frame cannot be decoded or is too big to upscale.
 */
export async function zoomBottomForOcr(buffer, { factor = 2, fromY = 0.5 } = {}) {
  const png = await decodePng(buffer);
  if (!png) return null;
  const y0 = Math.floor(png.height * fromY);
  const outW = png.width * factor;
  const outH = (png.height - y0) * factor;
  if (!outW || !outH || outW > 4200 || outH > 4200) return null;
  const out = { width: outW, height: outH, data: Buffer.alloc(outW * outH * 4) };
  for (let y = 0; y < outH; y += 1) {
    const sy = y0 + Math.floor(y / factor);
    for (let x = 0; x < outW; x += 1) {
      const sx = Math.floor(x / factor);
      const si = (sy * png.width + sx) * 4;
      const di = (y * outW + x) * 4;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = png.data[si + 3];
    }
  }
  const encoded = await encodePng(out);
  return encoded ? { buffer: encoded, offsetY: y0, factor } : null;
}

/** Zoomed-frame box → real-screen target. */
export function mapZoomedTarget(hit, { offsetY = 0, factor = 2 } = {}) {
  if (!hit || !factor) return null;
  return {
    ...hit,
    x: Math.round(hit.x / factor),
    y: Math.round(offsetY + hit.y / factor),
    box: hit.box
      ? {
        left: Math.round(hit.box.left / factor),
        top: Math.round(offsetY + hit.box.top / factor),
        width: Math.round(hit.box.width / factor),
        height: Math.round(hit.box.height / factor),
      }
      : undefined,
  };
}

// ── the orchestrator ─────────────────────────────────────────────────────────

const METHOD_TEXT = {
  ocr: 'OCR',
  'inverted-ocr': 'inverted OCR',
  'zoomed-ocr': 'zoomed OCR',
  'blue-button': 'blue button',
  shortcut: 'Ctrl+Enter',
};

export function describeMethod(method) {
  return METHOD_TEXT[method] ?? method ?? 'unknown';
}

/**
 * Locate and press Send. Everything is injected so the whole loop is testable.
 *
 * @param {object} opts
 * @param {Function} opts.capture   () => PNG buffer
 * @param {Function} opts.ocrWords  (png) => OCR word list
 * @param {Function} [opts.invert]  (png) => inverted png | null
 * @param {Function} opts.click     (x, y) => void
 * @param {Function} [opts.keys]    (combo) => void   Ctrl+Enter last resort
 * @param {Function} [opts.wait]    (ms) => Promise
 * @returns {{ok: boolean, target?: object, method?: string, attempts?: number,
 *            tried: string[], reason?: 'missing-deps'|'noscreen'|'nobutton', ocrBroken?: boolean}}
 */
export async function clickSend(opts = {}) {
  const {
    capture,
    ocrWords,
    invert = null,
    click,
    keys = null,
    wait = async () => {},
    attempts = 3,
    labels = SEND_LABELS,
    log = null,
  } = opts;

  const tried = [];
  if (typeof capture !== 'function' || typeof ocrWords !== 'function' || typeof click !== 'function') {
    return { ok: false, tried, reason: 'missing-deps' };
  }

  let ocrBroken = false;

  const readWords = async (png, tag) => {
    try {
      return await ocrWords(png);
    } catch (err) {
      if (err?.code === 'ENOENT') ocrBroken = true;
      tried.push(`${tag}: ocr fail (${err?.message ?? err})`);
      return null;
    }
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let frame;
    try {
      // eslint-disable-next-line no-await-in-loop
      frame = await capture();
    } catch (err) {
      tried.push(`attempt ${attempt}: screenshot fail (${err?.message ?? err})`);
      return { ok: false, tried, reason: 'noscreen', ocrBroken };
    }

    // a. plain OCR
    if (!ocrBroken) {
      // eslint-disable-next-line no-await-in-loop
      const words = await readWords(frame, `attempt ${attempt}: plain frame`);
      const hit = pickSendTarget(words, labels);
      if (hit) {
        // eslint-disable-next-line no-await-in-loop
        await click(hit.x, hit.y);
        return { ok: true, target: hit, method: 'ocr', attempts: attempt, tried, ocrBroken };
      }
      if (words) tried.push(`attempt ${attempt}: plain OCR read ${words.length} words, no "Send"`);
    }

    // b. inverted frame
    if (!ocrBroken && typeof invert === 'function') {
      try {
        // eslint-disable-next-line no-await-in-loop
        const flipped = await invert(frame);
        if (flipped) {
          // eslint-disable-next-line no-await-in-loop
          const words = await readWords(flipped, `attempt ${attempt}: inverted frame`);
          const hit = pickSendTarget(words, labels);
          if (hit) {
            tried.push(`attempt ${attempt}: inverted frame read it`);
            // eslint-disable-next-line no-await-in-loop
            await click(hit.x, hit.y);
            return { ok: true, target: hit, method: 'inverted-ocr', attempts: attempt, tried, ocrBroken };
          }
          if (words) tried.push(`attempt ${attempt}: inverted OCR read ${words.length} words, no "Send"`);
        }
      } catch (err) {
        log?.info?.(`[sendbutton] invert path failed: ${err?.message ?? err}`);
      }
    }

    // c. zoomed bottom half
    if (!ocrBroken) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const zoom = await zoomBottomForOcr(frame, { factor: 2, fromY: 0.45 });
        if (zoom) {
          // eslint-disable-next-line no-await-in-loop
          const words = await readWords(zoom.buffer, `attempt ${attempt}: zoomed frame`);
          const hit = mapZoomedTarget(pickSendTarget(words, labels), zoom);
          if (hit) {
            // eslint-disable-next-line no-await-in-loop
            await click(hit.x, hit.y);
            return { ok: true, target: hit, method: 'zoomed-ocr', attempts: attempt, tried, ocrBroken };
          }
        } else {
          tried.push(`attempt ${attempt}: zoom unavailable`);
        }
      } catch (err) {
        log?.info?.(`[sendbutton] zoom path failed: ${err?.message ?? err}`);
      }
    }

    // d. colour search — no OCR, no tesseract, locale-proof
    try {
      // eslint-disable-next-line no-await-in-loop
      const png = await decodePng(frame);
      if (png) {
        const blob = pickSendBlob(blueBlobCandidates(png));
        if (blob) {
          // eslint-disable-next-line no-await-in-loop
          await click(blob.x, blob.y);
          return { ok: true, target: blob, method: 'blue-button', attempts: attempt, tried, ocrBroken };
        }
        tried.push(`attempt ${attempt}: colour scan found no single blue button`);
      } else {
        tried.push(`attempt ${attempt}: frame not decodable (pngjs?)`);
      }
    } catch (err) {
      tried.push(`attempt ${attempt}: colour scan fail (${err?.message ?? err})`);
    }

    // e. keyboard shortcut — the safest thing left (no coordinates at all)
    if (typeof keys === 'function' && attempt === attempts) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await keys('ctrl+enter');
        return { ok: true, target: null, method: 'shortcut', attempts: attempt, tried, ocrBroken };
      } catch (err) {
        tried.push(`attempt ${attempt}: Ctrl+Enter fail (${err?.message ?? err})`);
      }
    }

    tried.push(`attempt ${attempt}: "Send" nahi mila`);
    if (attempt < attempts) {
      // eslint-disable-next-line no-await-in-loop
      await wait(attempt === 1 ? 2000 : 3000);
    }
  }

  return { ok: false, tried, reason: 'nobutton', ocrBroken };
}

// ── after the press: verify, then escalate ───────────────────────────────────

/**
 * Gmail's Ctrl+Enter is the *coordinate-free* way to send — and clicks can miss
 * on a scaled Wayland display, where a portal screenshot is in physical pixels
 * while ydotool moves the pointer in logical pixels. So a press that Gmail never
 * confirms is finished with the shortcut instead of being reported as a maybe.
 *
 * Pure orchestration: `readVerdict`, `pressShortcut` and `wait` are injected.
 *
 * @returns {{verdict: 'sent'|'failed'|'unknown', usedShortcut: boolean, reads: number}}
 */
export async function finishSend({
  pressed = null,
  readVerdict,
  pressShortcut = null,
  wait = async () => {},
} = {}) {
  if (typeof readVerdict !== 'function') return { verdict: 'unknown', usedShortcut: false, reads: 0 };

  let reads = 0;
  const read = async () => {
    reads += 1;
    try {
      return await readVerdict();
    } catch {
      return 'unknown';
    }
  };

  let verdict = await read();
  // "failed" means Gmail shouted an error (bad address, attachment limit) —
  // pressing Ctrl+Enter again cannot help and could resend a bad message.
  if (verdict !== 'unknown') return { verdict, usedShortcut: false, reads };
  if (pressed?.method === 'shortcut') return { verdict, usedShortcut: false, reads };
  if (typeof pressShortcut !== 'function') return { verdict, usedShortcut: false, reads };

  let usedShortcut = false;
  try {
    await pressShortcut('ctrl+enter');
    usedShortcut = true;
  } catch {
    return { verdict, usedShortcut: false, reads };
  }

  await wait(1500);
  verdict = await read();
  if (verdict === 'unknown') {
    // The snackbar can take a moment on a slow machine; one more honest look.
    await wait(1800);
    verdict = await read();
  }
  return { verdict, usedShortcut, reads };
}
