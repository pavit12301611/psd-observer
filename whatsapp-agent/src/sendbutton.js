// sendbutton.js — 🖱️ Gmail ka *Send* button khud dabao, bina owner ke click ke.
//
// Why this file exists (the actual failure mode it fixes):
//   Gmail's Send button is **white text on a blue fill**. OCR (tesseract) reads
//   dark-on-light far better than light-on-dark, so a single plain screenshot
//   could miss the label and the old code then told the owner "khud Send dabao".
//   Three things make the click reliable here:
//     1. Several labels ("Send", "Send message", …) — UI language/ellipsis change.
//     2. A **negated** copy of the frame when the first pass finds nothing, so
//        white-on-blue becomes black-on-white and OCR can actually read it.
//     3. Up to N attempts with waits, because the compose pane sometimes is not
//        painted yet when the URL opens.
//   A click is only ever *tried* on a located label — blind coordinates are not
//   used, because clicking the wrong place in Gmail can discard a draft.

import * as finder from './elementfinder.js';

export const SEND_LABELS = ['Send', 'Send message', 'Send mail', 'Senden', 'Enviar'];

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

/**
 * White-on-blue → black-on-white so tesseract can read the button.
 * `sharp` first (optional dep), then a pure-JS `pngjs` negation; returns null
 * only when neither can decode the frame, and callers keep the plain frame.
 */
export async function invertForOcr(buffer) {
  // Preferred: sharp (optional dep) — one line, handles any PNG flavour.
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(buffer).negate({ alpha: false }).png().toBuffer();
  } catch { /* fall through to the pure-JS path */ }
  // Fallback: pngjs (already on disk via qrcode) — no native build needed.
  return invertPngJs(buffer);
}

/**
 * Pure-JS negation: RGB inverted, alpha kept. Returns null on anything it
 * cannot decode, so callers just keep the plain frame.
 */
export async function invertPngJs(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!PNG_SIG.every((b, i) => buffer[i] === b)) return null;
  let PNG;
  try {
    PNG = (await import('pngjs')).PNG;
  } catch {
    return null;
  }
  try {
    const png = PNG.sync.read(buffer);
    const { data } = png;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255 - data[i];
      data[i + 1] = 255 - data[i + 1];
      data[i + 2] = 255 - data[i + 2];
    }
    return PNG.sync.write(png);
  } catch {
    return null;
  }
}

/**
 * Locate and click Send. Everything is injected so the whole loop is testable.
 *
 * @returns {{ok: boolean, target?: object, attempts?: number, tried: string[], reason?: string}}
 */
export async function clickSend(opts = {}) {
  const {
    capture,
    ocrWords,
    invert = null,
    click,
    wait = async () => {},
    attempts = 3,
    labels = SEND_LABELS,
    log = null,
  } = opts;

  const tried = [];
  if (typeof capture !== 'function' || typeof ocrWords !== 'function' || typeof click !== 'function') {
    return { ok: false, tried, reason: 'missing-deps' };
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let frame;
    try {
      // eslint-disable-next-line no-await-in-loop
      frame = await capture();
    } catch (err) {
      tried.push(`attempt ${attempt}: screenshot fail (${err?.message ?? err})`);
      return { ok: false, tried, reason: 'noscreen' };
    }

    let target = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      const words = await ocrWords(frame);
      target = pickSendTarget(words, labels);
    } catch (err) {
      tried.push(`attempt ${attempt}: ocr fail (${err?.message ?? err})`);
    }

    // Second pass on the inverted frame: this is what catches white-on-blue.
    if (!target && typeof invert === 'function') {
      try {
        // eslint-disable-next-line no-await-in-loop
        const flipped = await invert(frame);
        if (flipped) {
          // eslint-disable-next-line no-await-in-loop
          const flippedWords = await ocrWords(flipped);
          target = pickSendTarget(flippedWords, labels);
          if (target) tried.push(`attempt ${attempt}: inverted frame read it`);
        }
      } catch (err) {
        log?.info?.(`[sendbutton] invert path failed: ${err?.message ?? err}`);
      }
    }

    if (target) {
      // eslint-disable-next-line no-await-in-loop
      await click(target.x, target.y);
      return { ok: true, target, attempts: attempt, tried };
    }

    tried.push(`attempt ${attempt}: "Send" label not on screen`);
    if (attempt < attempts) {
      // eslint-disable-next-line no-await-in-loop
      await wait(attempt === 1 ? 2000 : 3000);
    }
  }

  return { ok: false, tried, reason: 'nobutton' };
}
