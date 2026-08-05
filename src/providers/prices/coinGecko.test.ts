import { describe, expect, it } from 'vitest';

import {
  createFetchStub,
  createRecordingLogger,
  createTestChain,
  createTestContext,
  jsonResponse,
  USDC,
  WETH,
} from '@/test/helpers';

import { Deadline } from '@/server/deadline';

import { priceRefKey, type PriceRef } from '../types';

import { createCoinGeckoVerifier } from './coinGecko';

const API_KEY = 'CG-test-key-value-not-real';

const USDC_REF: PriceRef = { chainId: 1, contractAddress: USDC };
const WETH_REF: PriceRef = { chainId: 1, contractAddress: WETH };
const NATIVE_REF: PriceRef = { chainId: 1, contractAddress: null };

function verifier() {
  return createCoinGeckoVerifier({ apiKey: API_KEY });
}

describe('coingecko price verifier', () => {
  it('returns a second opinion keyed by the domain ref', async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({
        [USDC.toLowerCase()]: { usd: 0.9996, last_updated_at: 1_785_500_540 },
      }),
    );

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.providerId).toBe('coingecko');
    expect(lookup.quotes.get(priceRefKey(USDC_REF))).toEqual({
      priceUsd: '0.9996',
      updatedAt: new Date(1_785_500_540 * 1000).toISOString(),
      // CoinGecko reports no confidence score; claiming 1.0 would assert a
      // certainty the source never offered.
      confidence: null,
    });
    expect(calls).toHaveLength(1);
  });

  it('sends the key as a header, never in the URL', async () => {
    // A URL reaches error messages, proxy logs and referrers. A credential must
    // not travel in one.
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}));

    await verifier().verify({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(calls[0]?.url).not.toContain(API_KEY);
    expect(calls[0]?.url).not.toContain('api_key');
  });

  it('keeps the key and the wallet contracts out of the logs', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({}, { status: 500 }));
    const { logger, lines } = createRecordingLogger('debug', [API_KEY]);

    await expect(
      verifier().verify({
        chain: createTestChain(),
        refs: [USDC_REF],
        context: createTestContext(fetchImpl, { logger }),
      }),
    ).rejects.toThrow();

    const output = lines.join('\n');
    expect(output).not.toContain(API_KEY);
    expect(output).not.toContain(USDC);
  });

  it('keeps the contract out of the logs when the response shape is what failed', async () => {
    // A distinct path from an HTTP error: the addresses are the *keys* of the
    // response object, so a schema error names them in its issue paths and those
    // paths travel into the error message. The 500 case above never exercised it,
    // which is how the gap stayed invisible.
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({ [USDC.toLowerCase()]: { usd: 'free' } }),
    );
    const { logger, lines } = createRecordingLogger('debug', [API_KEY]);

    await expect(
      verifier().verify({
        chain: createTestChain(),
        refs: [USDC_REF],
        context: createTestContext(fetchImpl, { logger }),
      }),
    ).rejects.toThrow();

    const output = lines.join('\n');
    expect(output).not.toContain(API_KEY);
    // Neither casing: the response lowercases what our refs checksum.
    expect(output).not.toContain(USDC);
    expect(output.toLowerCase()).not.toContain(USDC.toLowerCase());
  });

  it('matches the response back regardless of address casing', async () => {
    const { fetchImpl } = createFetchStub(() =>
      // CoinGecko lowercases; our refs are checksummed.
      jsonResponse({ [USDC.toUpperCase()]: { usd: 1 } }),
    );

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.get(priceRefKey(USDC_REF))?.priceUsd).toBe('1');
  });

  it('prices the native asset by coin id, on its own endpoint', async () => {
    // A live run showed the native asset is effectively the whole holding on Base,
    // Arbitrum and OP Mainnet. Skipping it left the most material price on three of
    // five chains permanently unverifiable.
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({ ethereum: { usd: 1882.49, last_updated_at: 1_785_500_540 } }),
    );

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs: [NATIVE_REF],
      context: createTestContext(fetchImpl),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/simple/price?');
    expect(calls[0]?.url).toContain('ids=ethereum');
    expect(lookup.quotes.get(priceRefKey(NATIVE_REF))).toEqual({
      priceUsd: '1882.49',
      updatedAt: new Date(1_785_500_540 * 1000).toISOString(),
      confidence: null,
    });
  });

  it('asks about the native asset and the tokens in separate calls', async () => {
    // Two endpoints, because CoinGecko prices contracts and coins differently.
    const { fetchImpl, calls } = createFetchStub((url) =>
      url.includes('/simple/price?')
        ? jsonResponse({ ethereum: { usd: 1882.49 } })
        : jsonResponse({ [USDC.toLowerCase()]: { usd: 1 } }),
    );

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs: [USDC_REF, NATIVE_REF],
      context: createTestContext(fetchImpl),
    });

    expect(calls).toHaveLength(2);
    expect(lookup.quotes.get(priceRefKey(USDC_REF))?.priceUsd).toBe('1');
    expect(lookup.quotes.get(priceRefKey(NATIVE_REF))?.priceUsd).toBe('1882.49');
  });

  it('counts a failed native call in the same warning as the token batches', async () => {
    // One unconfirmed price is one unconfirmed price, whichever call it came from.
    const { fetchImpl } = createFetchStub((url) =>
      url.includes('/simple/price?')
        ? jsonResponse({}, { status: 500 })
        : jsonResponse({ [USDC.toLowerCase()]: { usd: 1 } }),
    );
    const { logger, lines } = createRecordingLogger('debug');

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs: [USDC_REF, NATIVE_REF],
      context: createTestContext(fetchImpl, { logger }),
    });

    // The token quote survives; only the native one is missing.
    expect(lookup.quotes.get(priceRefKey(USDC_REF))?.priceUsd).toBe('1');
    expect(lookup.quotes.has(priceRefKey(NATIVE_REF))).toBe(false);
    expect(lookup.warnings[0]?.message).toContain('1 of 2');
    expect(lines.some((line) => line.includes('crosscheck_native_failed'))).toBe(true);
  });

  it('omits an asset the second source did not price', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ [USDC.toLowerCase()]: { usd: 1 } }));

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs: [USDC_REF, WETH_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.has(priceRefKey(USDC_REF))).toBe(true);
    expect(lookup.quotes.has(priceRefKey(WETH_REF))).toBe(false);
  });

  it('discards a non-positive price, which cannot be a real quote', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ [USDC.toLowerCase()]: { usd: 0 } }));

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.size).toBe(0);
  });

  it('reports a missing timestamp as unknown age, not as fresh', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ [USDC.toLowerCase()]: { usd: 1 } }));

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.get(priceRefKey(USDC_REF))?.updatedAt).toBeNull();
  });

  it('chunks at 100 addresses, well below the URI limit that bites at 200', async () => {
    // Measured live: 175 addresses succeed, 200 returns HTTP 414. The ceiling is
    // nginx's URI length, not an API rule, so the chunk size keeps a wide margin.
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}));

    const refs: PriceRef[] = Array.from({ length: 250 }, (_, index) => ({
      chainId: 1,
      contractAddress: `0x${index.toString(16).padStart(40, '0')}` as PriceRef['contractAddress'],
    }));

    await verifier().verify({
      chain: createTestChain(),
      refs,
      context: createTestContext(fetchImpl),
    });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      // Comfortably under the observed ~8 kB ceiling.
      expect(call.url.length).toBeLessThan(6000);
    }
  });

  it('treats a 414 arriving as HTML rather than JSON as an unusable response', async () => {
    // The real failure mode: nginx answers with an HTML error page, so there is no
    // error code to branch on — it must surface as an unusable response.
    const { fetchImpl } = createFetchStub(
      () =>
        new Response('<html><head><title>414 Request-URI Too Large</title></head></html>', {
          status: 414,
        }),
    );

    await expect(
      verifier().verify({
        chain: createTestChain(),
        refs: [USDC_REF],
        context: createTestContext(fetchImpl),
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('raises unavailable rather than partial when nothing got through at all', async () => {
    // "1 of 1 requests failed" is not a partial result, it is an absent second
    // source — and the caller says so with a single crosscheck_unavailable warning
    // instead of implying some prices were confirmed.
    const { fetchImpl } = createFetchStub(() => jsonResponse({}, { status: 500 }));

    await expect(
      verifier().verify({
        chain: createTestChain(),
        refs: [USDC_REF, WETH_REF],
        context: createTestContext(fetchImpl),
      }),
    ).rejects.toMatchObject({ kind: 'unavailable', providerId: 'coingecko' });
  });

  it('stops immediately on a rejected key, which is configuration rather than weather', async () => {
    // Every remaining request would fail identically. Burning them to arrive at
    // the same place wastes quota and buries the real cause in a generic warning.
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({ status: { error_code: 10002 } }, { status: 401 }),
    );
    const { logger, lines } = createRecordingLogger('debug', [API_KEY]);

    const refs: PriceRef[] = Array.from({ length: 250 }, (_, index) => ({
      chainId: 1,
      contractAddress: `0x${index.toString(16).padStart(40, '0')}` as PriceRef['contractAddress'],
    }));

    await expect(
      verifier().verify({
        chain: createTestChain(),
        refs,
        context: createTestContext(fetchImpl, { logger }),
      }),
    ).rejects.toMatchObject({ status: 401 });

    // One request, not three: it gave up rather than retrying the same rejection.
    expect(calls).toHaveLength(1);
    // Logged as an operator problem, so it is not mistaken for an outage.
    expect(lines.some((line) => line.includes('crosscheck_misconfigured'))).toBe(true);
    expect(lines.join('\n')).not.toContain(API_KEY);
  });

  it('records the batch size when a batch fails, since a 414 is diagnosable only from that', async () => {
    // 150 refs is two batches; the first succeeds so the run degrades rather than
    // failing outright, which is what lets the log line be inspected.
    const refs: PriceRef[] = Array.from({ length: 150 }, (_, index) =>
      index === 0
        ? USDC_REF
        : {
            chainId: 1,
            contractAddress:
              `0x${index.toString(16).padStart(40, '0')}` as PriceRef['contractAddress'],
          },
    );
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? jsonResponse({ [USDC.toLowerCase()]: { usd: 1 } })
        : jsonResponse({}, { status: 500 }),
    );
    const { logger, lines } = createRecordingLogger('debug');

    await verifier().verify({
      chain: createTestChain(),
      refs,
      context: createTestContext(fetchImpl, { logger }),
    });

    const failure = lines.find((line) => line.includes('crosscheck_batch_failed'));
    expect(failure).toBeDefined();
    expect(JSON.parse(failure as string)).toMatchObject({ batchSize: 50 });
  });

  it('keeps the quotes from batches that succeeded when another fails', async () => {
    const refs: PriceRef[] = Array.from({ length: 150 }, (_, index) =>
      index === 0
        ? USDC_REF
        : {
            chainId: 1,
            contractAddress:
              `0x${index.toString(16).padStart(40, '0')}` as PriceRef['contractAddress'],
          },
    );

    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? jsonResponse({ [USDC.toLowerCase()]: { usd: 1 } })
        : jsonResponse({}, { status: 500 }),
    );

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs,
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.get(priceRefKey(USDC_REF))?.priceUsd).toBe('1');
    expect(lookup.warnings.map((w) => w.code)).toContain('prices.crosscheck_partial');
  });

  it('offers no opinion on a chain it has no platform mapping for', async () => {
    // Not a fault: an unmapped chain simply goes unchecked, and the portfolio
    // reports that by leaving priceCheck null.
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}));

    const lookup = await verifier().verify({
      chain: createTestChain({ chainId: 999_999 }),
      refs: [{ chainId: 999_999, contractAddress: USDC }],
      context: createTestContext(fetchImpl),
    });

    expect(calls).toHaveLength(0);
    expect(lookup.quotes.size).toBe(0);
    expect(lookup.warnings).toHaveLength(0);
  });

  it('rejects a response whose shape does not match', async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({ [USDC.toLowerCase()]: { usd: 'free' } }),
    );
    const { logger, lines } = createRecordingLogger('debug');

    // Surfaces to the caller as an absent second source — the only honest summary
    // when no request produced a usable answer. The specific cause is in the log,
    // where an operator can act on it, rather than in a user-facing warning.
    await expect(
      verifier().verify({
        chain: createTestChain(),
        refs: [USDC_REF],
        context: createTestContext(fetchImpl, { logger }),
      }),
    ).rejects.toMatchObject({ kind: 'unavailable' });

    expect(lines.some((line) => line.includes('did not match the expected schema'))).toBe(true);
  });

  it('reports which refs it actually asked about, so unasked is not "no opinion"', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ [USDC.toLowerCase()]: { usd: 1 } }));

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs: [USDC_REF, WETH_REF],
      context: createTestContext(fetchImpl),
    });

    // Both were sent; only one came back priced. That difference is what makes
    // WETH honestly "checked, no opinion" rather than "never checked".
    expect(lookup.attemptedRefKeys.has(priceRefKey(USDC_REF))).toBe(true);
    expect(lookup.attemptedRefKeys.has(priceRefKey(WETH_REF))).toBe(true);
    expect(lookup.quotes.has(priceRefKey(WETH_REF))).toBe(false);
  });

  it('leaves refs unattempted when the deadline expires, rather than implying they were asked', async () => {
    // An expired deadline means the request was never issued. Reporting those refs
    // as attempted would overstate how much verification happened and would credit
    // a source that returned nothing.
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}));

    const lookup = await verifier().verify({
      chain: createTestChain(),
      refs: [USDC_REF, NATIVE_REF],
      // A budget that was already spent before this call started.
      context: createTestContext(fetchImpl, { deadline: new Deadline(1, Date.now() - 1000) }),
    });

    expect(calls).toHaveLength(0);
    expect(lookup.attemptedRefKeys.size).toBe(0);
    expect(lookup.quotes.size).toBe(0);
    // No warning either: nothing failed, nothing was tried.
    expect(lookup.warnings).toHaveLength(0);
  });

  it('offers no opinion, and no false attempt, on an unmapped chain', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({}));

    const lookup = await verifier().verify({
      chain: createTestChain({ chainId: 999_999 }),
      refs: [{ chainId: 999_999, contractAddress: USDC }],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.attemptedRefKeys.size).toBe(0);
  });

  it('makes no request when there is nothing to check', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}));

    await verifier().verify({
      chain: createTestChain(),
      refs: [],
      context: createTestContext(fetchImpl),
    });

    expect(calls).toHaveLength(0);
  });
});
