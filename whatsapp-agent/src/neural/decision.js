// Shared by training/evaluation and runtime: exactly the same top-k voting
// and confidence rules. A neural probability for A is never confidence in B.
import { INTENT_LABELS } from './dataset.js';
import { textFeatures } from './text.js';

export const exampleKey = (text) => String(text ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
export const sparseIndices = (vec) => {
  const out = [];
  for (let i = 0; i < vec.length; i++) if (vec[i] !== 0) out.push(i);
  return out;
};

export function makeMemory(examples) {
  // Last explicit correction wins over an older/builtin label for that text.
  const unique = new Map(examples.map((x) => [exampleKey(x.t), x]));
  const memory = [...unique].map(([key, ex]) => ({ key, label: ex.label, vec: Float32Array.from(textFeatures(ex.t)) }));
  memoryIndex(memory);
  return memory;
}

// Text vectors are very sparse. An inverted index visits only stored nonzero
// features rather than doing memorySize × queryDimensions random reads.
// Float64 accumulation + ascending feature order preserve the scan's math.
const indexes = new WeakMap();
function memoryIndex(memory) {
  const cached = indexes.get(memory);
  if (cached?.length === memory.length) return cached.postings;
  const dim = memory[0]?.vec.length ?? 0;
  const postings = Array.from({ length: dim }, () => ({ ids: [], values: [] }));
  for (let id = 0; id < memory.length; id++) {
    const vec = memory[id].vec;
    for (let j = 0; j < vec.length; j++) if (vec[j] !== 0) {
      postings[j].ids.push(id); postings[j].values.push(vec[j]);
    }
  }
  for (const p of postings) { p.ids = Uint32Array.from(p.ids); p.values = Float64Array.from(p.values); }
  indexes.set(memory, { length: memory.length, postings });
  return postings;
}

export function nearestIntent(vec, memory, k = 5, sparse = sparseIndices(vec)) {
  const top = [];
  k = Math.min(20, Math.max(1, Math.floor(k) || 5));
  const postings = memoryIndex(memory);
  const sims = new Float64Array(memory.length);
  for (const j of sparse) {
    const p = postings[j];
    if (!p) continue;
    const weight = vec[j];
    for (let i = 0; i < p.ids.length; i++) sims[p.ids[i]] += weight * p.values[i];
  }
  for (let id = 0; id < memory.length; id++) {
    const m = memory[id], sim = sims[id];
    if (top.length < k || sim > top[top.length - 1].sim) {
      let j = top.length - 1;
      while (j >= 0 && top[j].sim < sim) { top[j + 1] = top[j]; j--; }
      top[j + 1] = { label: m.label, sim };
      if (top.length > k) top.pop();
    }
  }
  if (!top.length || top[0].sim < 0.45) return null;
  if (top[0].sim >= 0.99999) return { label: top[0].label, similarity: 1, support: 1, exact: true };
  const votes = new Map();
  let total = 0;
  for (const t of top) {
    const w = Math.max(0, t.sim) ** 2;
    votes.set(t.label, (votes.get(t.label) ?? 0) + w); total += w;
  }
  const [label, w] = [...votes].sort((a, b) => b[1] - a[1])[0];
  // Similarity belongs to the WINNING label, not a different nearest neighbour.
  return { label, similarity: top.find((t) => t.label === label).sim, support: w / (total || 1), exact: false };
}

export function calibratedScores(out, temperature = 1) {
  const logs = out.map((p) => Math.log(Math.max(1e-12, p)) / temperature);
  const max = Math.max(...logs);
  const p = logs.map((x) => Math.exp(x - max));
  const sum = p.reduce((a, b) => a + b, 0);
  return p.map((x) => x / sum);
}

export function decideIntent(out, near, { temperature = 1 } = {}) {
  const probs = calibratedScores(out, temperature);
  const order = probs.map((p, i) => [i, p]).sort((a, b) => b[1] - a[1]);
  const [i, p] = order[0];
  let label = INTENT_LABELS[i];
  let confidence = p;
  let source = 'neural';
  let margin = p - order[1][1];
  if (near && (near.exact || (near.similarity >= 0.8 && near.support >= 0.5)
    || (p < 0.65 && near.similarity >= 0.55 && near.support >= 0.6))) {
    label = near.label;
    confidence = near.exact ? 1 : Math.min(0.99, near.similarity * (0.8 + 0.2 * near.support));
    margin = near.support - (1 - near.support);
    source = 'neural+knn';
  }
  return {
    label, confidence, source, margin,
    uncertain: confidence < 0.6 || margin < 0.12,
    scores: Object.freeze(Object.fromEntries(INTENT_LABELS.map((label, j) => [label, probs[j]]))),
  };
}
