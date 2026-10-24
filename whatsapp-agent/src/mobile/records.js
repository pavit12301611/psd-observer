import fs from 'node:fs';
import { atomicJSON } from '../persistence.js';

export function records(file, defaults, { maxBytes = 8 * 1024 * 1024 } = {}) {
  let data = structuredClone(defaults);
  if (file && fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Unsafe or oversized mobile state file');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid mobile state');
    data = parsed;
  }
  return {
    get value() { return data; },
    replace(next) {
      const copy = structuredClone(next), encoded = JSON.stringify(copy);
      if (Buffer.byteLength(encoded) > maxBytes) throw Object.assign(new Error('Mobile state budget exceeded; export/clear old records first'), { status: 507 });
      if (file) atomicJSON(file, copy);
      data = copy; return data;
    },
    update(fn) { return this.replace(fn(structuredClone(data))); },
  };
}
export const error = (status, message) => Object.assign(new Error(message), { status });
export const short = (value, max = 4000) => String(value ?? '').slice(0, max);
export const validId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_-]{8,100}$/.test(id);
