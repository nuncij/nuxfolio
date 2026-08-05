import { describe, expect, it } from 'vitest';

import { BUNDLE_MEMBER_CONCURRENCY, fetchBundleMembers } from './portfolioClient';

/**
 * The concurrency bound, tested as concurrency.
 *
 * The plan for this feature originally justified its design with a request *count*,
 * and that reasoning turned out to be wrong — the limit it cited is overridden by
 * another default ten lines away in the same file. What actually needed bounding was
 * how many wallets are in flight at once, because each one makes the server scan five
 * networks at its own concurrency and nothing above that was per bundle.
 *
 * So these tests watch peak simultaneous loads. Counting requests is exactly what made
 * the wrong argument look sound.
 */

const ADDRESSES = Array.from(
  { length: 10 },
  (_, index) => `0x${index.toString(16).padStart(40, '0')}`,
);

/** A fetch stub that records how many calls are in flight at once. */
function trackingFetch(options: { failFor?: readonly string[] } = {}) {
  let inFlight = 0;
  let peak = 0;
  const order: string[] = [];
  const release: (() => void)[] = [];

  const fetchImpl: typeof globalThis.fetch = (input) => {
    const url = String(input);
    order.push(url);
    inFlight += 1;
    peak = Math.max(peak, inFlight);

    return new Promise((resolve) => {
      release.push(() => {
        inFlight -= 1;
        const failing = options.failFor?.some((address) =>
          url.toLowerCase().includes(address.toLowerCase()),
        );
        resolve(
          failing === true
            ? new Response(
                JSON.stringify({ error: { code: 'upstream-unavailable', message: 'down' } }),
                { status: 503, headers: { 'content-type': 'application/json' } },
              )
            : new Response(JSON.stringify({ aggregate: aggregatePayload(url), cached: false }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              }),
        );
      });
    });
  };

  return {
    fetchImpl,
    peak: () => peak,
    inFlight: () => inFlight,
    pending: () => release.length,
    /** Lets every currently-started request finish. */
    flush: async () => {
      const waiting = release.splice(0, release.length);
      for (const resolve of waiting) {
        resolve();
      }
      // Let the workers pick up their next item.
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    order: () => [...order],
  };
}

function aggregatePayload(url: string): unknown {
  const address = new URL(url, 'http://localhost').searchParams.get('address') ?? ADDRESSES[0];
  return {
    address,
    totalValueUsd: '1.00000000',
    assetCount: 0,
    pricedAssetCount: 0,
    unpricedAssetCount: 0,
    suspectAssetCount: 0,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    chains: [],
    failedChains: [],
    fxRate: null,
    fetchedAt: '2026-08-03T12:00:00.000Z',
  };
}

describe('fetchBundleMembers concurrency', () => {
  it('never has more than the bound in flight, for ten wallets', async () => {
    const tracker = trackingFetch();

    const loading = fetchBundleMembers({ addresses: ADDRESSES, fetchImpl: tracker.fetchImpl });

    // Let the workers start.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tracker.inFlight()).toBe(BUNDLE_MEMBER_CONCURRENCY);

    // Drain in waves, checking the bound holds every time rather than only at the start.
    for (let wave = 0; wave < ADDRESSES.length; wave += 1) {
      await tracker.flush();
      expect(tracker.inFlight()).toBeLessThanOrEqual(BUNDLE_MEMBER_CONCURRENCY);
    }

    await loading;
    expect(tracker.peak()).toBe(BUNDLE_MEMBER_CONCURRENCY);
    // Ten wallets, ten requests — one per member, not one per member per network.
    expect(tracker.order()).toHaveLength(ADDRESSES.length);
  });

  it('asks for every network in one request per wallet', async () => {
    const tracker = trackingFetch();
    const loading = fetchBundleMembers({
      addresses: ADDRESSES.slice(0, 3),
      fetchImpl: tracker.fetchImpl,
    });
    for (let wave = 0; wave < 3; wave += 1) {
      await tracker.flush();
    }
    await loading;

    for (const url of tracker.order()) {
      expect(url).toContain('chainId=all');
    }
  });

  it('reports every member, and settles once all have', async () => {
    const tracker = trackingFetch();
    const settled: string[] = [];

    const loading = fetchBundleMembers({
      addresses: ADDRESSES.slice(0, 4),
      onSettled: (load) => settled.push(load.address),
      fetchImpl: tracker.fetchImpl,
    });
    for (let wave = 0; wave < 4; wave += 1) {
      await tracker.flush();
    }
    const results = await loading;

    expect(results).toHaveLength(4);
    expect(settled).toHaveLength(4);
  });

  it('keeps loading the rest when one wallet fails', async () => {
    // A failure is one member's problem. The bundle still shows the others.
    const failing = ADDRESSES[1] as string;
    const tracker = trackingFetch({ failFor: [failing] });

    const loading = fetchBundleMembers({
      addresses: ADDRESSES.slice(0, 3),
      fetchImpl: tracker.fetchImpl,
    });
    for (let wave = 0; wave < 3; wave += 1) {
      await tracker.flush();
    }
    const results = await loading;

    expect(results).toHaveLength(3);
    const failed = results.find((load) => load.address === failing);
    expect(failed?.result).toMatchObject({ ok: false });
    expect(results.filter((load) => load.address !== failing).every((load) => load.result)).toBe(
      true,
    );
  });

  it('honours a lower bound when one is passed', async () => {
    const tracker = trackingFetch();
    const loading = fetchBundleMembers({
      addresses: ADDRESSES,
      concurrency: 1,
      fetchImpl: tracker.fetchImpl,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tracker.inFlight()).toBe(1);

    for (let wave = 0; wave < ADDRESSES.length; wave += 1) {
      await tracker.flush();
    }
    await loading;
    expect(tracker.peak()).toBe(1);
  });

  it('does nothing for an empty bundle', async () => {
    const tracker = trackingFetch();
    expect(await fetchBundleMembers({ addresses: [], fetchImpl: tracker.fetchImpl })).toEqual([]);
    expect(tracker.order()).toEqual([]);
  });

  it('starts no more workers than there are wallets', async () => {
    const tracker = trackingFetch();
    const loading = fetchBundleMembers({
      addresses: ADDRESSES.slice(0, 1),
      fetchImpl: tracker.fetchImpl,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tracker.inFlight()).toBe(1);
    await tracker.flush();
    await loading;
  });
});
