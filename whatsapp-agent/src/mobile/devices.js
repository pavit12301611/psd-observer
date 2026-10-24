import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { records, error, short } from './records.js';
const hash = (value) => createHash('sha256').update(String(value)).digest('hex');
export function equal(a, b) { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))); }
export function createDevices({ file, now = Date.now } = {}) {
  const db = records(file, { schema: 1, serverId: randomBytes(16).toString('hex'), devices: [] });
  if (db.value.schema !== 1 || !Array.isArray(db.value.devices) || !/^[a-f0-9]{32}$/.test(db.value.serverId)) throw new Error('Invalid device registry');
  const codes = new Map();
  const publicDevice = ({ tokenHash: _hash, pushToken: _push, ...device }) => ({ ...device, pushRegistered: Boolean(_push) });
  return {
    serverId: db.value.serverId,
    code(origin) {
      const code = randomBytes(24).toString('base64url');
      for (const [key, item] of codes) if (item.expires <= now()) codes.delete(key);
      if (codes.size >= 6) codes.delete(codes.keys().next().value);
      codes.set(hash(code), { expires: now() + 120_000 });
      return { origin, code, serverId: db.value.serverId, expiresAt: now() + 120_000, protocol: 2 };
    },
    consumeCode(code) {
      const key = hash(code), entry = codes.get(key);
      if (!entry || entry.expires <= now()) { codes.delete(key); return false; }
      codes.delete(key); return true;
    },
    register({ name, model, clientId }) {
      if (typeof clientId !== 'string' || !/^[a-f0-9-]{16,100}$/i.test(clientId)) throw error(400, 'A valid device identity is required');
      if (db.value.devices.filter((d) => !d.revokedAt).length >= 20) throw error(409, 'Revoke an unused device before pairing another');
      const token = randomBytes(32).toString('base64url'), id = randomBytes(12).toString('hex');
      const record = { id, clientId, name: short(name || model || 'Android device', 80), model: short(model, 80), tokenHash: hash(token), createdAt: now(), revokedAt: null, pushToken: null };
      db.update((data) => { for (const d of data.devices) if (d.clientId === clientId) { d.revokedAt = now(); d.pushToken = null; } data.devices.push(record); data.devices = data.devices.slice(-100); return data; });
      return { token, device: publicDevice(record), serverId: db.value.serverId };
    },
    authenticate(token) {
      if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
      const digest = hash(token);
      const device = db.value.devices.find((d) => !d.revokedAt && equal(d.tokenHash, digest));
      return device ? { id: device.id, name: device.name, kind: 'device' } : null;
    },
    list() { return db.value.devices.map(publicDevice); },
    revoke(id) {
      if (!db.value.devices.some((d) => d.id === id)) throw error(404, 'Device not found');
      db.update((data) => { const d = data.devices.find((d) => d.id === id); d.revokedAt = now(); d.pushToken = null; return data; });
      return { ok: true };
    },
    push(id, token) {
      if (typeof token !== 'string' || token.length > 4096) throw error(400, 'Invalid push registration');
      db.update((data) => { const d = data.devices.find((d) => d.id === id && !d.revokedAt); if (!d) throw error(401, 'Active device session required'); d.pushToken = token || null; return data; });
      return { ok: true };
    },
    pushTargets() { return db.value.devices.filter((d) => !d.revokedAt && d.pushToken).map((d) => ({ id: d.id, token: d.pushToken })); },
    clear() { codes.clear(); },
  };
}
