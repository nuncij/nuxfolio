import { describe, expect, it } from 'vitest';

import { TEST_ADDRESS } from '@/test/helpers';

import type { Portfolio, PortfolioAsset } from './portfolio';
import { selectPortfolioViewState, type PortfolioData } from './viewState';

/** Wraps a single-chain portfolio in the shape the state machine consumes. */
function chainData(portfolio: Portfolio): PortfolioData {
  return { scope: 'chain', portfolio };
}

function asset(overrides: Partial<PortfolioAsset> = {}): PortfolioAsset {
  return {
    assetId: '1:native',
    chainId: 1,
    contractAddress: null,
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
    quantity: '1',
    rawQuantity: '1000000000000000000',
    priceUsd: '2000',
    valueUsd: '2000.00000000',
    portfolioSharePct: '100.0000',
    logoUrl: null,
    priceSource: 'defillama',
    priceUpdatedAt: null,
    priceQuality: 'ok',
    priceCheck: null,
    priceChange24h: null,
    priceChange7d: null,
    suspect: false,
    suspectReason: null,
    ...overrides,
  };
}

function portfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  const assets = overrides.assets ?? [asset()];
  return {
    address: TEST_ADDRESS,
    chainId: 1,
    chainName: 'Ethereum Mainnet',
    protocolAccounts: [],
    totalValueUsd: '2000.00000000',
    netOfAaveDebtUsd: null,
    assetCount: assets.length,
    pricedAssetCount: assets.filter((entry) => entry.valueUsd !== null).length,
    unpricedAssetCount: assets.filter((entry) => entry.valueUsd === null).length,
    suspectAssetCount: assets.filter((entry) => entry.suspect).length,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    coverage: 'complete',
    balanceSource: 'rpc-token-list',
    priceSource: 'defillama',
    assets,
    fxRate: null,
    fetchedAt: '2026-07-30T12:00:00.000Z',
    warnings: [],
    ...overrides,
  };
}

describe('selectPortfolioViewState', () => {
  it('is idle before anything has been requested', () => {
    expect(
      selectPortfolioViewState({
        requested: false,
        loading: false,
        data: null,
        error: null,
      }),
    ).toEqual({ kind: 'idle' });
  });

  it('is loading while the first request is in flight', () => {
    expect(
      selectPortfolioViewState({ requested: true, loading: true, data: null, error: null }),
    ).toEqual({ kind: 'loading' });
  });

  it('keeps showing data during a refresh instead of reverting to a skeleton', () => {
    // Replacing a rendered portfolio with a skeleton on every refresh reads as
    // data loss.
    const state = selectPortfolioViewState({
      requested: true,
      loading: true,
      data: chainData(portfolio()),
      error: null,
    });

    expect(state.kind).toBe('ready');
  });

  it('is ready when at least one asset is priced', () => {
    const state = selectPortfolioViewState({
      requested: true,
      loading: false,
      data: chainData(portfolio()),
      error: null,
    });

    expect(state).toMatchObject({ kind: 'ready' });
  });

  it('is empty when the wallet holds nothing this provider can see', () => {
    const state = selectPortfolioViewState({
      requested: true,
      loading: false,
      data: chainData(portfolio({ assets: [], totalValueUsd: null })),
      error: null,
    });

    expect(state).toMatchObject({ kind: 'empty' });
  });

  it('is unpriced when assets exist but none could be valued', () => {
    // Distinct from empty: there are holdings to show, just no market data.
    const state = selectPortfolioViewState({
      requested: true,
      loading: false,
      data: chainData(
        portfolio({
          assets: [asset({ priceUsd: null, valueUsd: null, portfolioSharePct: null })],
          totalValueUsd: null,
          netOfAaveDebtUsd: null,
        }),
      ),
      error: null,
    });

    expect(state).toMatchObject({ kind: 'unpriced' });
  });

  it('reports an error even when stale data is still in hand', () => {
    const state = selectPortfolioViewState({
      requested: true,
      loading: false,
      data: chainData(portfolio()),
      error: { code: 'timeout', message: 'Took too long.' },
    });

    expect(state).toMatchObject({ kind: 'error', retryable: true });
  });

  it.each([
    ['rate-limited', true],
    ['upstream-rate-limited', true],
    ['upstream-unavailable', true],
    ['timeout', true],
    ['internal', true],
    ['invalid-address', false],
    ['unsupported-chain', false],
    ['invalid-chain', false],
  ] as const)('marks %s as retryable=%s', (code, retryable) => {
    const state = selectPortfolioViewState({
      requested: true,
      loading: false,
      data: null,
      error: { code, message: 'x' },
    });

    expect(state).toMatchObject({ kind: 'error', retryable });
  });
});
