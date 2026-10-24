// Small mobile API primitives. No desktop, provider or credential imports.
import { createHmac, randomBytes } from 'node:crypto';
export function createApprovalBroker({ candidates, resolve, now = Date.now, busy = () => false }) {
  const secret = randomBytes(32), identities = new WeakMap();
  function current() {
    return candidates().filter((p) => p && p.value && Number.isFinite(p.expiresAt) && p.expiresAt > now()).map((p) => {
      let nonce = p.nonce || identities.get(p.value);
      if (!nonce) { nonce = randomBytes(16).toString('hex'); identities.set(p.value, nonce); }
      const id = createHmac('sha256', secret).update(`${p.kind}\0${nonce}\0${JSON.stringify(p.value)}`).digest('hex');
      return { ...p, id };
    });
  }
  return {
    list: () => current().map(({ id, kind, text, expiresAt }) => ({ id, kind, text: String(text).slice(0, 1500), expiresAt })),
    decide(id, approve) {
      if (busy()) return { busy: true, stale: false };
      if (typeof id !== 'string' || typeof approve !== 'boolean') return { stale: true };
      const candidate = current().find((p) => p.id === id);
      if (!candidate) return { stale: true };
      // resolve is invoked synchronously after matching, BEFORE any await. It
      // must consume the original pending request before its first async work.
      return { stale: false, reply: resolve(candidate.kind, approve) };
    },
  };
}
export function createAppMedia({ now = Date.now, maxBytes = 48 * 1024 * 1024, maxItem = 12 * 1024 * 1024, ttl = 5 * 60_000 } = {}) {
  const entries = new Map(); let bytes = 0;
  const remove = (id) => { const item = entries.get(id); if (item) { bytes -= item.buffer.length; entries.delete(id); } };
  const prune = () => { for (const [id, item] of entries) if (item.expires <= now()) remove(id); };
  const add = (buffer, name, mime) => {
    prune(); if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > Math.min(maxItem, maxBytes)) return null;
    while (bytes + buffer.length > maxBytes || entries.size >= 16) remove(entries.keys().next().value);
    const id = randomBytes(16).toString('hex'), clean = String(name || 'attachment').replace(/[\r\n\\/]/g, '_').slice(0, 200);
    entries.set(id, { buffer: Buffer.from(buffer), name: clean, mime, expires: now() + ttl }); bytes += buffer.length;
    return { id, name: clean, mime, size: buffer.length, url: `/api/app/media/${id}` };
  };
  return {
    add,
    get(id) { prune(); return entries.get(id) || null; },
    shape(reply, base) {
      const out = base(reply); if (!reply || typeof reply !== 'object') return out;
      const media = [];
      if (reply.document?.buffer) { const f = add(reply.document.buffer, reply.document.fileName, reply.document.mimetype || 'application/octet-stream'); if (f) media.push(f); else out.text += '\nAttachment exceeds the mobile transfer budget; use the PC Files view.'; }
      if (reply.video) { const f = add(reply.video, reply.videoName || 'recording.mp4', 'video/mp4'); if (f) media.push(f); else out.text += '\nVideo exceeds the mobile transfer budget; use the PC Files view.'; }
      return media.length ? { ...out, media } : out;
    },
    clear() { entries.clear(); bytes = 0; },
    get bytes() { prune(); return bytes; },
  };
}
