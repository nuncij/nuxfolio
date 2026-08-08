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
    stakedPositions: [],
    stakedStatus: 'unavailable',
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

describe('a wallet whose only holding is held by a protocol', () => {
  /**
   * Verified against a real Arbitrum staker on 2026-08-08: `0x75DFC877…51b0` holds no
   * token any balance read can see, and 43,840 crvUSDC — about $45,000 — staked in
   * Convex, whose reward contract owns the LP. The page told it "No assets found".
   */
  const staked = {
    positionId: '42161:0xbfee9f3e015adc754066424aed535313dc764116',
    chainId: 42161,
    protocol: 'convex' as const,
    stakedToken: '0xec090cf6DD891D2d014beA6edAda6e05E025D93d',
    symbol: 'crvUSDC',
    amount: '43840.048283862444576459',
    valueUsd: '45035.50811441',
    rewards: [],
  };

  it('is not empty, however little the balance read found', () => {
    const state = selectPortfolioViewState({
      requested: true,
      loading: false,
      data: {
        scope: 'chain',
        portfolio: portfolio({ assetCount: 0, pricedAssetCount: 0, stakedPositions: [staked] }),
      },
      error: null,
    });

    expect(state.kind).not.toBe('empty');
  });

  it('is still empty when nothing is held anywhere', () => {
    const state = selectPortfolioViewState({
      requested: true,
      loading: false,
      data: { scope: 'chain', portfolio: portfolio({ assetCount: 0, pricedAssetCount: 0 }) },
      error: null,
    });

    expect(state.kind).toBe('empty');
  });

  it('is not empty when the staking read failed, because it cannot say', () => {
    // The one state where the wallet might hold something and the page does not know.
    // "Nothing here" is the wrong sentence for a question that was not answered.
    const state = selectPortfolioViewState({
      requested: true,
      loading: false,
      data: {
        scope: 'chain',
        portfolio: portfolio({ assetCount: 0, pricedAssetCount: 0, stakedStatus: 'failed' }),
      },
      error: null,
    });

    expect(state.kind).not.toBe('empty');
  });
});
