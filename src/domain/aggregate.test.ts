import { describe, expect, it } from 'vitest';

import { TEST_ADDRESS, USDC } from '@/test/helpers';

import {
  buildAggregatePortfolio,
  flattenAggregateAssets,
  summarizeAggregate,
  withCrossChainShares,
} from './normalize';
import type { Portfolio, PortfolioAsset } from './portfolio';

const FETCHED_AT = '2026-07-30T12:00:00.000Z';

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
    priceUpdatedAt: FETCHED_AT,
    priceQuality: 'ok',
    priceCheck: null,
    priceChange24h: null,
    priceChange7d: null,
    suspect: false,
    suspectReason: null,
    ...overrides,
  };
}

function chainPortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  const assets = overrides.assets ?? [asset()];
  const priced = assets.filter((entry) => entry.valueUsd !== null);
  return {
    address: TEST_ADDRESS,
    chainId: 1,
    chainName: 'Ethereum Mainnet',
    protocolAccounts: [],
    stakedPositions: [],
    stakedStatus: 'unavailable',
    totalValueUsd: priced.length > 0 ? '2000.00000000' : null,
    netOfAaveDebtUsd: null,
    assetCount: assets.length,
    pricedAssetCount: priced.length,
    unpricedAssetCount: assets.length - priced.length,
    suspectAssetCount: assets.filter((entry) => entry.suspect).length,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    coverage: 'token-list',
    balanceSource: 'rpc-token-list',
    priceSource: 'defillama',
    assets,
    fxRate: null,
    fetchedAt: FETCHED_AT,
    warnings: [],
    ...overrides,
  };
}

describe('buildAggregatePortfolio', () => {
  it('sums the per-chain priced subtotals', () => {
    const aggregate = buildAggregatePortfolio({
      address: TEST_ADDRESS,
      chains: [
        chainPortfolio({ totalValueUsd: '2000.00000000' }),
        chainPortfolio({
          chainId: 8453,
          chainName: 'Base',
          protocolAccounts: [],
          stakedPositions: [],
          stakedStatus: 'unavailable',
          totalValueUsd: '500.50000000',
          netOfAaveDebtUsd: null,
          assets: [asset({ assetId: '8453:native', chainId: 8453, valueUsd: '500.50000000' })],
        }),
      ],
      failedChains: [],
      fetchedAt: FETCHED_AT,
    });

    expect(aggregate.totalValueUsd).toBe('2500.50000000');
    expect(aggregate.assetCount).toBe(2);
    expect(aggregate.pricedAssetCount).toBe(2);
    expect(aggregate.chains).toHaveLength(2);
  });

  it('reports a null total, never zero, when no chain could be priced', () => {
    const aggregate = buildAggregatePortfolio({
      address: TEST_ADDRESS,
      chains: [
        chainPortfolio({
          totalValueUsd: null,
          netOfAaveDebtUsd: null,
          assets: [asset({ priceUsd: null, valueUsd: null, portfolioSharePct: null })],
        }),
      ],
      failedChains: [],
      fetchedAt: FETCHED_AT,
    });

    expect(aggregate.totalValueUsd).toBeNull();
    expect(aggregate.unpricedAssetCount).toBe(1);
  });

  it('carries failed chains rather than dropping them from the view', () => {
    // A network silently missing from a total is the same quiet error as an
    // unpriced asset silently missing from it.
    const aggregate = buildAggregatePortfolio({
      address: TEST_ADDRESS,
      chains: [chainPortfolio()],
      failedChains: [
        { chainId: 56, chainName: 'BNB Smart Chain', message: 'This network was skipped.' },
      ],
      fetchedAt: FETCHED_AT,
    });

    expect(aggregate.chains).toHaveLength(1);
    expect(aggregate.failedChains[0]).toMatchObject({ chainId: 56 });
    // The failed chain contributes nothing to the total, by construction.
    expect(aggregate.totalValueUsd).toBe('2000.00000000');
  });

  it('sums exactly across chains rather than through floats', () => {
    const aggregate = buildAggregatePortfolio({
      address: TEST_ADDRESS,
      chains: [
        chainPortfolio({ totalValueUsd: '0.10000000' }),
        chainPortfolio({ chainId: 10, chainName: 'OP Mainnet', totalValueUsd: '0.20000000' }),
      ],
      failedChains: [],
      fetchedAt: FETCHED_AT,
    });

    expect(aggregate.totalValueUsd).toBe('0.30000000');
  });

  it('sums the spam that each chain excluded, so nothing is hidden twice', () => {
    const aggregate = buildAggregatePortfolio({
      address: TEST_ADDRESS,
      chains: [
        chainPortfolio({ suspectAssetCount: 1, suspectValueUsd: '900.00000000' }),
        chainPortfolio({
          chainId: 10,
          chainName: 'OP Mainnet',
          suspectAssetCount: 2,
          suspectValueUsd: '0.50000000',
          checkedAssetCount: 0,
          disputedAssetCount: 0,
        }),
      ],
      failedChains: [],
      fetchedAt: FETCHED_AT,
    });

    expect(aggregate.suspectAssetCount).toBe(3);
    expect(aggregate.suspectValueUsd).toBe('900.50000000');
    // The excluded value is reported, never folded back into the total.
    expect(aggregate.totalValueUsd).toBe('4000.00000000');
  });

  it('reports no excluded value when no chain flagged a priced asset', () => {
    const aggregate = buildAggregatePortfolio({
      address: TEST_ADDRESS,
      chains: [chainPortfolio({ suspectAssetCount: 1, suspectValueUsd: null })],
      failedChains: [],
      fetchedAt: FETCHED_AT,
    });

    expect(aggregate.suspectAssetCount).toBe(1);
    expect(aggregate.suspectValueUsd).toBeNull();
  });
});

