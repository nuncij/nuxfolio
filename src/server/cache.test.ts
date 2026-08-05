import { describe, expect, it, vi } from 'vitest';

import { TtlCache } from './cache';

describe('TtlCache', () => {
  it('returns a value inside its TTL', () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('a', 'value', 0);
    expect(cache.get('a', 999)).toBe('value');
  });

  it('treats a value as absent once its TTL has elapsed', () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('a', 'value', 0);
    expect(cache.get('a', 1000)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it('keys entries independently', () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, maxEntries: 10 });
    cache.set('1:0xabc', 'first', 0);
    cache.set('1:0xdef', 'second', 0);
    expect(cache.get('1:0xabc', 0)).toBe('first');
    expect(cache.get('1:0xdef', 0)).toBe('second');
  });

  it('evicts the oldest entry rather than growing without bound', () => {
    const cache = new TtlCache<string>({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', '1', 0);
    cache.set('b', '2', 0);
    cache.set('c', '3', 0);

    expect(cache.size()).toBe(2);
    expect(cache.get('a', 0)).toBeUndefined();
    expect(cache.get('c', 0)).toBe('3');
  });

  it('drops expired entries on write, so dead weight does not accumulate', () => {
    const cache = new TtlCache<string>({ ttlMs: 1000, maxEntries: 100 });
    cache.set('a', '1', 0);
    cache.set('b', '2', 5_000);
    expect(cache.size()).toBe(1);
  });

  it('rejects a non-positive TTL or size', () => {
    expect(() => new TtlCache({ ttlMs: 0, maxEntries: 1 })).toThrow(RangeError);
    expect(() => new TtlCache({ ttlMs: 1, maxEntries: 0 })).toThrow(RangeError);
  });

  describe('getOrLoad', () => {
    it('loads on a miss and reports the value as fresh', async () => {
      const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 10 });
      const load = vi.fn(() => Promise.resolve(1));

      const result = await cache.getOrLoad('a', load);

      expect(result).toEqual({ value: 1, cached: false });
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('serves a second call from the cache without loading again', async () => {
      const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 10 });
      const load = vi.fn(() => Promise.resolve(1));

      await cache.getOrLoad('a', load);
      const second = await cache.getOrLoad('a', load);

      expect(second).toEqual({ value: 1, cached: true });
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent misses into a single load', async () => {
      const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 10 });
      let resolve: ((value: number) => void) | undefined;
      const load = vi.fn(
        () =>
          new Promise<number>((innerResolve) => {
            resolve = innerResolve;
          }),
      );

      const first = cache.getOrLoad('a', load);
      const second = cache.getOrLoad('a', load);
      resolve?.(5);

      expect(await first).toEqual({ value: 5, cached: false });
      expect(await second).toEqual({ value: 5, cached: true });
      // Without coalescing this would be 2 — and 2 upstream calls.
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failed load, and lets the next caller retry', async () => {
      const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 10 });
      const load = vi
        .fn<() => Promise<number>>()
        .mockRejectedValueOnce(new Error('upstream down'))
        .mockResolvedValueOnce(9);

      await expect(cache.getOrLoad('a', load)).rejects.toThrow('upstream down');
      expect(cache.size()).toBe(0);

      await expect(cache.getOrLoad('a', load)).resolves.toEqual({ value: 9, cached: false });
    });

    it('propagates a shared failure to every coalesced caller', async () => {
      const cache = new TtlCache<number>({ ttlMs: 1000, maxEntries: 10 });
      const load = vi.fn(() => Promise.reject(new Error('boom')));

      const first = cache.getOrLoad('a', load);
      const second = cache.getOrLoad('a', load);

      await expect(first).rejects.toThrow('boom');
      await expect(second).rejects.toThrow('boom');
      expect(load).toHaveBeenCalledTimes(1);
    });
  });
});
