// Bounded LRU + TTL. A hit refreshes recency, never the expiry deadline.
export class FastCache {
  constructor(opts = {}) {
    this.max = opts.max ?? 500;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    if (!Number.isSafeInteger(this.max) || this.max < 0) throw new RangeError('Cache max must be a non-negative safe integer');
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 0) throw new RangeError('Cache ttlMs must be finite and non-negative');
    if (typeof this.now !== 'function') throw new TypeError('Cache now must be a function');
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const hit = this.map.get(key);
    if (hit === undefined) { this.misses++; return undefined; }
    if (hit.expires !== null && hit.expires <= this.now()) {
      this.map.delete(key); this.misses++; return undefined;
    }
    this.map.delete(key); this.map.set(key, hit);
    this.hits++;
    return hit.value;
  }

  set(key, value) {
    this.map.delete(key);
    if (!this.max) return value;
    this.map.set(key, { value, expires: this.ttlMs > 0 ? this.now() + this.ttlMs : null });
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return value;
  }

  wrap(key, fn) {
    const cached = this.get(key);
    if (cached !== undefined || this.map.has(key)) return cached;
    const value = fn();
    this.set(key, value);
    if (value && typeof value.then === 'function') {
      // Do not permanently memoize a transient rejection or erase a newer
      // replacement when an older in-flight request eventually fails.
      Promise.resolve(value).catch(() => {
        if (this.map.get(key)?.value === value) this.map.delete(key);
      });
    }
    return value;
  }

  clear() { this.map.clear(); this.hits = 0; this.misses = 0; }

  stats() {
    const total = this.hits + this.misses;
    return { size: this.map.size, hits: this.hits, misses: this.misses, hitRate: total ? this.hits / total : 0 };
  }
}

/** Single-argument memoization: references/symbols are identities, not strings. */
export function memoize(fn, opts = {}) {
  const cache = new FastCache(opts), negativeZero = Symbol('negative zero');
  const wrapped = (arg) => cache.wrap(Object.is(arg, -0) ? negativeZero : arg, () => fn(arg));
  wrapped.cache = cache;
  return wrapped;
}