describe('flattenAggregateAssets', () => {
  it('attaches each asset to the chain it came from', () => {
    const aggregate = buildAggregatePortfolio({
      address: TEST_ADDRESS,
      chains: [
        chainPortfolio(),
        chainPortfolio({
          chainId: 8453,
          chainName: 'Base',
          assets: [asset({ assetId: '8453:native', chainId: 8453, symbol: 'ETH' })],
        }),
      ],
      failedChains: [],
      fetchedAt: FETCHED_AT,
    });

    expect(flattenAggregateAssets(aggregate).map((a) => a.chainName)).toEqual([
      'Ethereum Mainnet',
      'Base',
    ]);
  });
});

describe('withCrossChainShares', () => {
  it('recomputes shares against the cross-chain total', () => {
    // Each asset arrives with a share of its own chain's subtotal; leaving those
    // in place would make every chain sum to 100 % on its own.
    const aggregate = buildAggregatePortfolio({
      address: TEST_ADDRESS,
      chains: [
        chainPortfolio({ totalValueUsd: '750.00000000', assets: [asset({ valueUsd: '750' })] }),
        chainPortfolio({
          chainId: 8453,
          chainName: 'Base',
          protocolAccounts: [],
          stakedPositions: [],
          stakedStatus: 'unavailable',
          totalValueUsd: '250.00000000',
          netOfAaveDebtUsd: null,
          assets: [asset({ assetId: '8453:native', chainId: 8453, valueUsd: '250' })],
        }),
      ],
      failedChains: [],
      fetchedAt: FETCHED_AT,
    });

    const shares = withCrossChainShares(
      flattenAggregateAssets(aggregate),
      aggregate.totalValueUsd,
    ).map((a) => a.portfolioSharePct);

    expect(shares).toEqual(['75.0000', '25.0000']);
  });

  it('gives a flagged asset no share of a total it is not in', () => {
    const assets = flattenAggregateAssets(
      buildAggregatePortfolio({
        address: TEST_ADDRESS,
        chains: [
          chainPortfolio({
            totalValueUsd: '100.00000000',
            netOfAaveDebtUsd: null,
            assets: [
              asset({ valueUsd: '100' }),
              asset({
                assetId: `1:${USDC}`,
                contractAddress: USDC,
                symbol: 'USDC',
                valueUsd: '5000',
                suspect: true,
                suspectReason: 'symbol-spoof',
              }),
            ],
          }),
        ],
        failedChains: [],
        fetchedAt: FETCHED_AT,
      }),
    );

    expect(withCrossChainShares(assets, '100.00000000').map((a) => a.portfolioSharePct)).toEqual([
      '100.0000',
      null,
    ]);
  });

  it('nulls every share when nothing could be priced', () => {
    const assets = flattenAggregateAssets(
      buildAggregatePortfolio({
        address: TEST_ADDRESS,
        chains: [chainPortfolio({ assets: [asset({ valueUsd: null })] })],
        failedChains: [],
        fetchedAt: FETCHED_AT,
      }),
    );

    expect(withCrossChainShares(assets, null).every((a) => a.portfolioSharePct === null)).toBe(
      true,
    );
  });

  it('leaves an unpriced asset without a share while pricing the rest', () => {
    const assets = flattenAggregateAssets(
      buildAggregatePortfolio({
        address: TEST_ADDRESS,
        chains: [
          chainPortfolio({
            assets: [
              asset({ valueUsd: '100' }),
              asset({
                assetId: `1:${USDC}`,
                contractAddress: USDC,
                symbol: 'USDC',
                valueUsd: null,
              }),
            ],
          }),
        ],
        failedChains: [],
        fetchedAt: FETCHED_AT,
      }),
    );

    expect(withCrossChainShares(assets, '100').map((a) => a.portfolioSharePct)).toEqual([
      '100.0000',
      null,
    ]);
  });
});

