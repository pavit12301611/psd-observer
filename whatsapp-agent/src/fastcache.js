// fastcache.js — ⚡ LRU + TTL cache for hot paths (knowledge lookups,
// intent classification, doc answers). Micro-optimizations: Map-based
// (insertion order = LRU order), zero allocations on hit beyond the lookup.

export class FastCache {
  constructor(opts = {}) {
    this.max = opts.max ?? 500;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const hit = this.map.get(key);
    if (hit === undefined) { this.misses++; return undefined; }
    if (hit.expires && hit.expires < Date.now()) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, hit);
    this.hits++;
    return hit.value;
  }

  set(key, value) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, {
      value,
      expires: this.ttlMs > 0 ? Date.now() + this.ttlMs : 0,
    });
    return value;
  }

  wrap(key, fn) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = fn();
    this.set(key, value);
    return value;
  }

  clear() {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats() {
    const total = this.hits + this.misses;
    return { size: this.map.size, hits: this.hits, misses: this.misses, hitRate: total ? this.hits / total : 0 };
  }
}

/** Memoize a pure single-arg fn with an LRU. */
export function memoize(fn, opts = {}) {
  const cache = new FastCache(opts);
  const wrapped = (arg) => cache.wrap(`${typeof arg}:${arg}`, () => fn(arg));
  wrapped.cache = cache;
  return wrapped;
}
