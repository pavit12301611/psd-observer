import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { INTENT_LABELS } from './dataset.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
export const dataDirectory = (opts = {}) => path.resolve(opts.dataDir || DEFAULT_DATA_DIR);
export const trustedExample = (x) => x?.source === 'owner' && x?.verified === true
  && typeof x.t === 'string' && x.t.trim().length > 0 && x.t.length <= 300 && INTENT_LABELS.includes(x.label);

export function readExamples(dataDir = DEFAULT_DATA_DIR) {
  try {
    const all = JSON.parse(fs.readFileSync(path.join(dataDir, 'neural-examples.json'), 'utf8'));
    return Array.isArray(all) ? all.slice(-2000) : [];
  } catch { return []; }
}

/** Same-filesystem rename: readers see the old OR the complete new file. */
export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed/not created */ }
  }
  return file;
}