describe('summarizeAggregate', () => {
  it('finds the largest position across every chain, not within one', () => {
    const aggregate = buildAggregatePortfolio({
      address: TEST_ADDRESS,
      chains: [
        chainPortfolio({ totalValueUsd: '100.00000000', assets: [asset({ valueUsd: '100' })] }),
        chainPortfolio({
          chainId: 8453,
          chainName: 'Base',
          protocolAccounts: [],
          stakedPositions: [],
          stakedStatus: 'unavailable',
          totalValueUsd: '900.00000000',
          netOfAaveDebtUsd: null,
          assets: [asset({ assetId: '8453:big', chainId: 8453, symbol: 'BIG', valueUsd: '900' })],
        }),
      ],
      failedChains: [],
      fetchedAt: FETCHED_AT,
    });

    const summary = summarizeAggregate(aggregate);

    expect(summary.largestAsset).toMatchObject({ symbol: 'BIG', valueUsd: '900' });
    expect(summary.largestAsset?.sharePct).toBe('90.0000');
    expect(summary.chainCount).toBe(2);
    expect(summary.totalValueUsd).toBe('1000.00000000');
  });

  it('reports no largest position when nothing is priced', () => {
    const summary = summarizeAggregate(
      buildAggregatePortfolio({
        address: TEST_ADDRESS,
        chains: [chainPortfolio({ totalValueUsd: null, assets: [asset({ valueUsd: null })] })],
        failedChains: [],
        fetchedAt: FETCHED_AT,
      }),
    );

    expect(summary.largestAsset).toBeNull();
  });

  it('never lets a flagged asset become the largest position', () => {
    const summary = summarizeAggregate(
      buildAggregatePortfolio({
        address: TEST_ADDRESS,
        chains: [
          chainPortfolio({
            totalValueUsd: '100.00000000',
            netOfAaveDebtUsd: null,
            suspectAssetCount: 1,
            suspectValueUsd: '9000.00000000',
            checkedAssetCount: 0,
            disputedAssetCount: 0,
            assets: [
              asset({ valueUsd: '100' }),
              asset({
                assetId: '1:fake',
                symbol: 'FAKE',
                valueUsd: '9000',
                suspect: true,
                suspectReason: 'symbol-spoof',
              }),
            ],
          }),
        ],
        failedChains: [],
        fetchedAt: FETCHED_AT,
      }),
    );

    expect(summary.largestAsset?.symbol).toBe('ETH');
    expect(summary.suspectAssetCount).toBe(1);
    expect(summary.suspectValueUsd).toBe('9000.00000000');
  });

  it('counts flagged prices across all chains', () => {
    const summary = summarizeAggregate(
      buildAggregatePortfolio({
        address: TEST_ADDRESS,
        chains: [
          chainPortfolio({ assets: [asset({ priceQuality: 'stale' })] }),
          chainPortfolio({
            chainId: 10,
            chainName: 'OP Mainnet',
            assets: [asset({ assetId: '10:native', priceQuality: 'unknown-age' })],
          }),
        ],
        failedChains: [],
        fetchedAt: FETCHED_AT,
      }),
    );

    expect(summary.flaggedPriceCount).toBe(2);
  });
});
