/**
 * A bounded TTL cache with request coalescing.
 *
 * Three properties matter here, and a plain `Map` gives none of them:
 *  1. **Bounded.** Keys are attacker-chosen (any address is a new key), so an
 *     unbounded map is a memory-exhaustion vector. Insertion-ordered eviction
 *     keeps it capped.
 *  2. **Pruned.** Expired entries are dropped on access and on insert, so the
 *     map does not accumulate dead weight between evictions.
 *  3. **Coalescing.** Concurrent misses for the same key share one in-flight
 *     promise. Without this, N simultaneous requests for a popular address
 *     become N upstream calls — the exact spike a cache exists to prevent.
 */
export class TtlCache<TValue> {
  private readonly entries = new Map<string, { value: TValue; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<TValue>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: { ttlMs: number; maxEntries: number }) {
    if (options.ttlMs <= 0) {
      throw new RangeError(`Cache TTL must be positive: ${options.ttlMs}`);
    }
    if (options.maxEntries <= 0) {
      throw new RangeError(`Cache size must be positive: ${options.maxEntries}`);
    }
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries;
  }

  get(key: string, now: number = Date.now()): TValue | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: TValue, now: number = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    this.prune(now);
  }

  /**
   * Returns the cached value, or calls `load` exactly once per key even under
   * concurrent access. A rejected load is not cached.
   */
  async getOrLoad(
    key: string,
    load: () => Promise<TValue>,
    now: number = Date.now(),
  ): Promise<{ value: TValue; cached: boolean }> {
    const cached = this.get(key, now);
    if (cached !== undefined) {
      return { value: cached, cached: true };
    }

    const pending = this.inFlight.get(key);
    if (pending) {
      return { value: await pending, cached: true };
    }

    const promise = load();
    this.inFlight.set(key, promise);
    try {
      const value = await promise;
      this.set(key, value);
      return { value, cached: false };
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Visible for tests and diagnostics. */
  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
    // Map iteration is insertion-ordered, so the first key is the oldest write.
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.entries.delete(oldest.value);
    }
  }
}
