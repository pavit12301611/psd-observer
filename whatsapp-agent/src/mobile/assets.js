import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
export function createAssets({ dir, now = Date.now, maxBytes = 128 * 1024 * 1024 } = {}) {
  const items = new Map(); let total = 0;
  if (dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); for (const name of fs.readdirSync(dir)) { if (!/^[a-f0-9]{32}\.bin$/.test(name)) continue; const full = path.join(dir, name), stat = fs.lstatSync(full); if (!stat.isFile() || stat.isSymbolicLink()) continue; items.set(name.slice(0, 32), { file: full, size: stat.size, ts: stat.mtimeMs }); total += stat.size; } }
  const remove = (id) => { const p = items.get(id); if (!p) return; if (p.file) fs.unlinkSync(p.file); total -= p.size; items.delete(id); };
  function trim() { for (const [id, item] of items) if (now() - item.ts > 48 * 3600_000) remove(id); while (total > maxBytes && items.size) remove(items.keys().next().value); }
  return {
    add(buffer, name, mime, kind) {
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 12 * 1024 * 1024) return null;
      trim(); while (total + buffer.length > maxBytes && items.size) remove(items.keys().next().value);
      const id = randomBytes(16).toString('hex'); const file = dir ? path.join(dir, id + '.bin') : null;
      if (file) fs.writeFileSync(file, buffer, { mode: 0o600, flag: 'wx' });
      items.set(id, { file, buffer: file ? null : Buffer.from(buffer), size: buffer.length, ts: now() }); total += buffer.length;
      return { id, name: String(name || 'attachment').replace(/[\\/\r\n]/g, '_').slice(0, 160), mime, kind, size: buffer.length, url: '/api/app/assets/' + id };
    },
    get(id) { trim(); const p = items.get(id); if (!p) return null; return p.file ? fs.readFileSync(p.file) : p.buffer; },
    shape(reply, base) {
      const out = base(reply); if (!reply || typeof reply !== 'object') return out;
      delete out.images; delete out.audio;
      const media = [];
      const add = (buffer, name, mime, kind) => { const item = this.add(buffer, name, mime, kind); if (item) media.push(item); else out.text += '\nAn attachment exceeded the mobile budget; inspect Files on the PC.'; };
      if (reply.image) add(reply.image, 'image.png', 'image/png', 'image');
      for (const img of (reply.extraImages || []).slice(0, 3)) add(img, 'image.png', 'image/png', 'image');
      if (reply.audio) add(reply.audio, 'reply-audio', (reply.mimetype || 'audio/ogg').split(';')[0], 'audio');
      if (reply.document?.buffer) add(reply.document.buffer, reply.document.fileName, reply.document.mimetype || 'application/octet-stream', 'document');
      if (reply.video) add(reply.video, 'recording.mp4', 'video/mp4', 'video');
      for (const k of ['stopped', 'awaitingConfirm', 'ended', 'needsConfirmation']) if (typeof reply[k] === 'boolean') out[k] = reply[k];
      if (media.length) out.media = media;
      return out;
    },
  };
}
