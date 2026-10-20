// imaging.js — tiny, dependency-free PNG inspection.
//
// Wayland's security model means a screenshot tool that "succeeds" can still
// hand back a perfectly black image (the compositor blocked the capture). The
// agent must notice that instead of sending the owner a black rectangle, so we
// decode the PNG and measure it: mean brightness, range, distinct colours.
//
// Supports the PNGs every Linux screenshot tool produces: 8-bit greyscale,
// RGB, palette, grey+alpha and RGBA, non-interlaced. Anything else returns
// null (= "can't tell, assume fine"), which never blocks a real screenshot.

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Minimal PNG decoder → { width, height, channels, pixels } or null.
 * `pixels` is unfiltered 8-bit RGB/RGBA-ish data (palette expanded to RGB).
 */
export function decodePng(buffer) {
  try {
    const raw = Buffer.from(buffer);
    if (raw.length < 8 || !raw.subarray(0, 8).equals(SIGNATURE)) return null;

    let offset = 8;
    let header = null;
    let palette = null;
    const idat = [];
    while (offset + 8 <= raw.length) {
      const length = raw.readUInt32BE(offset);
      const type = raw.toString('ascii', offset + 4, offset + 8);
      const data = raw.subarray(offset + 8, offset + 8 + length);
      if (type === 'IHDR') {
        header = {
          width: data.readUInt32BE(0),
          height: data.readUInt32BE(4),
          bitDepth: data[8],
          colorType: data[9],
          interlace: data[12],
        };
      } else if (type === 'PLTE') {
        palette = Buffer.from(data);
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
      offset += 12 + length; // length + type + data + crc
    }
    if (!header || !idat.length) return null;
    if (header.bitDepth !== 8 || header.interlace !== 0) return null;
    const channels = CHANNELS[header.colorType];
    if (!channels) return null;
    if (header.colorType === 3 && !palette) return null;

    const inflated = zlib.inflateSync(Buffer.concat(idat));
    const stride = header.width * channels;
    const pixels = Buffer.alloc(stride * header.height);
    let pos = 0;
    for (let y = 0; y < header.height; y++) {
      const filter = inflated[pos++];
      const line = inflated.subarray(pos, pos + stride);
      pos += stride;
      const out = pixels.subarray(y * stride, (y + 1) * stride);
      const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
      for (let x = 0; x < stride; x++) {
        const left = x >= channels ? out[x - channels] : 0;
        const up = prev ? prev[x] : 0;
        const upLeft = prev && x >= channels ? prev[x - channels] : 0;
        const value = line[x];
        switch (filter) {
          case 0: out[x] = value; break;
          case 1: out[x] = (value + left) & 0xff; break;
          case 2: out[x] = (value + up) & 0xff; break;
          case 3: out[x] = (value + ((left + up) >> 1)) & 0xff; break;
          case 4: out[x] = (value + paeth(left, up, upLeft)) & 0xff; break;
          default: return null; // unknown filter byte → not something we understand
        }
      }
    }

    // Palette → RGB, and drop an unused alpha channel so analysis is uniform.
    if (header.colorType === 3) {
      const rgb = Buffer.alloc(header.width * header.height * 3);
      for (let i = 0; i < header.width * header.height; i++) {
        const idx = pixels[i] * 3;
        rgb[i * 3] = palette[idx] ?? 0;
        rgb[i * 3 + 1] = palette[idx + 1] ?? 0;
        rgb[i * 3 + 2] = palette[idx + 2] ?? 0;
      }
      return { width: header.width, height: header.height, channels: 3, pixels: rgb };
    }

    return { width: header.width, height: header.height, channels, pixels };
  } catch {
    return null;
  }
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Is this image effectively black/empty? Returns
 *   { blank, mean, max, distinct, width, height }  (blank=false when unknown)
 */
export function imageStats(buffer, { sampleLimit = 20_000 } = {}) {
  const decoded = decodePng(buffer);
  if (!decoded) return { blank: false, unknown: true, mean: null, max: null, distinct: null };
  const { width, height, channels, pixels } = decoded;
  const total = width * height;
  const step = Math.max(1, Math.floor(total / sampleLimit));

  let sum = 0;
  let count = 0;
  let max = 0;
  let min = 255;
  const seen = new Set();
  for (let i = 0; i < total; i += step) {
    const base = i * channels;
    let r;
    let g;
    let b;
    if (channels <= 2) {
      r = g = b = pixels[base];
    } else {
      r = pixels[base];
      g = pixels[base + 1];
      b = pixels[base + 2];
    }
    const value = luma(r, g, b);
    sum += value;
    count += 1;
    if (value > max) max = value;
    if (value < min) min = value;
    if (seen.size < 64) seen.add(`${r},${g},${b}`);
  }
  const mean = count ? sum / count : 0;
  const blank = mean < 5 && max < 18;
  return {
    blank,
    mean: Math.round(mean * 10) / 10,
    max: Math.round(max),
    min: Math.round(min),
    distinct: seen.size,
    width,
    height,
  };
}

/**
 * A compact fingerprint of what is on the screen: sample a grid of pixels.
 * Used to answer "did the screen actually change?" without OCR, vision models
 * or sending anything anywhere. Returns null when the PNG can't be decoded.
 */
export function imageSignature(buffer, { cols = 40, rows = 24 } = {}) {
  const decoded = decodePng(buffer);
  if (!decoded) return null;
  const { width, height, channels, pixels } = decoded;
  if (!width || !height) return null;
  const out = new Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    const y = Math.min(height - 1, Math.floor(((row + 0.5) / rows) * height));
    for (let col = 0; col < cols; col++) {
      const x = Math.min(width - 1, Math.floor(((col + 0.5) / cols) * width));
      const base = (y * width + x) * channels;
      let r;
      let g;
      let b;
      if (channels <= 2) {
        r = g = b = pixels[base];
      } else {
        r = pixels[base];
        g = pixels[base + 1];
        b = pixels[base + 2];
      }
      out[row * cols + col] = Math.round(luma(r, g, b));
    }
  }
  return { cols, rows, samples: out };
}

/**
 * 0 = completely different, 1 = pixel-identical (on the sampled grid).
 * Null when either signature is missing.
 */
export function imageSimilarity(a, b) {
  if (!a?.samples || !b?.samples || a.samples.length !== b.samples.length) return null;
  let total = 0;
  for (let i = 0; i < a.samples.length; i++) total += Math.abs(a.samples[i] - b.samples[i]);
  return 1 - total / a.samples.length / 255;
}

/**
 * Did the screen meaningfully change? `threshold` 0.995 means "more than 0.5%
 * of average brightness moved" — enough to ignore a blinking cursor but see a
 * page load.
 */
export function screenChanged(before, after, threshold = 0.995) {
  const similarity = imageSimilarity(before, after);
  if (similarity == null) return { known: false, changed: false, similarity: null };
  return { known: true, changed: similarity < threshold, similarity };
}

/** Human one-liner, handy in /doctor and logs. */
export function describeImage(buffer) {
  const s = imageStats(buffer);
  if (s.unknown) return 'could not inspect the image';
  return `${s.width}×${s.height} · brightness ${s.mean}/255${s.blank ? ' · ⚠️ blank/black' : ''}`;
}
