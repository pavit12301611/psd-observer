// webapp.js — generates the installable PWA icon set (pure Node, no deps).
//
// The rest of the app is plain HTML/CSS/JS in ../webapp/ (no build step), so the
// phone can "Add to Home screen" and it opens full-screen like a native app.

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

/**
 * A 512/192 px icon: WhatsApp-green rounded square with an eye.
 * Hand-drawn per pixel — keeps the repo dependency-free and the PWA installable
 * (Chrome/Safari require real PNG icons).
 */
export function iconPng(size = 512) {
  const s = Math.max(48, Math.min(1024, Math.round(size)));
  const bg = [7, 94, 84];
  const accent = [37, 211, 102];
  const white = [240, 248, 246];
  const radius = s * 0.22;
  const cx = s / 2;
  const cy = s / 2;
  const raw = Buffer.alloc(s * (s * 4 + 1));
  let offset = 0;
  for (let y = 0; y < s; y++) {
    raw[offset++] = 0; // PNG filter: none
    for (let x = 0; x < s; x++) {
      // rounded-corner alpha
      let alpha = 255;
      const dxCorner = Math.max(radius - x, x - (s - 1 - radius), 0);
      const dyCorner = Math.max(radius - y, y - (s - 1 - radius), 0);
      if (dxCorner > 0 && dyCorner > 0 && dxCorner * dxCorner + dyCorner * dyCorner > radius * radius) alpha = 0;

      let [r, g, b] = bg;
      // Eye sclera: wide ellipse
      const ex = (x - cx) / (s * 0.36);
      const ey = (y - cy) / (s * 0.22);
      if (ex * ex + ey * ey <= 1) [r, g, b] = white;
      // Iris
      const ix = (x - cx) / (s * 0.135);
      const iy = (y - cy) / (s * 0.135);
      if (ix * ix + iy * iy <= 1) [r, g, b] = bg;
      // Pupil highlight
      const px = (x - cx + s * 0.035) / (s * 0.055);
      const py = (y - cy + s * 0.035) / (s * 0.055);
      if (px * px + py * py <= 1) [r, g, b] = accent;

      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = alpha;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(s, 0);
  ihdr.writeUInt32BE(s, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const iconCache = new Map();
export function cachedIcon(size) {
  if (!iconCache.has(size)) iconCache.set(size, iconPng(size));
  return iconCache.get(size);
}
