import fs from 'node:fs';
import path from 'node:path';
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

// Kept as a public re-export for existing neural callers.
export { atomicJSON } from '../persistence.js';
