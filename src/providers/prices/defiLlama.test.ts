import { describe, expect, it } from 'vitest';

import {
  createFetchStub,
  createTestChain,
  createTestContext,
  jsonResponse,
  USDC,
  WETH,
} from '@/test/helpers';

import { priceRefKey, type PriceRef } from '../types';

import { createDefiLlamaPriceProvider } from './defiLlama';

const NATIVE_REF: PriceRef = { chainId: 1, contractAddress: null };
const USDC_REF: PriceRef = { chainId: 1, contractAddress: USDC };
const WETH_REF: PriceRef = { chainId: 1, contractAddress: WETH };

const TIMESTAMP = 1_785_411_005;

describe('defillama price provider', () => {
  it('prices tokens and the native asset in one request', async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({
        coins: {
          [`ethereum:${USDC}`]: {
            price: 0.9997329124356173,
            symbol: 'USDC',
            decimals: 6,
            timestamp: TIMESTAMP,
            confidence: 0.99,
          },
          'coingecko:ethereum': {
            price: 1917.53,
            symbol: 'ETH',
            timestamp: TIMESTAMP,
            confidence: 0.99,
          },
        },
      }),
    );

    const lookup = await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs: [NATIVE_REF, USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(calls).toHaveLength(1);
    expect(lookup.providerId).toBe('defillama');
    expect(lookup.quotes.get(priceRefKey(NATIVE_REF))).toEqual({
      priceUsd: '1917.53',
      updatedAt: new Date(TIMESTAMP * 1000).toISOString(),
      confidence: 0.99,
    });
    expect(lookup.quotes.get(priceRefKey(USDC_REF))?.priceUsd).toBe('0.9997329124356173');
  });

  it('asks for the native asset through the CoinGecko namespace', async () => {
    // Native assets have no contract address, so they cannot use the chain
    // namespace — that mapping is the adapter's business, not the domain's.
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ coins: {} }));

    await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs: [NATIVE_REF],
      context: createTestContext(fetchImpl),
    });

    expect(decodeURIComponent(calls[0]?.url ?? '')).toContain('coingecko:ethereum');
  });

  it('matches the response back to refs regardless of address casing', async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({
        coins: {
          // DefiLlama may echo a different casing than was requested.
          [`ethereum:${USDC.toUpperCase()}`]: { price: 1, timestamp: TIMESTAMP, confidence: 0.99 },
        },
      }),
    );

    const lookup = await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.get(priceRefKey(USDC_REF))?.priceUsd).toBe('1');
  });

  it('omits an asset the provider did not price, rather than inventing a zero', async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({
        coins: { [`ethereum:${USDC}`]: { price: 1, timestamp: TIMESTAMP, confidence: 0.99 } },
      }),
    );

    const lookup = await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs: [USDC_REF, WETH_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.has(priceRefKey(USDC_REF))).toBe(true);
    expect(lookup.quotes.has(priceRefKey(WETH_REF))).toBe(false);
  });

  it('discards a non-positive price, which cannot be a real quote', async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({
        coins: { [`ethereum:${USDC}`]: { price: 0, timestamp: TIMESTAMP, confidence: 0.99 } },
      }),
    );

    const lookup = await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.size).toBe(0);
  });

  it('reports a missing timestamp as unknown instead of stamping "now"', async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({ coins: { [`ethereum:${USDC}`]: { price: 1, confidence: 0.99 } } }),
    );

    const lookup = await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.get(priceRefKey(USDC_REF))?.updatedAt).toBeNull();
  });

  it('passes a missing confidence score through as null, not as a default', async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({ coins: { [`ethereum:${USDC}`]: { price: 1, timestamp: TIMESTAMP } } }),
    );

    const lookup = await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.get(priceRefKey(USDC_REF))?.confidence).toBeNull();
  });

  it('splits a large portfolio into batches rather than one enormous URL', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ coins: {} }));

    const refs: PriceRef[] = Array.from({ length: 130 }, (_, index) => ({
      chainId: 1,
      contractAddress: `0x${index.toString(16).padStart(40, '0')}` as PriceRef['contractAddress'],
    }));

    await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs,
      context: createTestContext(fetchImpl),
    });

    // 130 refs at 60 per request.
    expect(calls).toHaveLength(3);
  });

  it('degrades to a warning when a batch fails, instead of failing the portfolio', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({}, { status: 503 }));

    const lookup = await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.size).toBe(0);
    expect(lookup.warnings.map((warning) => warning.code)).toContain('prices.partial');
  });

  it('keeps the quotes from batches that succeeded when another batch fails', async () => {
    const refs: PriceRef[] = Array.from({ length: 61 }, (_, index) =>
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
        ? jsonResponse({
            coins: { [`ethereum:${USDC}`]: { price: 1, timestamp: TIMESTAMP, confidence: 0.99 } },
          })
        : jsonResponse({}, { status: 500 }),
    );

    const lookup = await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs,
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.get(priceRefKey(USDC_REF))?.priceUsd).toBe('1');
    expect(lookup.warnings.map((warning) => warning.code)).toContain('prices.partial');
  });

  it('makes no request at all for an empty portfolio', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ coins: {} }));

    const lookup = await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs: [],
      context: createTestContext(fetchImpl),
    });

    expect(calls).toHaveLength(0);
    expect(lookup.quotes.size).toBe(0);
  });

  it('reports a misconfiguration for a chain it has no namespace for', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ coins: {} }));

    await expect(
      createDefiLlamaPriceProvider().fetchPrices({
        chain: createTestChain({ chainId: 999_999 }),
        refs: [{ chainId: 999_999, contractAddress: USDC }],
        context: createTestContext(fetchImpl),
      }),
    ).rejects.toMatchObject({ kind: 'misconfigured' });
  });

  it('rejects a response whose shape does not match, rather than trusting it', async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({ coins: { [`ethereum:${USDC}`]: { price: 'free' } } }),
    );

    const lookup = await createDefiLlamaPriceProvider().fetchPrices({
      chain: createTestChain(),
      refs: [USDC_REF],
      context: createTestContext(fetchImpl),
    });

    expect(lookup.quotes.size).toBe(0);
    expect(lookup.warnings.map((warning) => warning.code)).toContain('prices.partial');
  });
});
