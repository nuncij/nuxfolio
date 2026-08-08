import { describe, expect, it } from 'vitest';

import { TEST_ADDRESS } from '@/test/helpers';

import { buildAggregatePortfolio } from './normalize';
import type { AggregatePortfolio, ApiError, Portfolio, PortfolioAsset } from './portfolio';
import {
  createProgressiveAggregate,
  recordChainResult,
  selectAggregateError,
  selectAggregatePortfolio,
  selectAggregateProgress,
  type ChainLoadResult,
  type ProgressiveAggregateState,
  type RequestedChain,
} from './progressiveAggregate';

/**
 * The browser assembles the all-networks view from responses that arrive in an
 * order nobody controls, so these tests are mostly about one property: the view
 * depends on the results, never on when they landed.
 */

const FETCHED_AT = '2026-07-30T12:00:00.000Z';

/** Registry order, as the chain registry hands it to the view. */
const REGISTRY: readonly RequestedChain[] = [
  { chainId: 1, name: 'Ethereum Mainnet' },
  { chainId: 8453, name: 'Base' },
  { chainId: 56, name: 'BNB Smart Chain' },
];

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
  const priced = assets.filter((entry) => entry.valueUsd !== null && !entry.suspect);
  return {
    address: TEST_ADDRESS,
    chainId: 1,
    chainName: 'Ethereum Mainnet',
    protocolAccounts: [],
    totalValueUsd: priced.length > 0 ? '2000.00000000' : null,
    netOfAaveDebtUsd: null,
    assetCount: assets.length,
    pricedAssetCount: assets.filter((entry) => entry.valueUsd !== null).length,
    unpricedAssetCount: assets.filter((entry) => entry.valueUsd === null).length,
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

const ETHEREUM = chainPortfolio();

const BASE = chainPortfolio({
  chainId: 8453,
  chainName: 'Base',
  totalValueUsd: '500.50000000',
  netOfAaveDebtUsd: null,
  assets: [asset({ assetId: '8453:native', chainId: 8453, valueUsd: '500.50000000' })],
});

const BSC_FAILED: ChainLoadResult = {
  chainId: 56,
  ok: false,
  // A real upstream message, to prove none of it reaches the view.
  error: { code: 'timeout', message: 'fetch to https://bsc-rpc.example/?key=SECRET timed out' },
};

function start(chains: readonly RequestedChain[] = REGISTRY): ProgressiveAggregateState {
  return createProgressiveAggregate({ address: TEST_ADDRESS, chains });
}

function fold(
  results: readonly ChainLoadResult[],
  chains: readonly RequestedChain[] = REGISTRY,
): ProgressiveAggregateState {
  return results.reduce(recordChainResult, start(chains));
}

function loaded(portfolio: Portfolio): ChainLoadResult {
  return { chainId: portfolio.chainId, ok: true, portfolio };
}

/** Every arrival order of the same results. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

describe('progressive aggregate assembly', () => {
  it('produces the same view whatever order the networks answer in', () => {
    const results = [loaded(ETHEREUM), loaded(BASE), BSC_FAILED];
    const orders = permutations(results);
    expect(orders).toHaveLength(6);

    const views = orders.map((order) => selectAggregatePortfolio(fold(order)));

    for (const view of views) {
      expect(view).toEqual(views[0]);
    }
    expect(views[0]?.totalValueUsd).toBe('2500.50000000');
  });

  it('orders chains by the registry, not by arrival', () => {
    const reverse = fold([BSC_FAILED, loaded(BASE), loaded(ETHEREUM)]);

    expect(selectAggregatePortfolio(reverse)?.chains.map((chain) => chain.chainId)).toEqual([
      1, 8453,
    ]);
  });

  it('matches what the server aggregate would build from the same chains', () => {
    // The acceptance criterion for this feature: moving assembly into the browser
    // must not change the answer.
    const view = selectAggregatePortfolio(fold([loaded(BASE), BSC_FAILED, loaded(ETHEREUM)]));

    const server: AggregatePortfolio = buildAggregatePortfolio({
      address: TEST_ADDRESS,
      chains: [ETHEREUM, BASE],
      failedChains: [
        {
          chainId: 56,
          chainName: 'BNB Smart Chain',
          message: 'This network took too long to respond and was skipped.',
        },
      ],
      fetchedAt: FETCHED_AT,
    });

    expect(view).toEqual(server);
  });

  it('shows the chains that have arrived while the rest are outstanding', () => {
    const partial = fold([loaded(BASE)]);

    expect(selectAggregateProgress(partial)).toEqual({
      settled: 1,
      loaded: 1,
      failed: 0,
      total: 3,
      complete: false,
    });
    const view = selectAggregatePortfolio(partial);
    expect(view?.chains.map((chain) => chain.chainId)).toEqual([8453]);
    // The subtotal covers exactly what arrived — no placeholder for the rest.
    expect(view?.totalValueUsd).toBe('500.50000000');
    expect(view?.failedChains).toEqual([]);
  });

  it('has nothing to show before the first network answers', () => {
    expect(selectAggregatePortfolio(fold([]))).toBeNull();
    expect(selectAggregateProgress(fold([]))).toMatchObject({ settled: 0, complete: false });
  });

  it('reports a failed network with a safe sentence, never the upstream message', () => {
    const view = selectAggregatePortfolio(fold([loaded(ETHEREUM), BSC_FAILED]));

    expect(view?.failedChains).toEqual([
      {
        chainId: 56,
        chainName: 'BNB Smart Chain',
        message: 'This network took too long to respond and was skipped.',
      },
    ]);
    expect(JSON.stringify(view)).not.toContain('SECRET');
  });

  it('keeps a failed network out of the total but inside the view', () => {
    const view = selectAggregatePortfolio(fold([BSC_FAILED, loaded(ETHEREUM)]));

    expect(view?.totalValueUsd).toBe('2000.00000000');
    expect(view?.chains).toHaveLength(1);
    expect(view?.failedChains).toHaveLength(1);
    // One network failing is not a failed view.
    expect(selectAggregateError(fold([BSC_FAILED, loaded(ETHEREUM)]))).toBeNull();
  });

  it('carries the suspect-asset accounting through from every chain', () => {
    const state = fold([
      loaded(chainPortfolio({ suspectAssetCount: 1, suspectValueUsd: '900.00000000' })),
      loaded(
        chainPortfolio({
          chainId: 8453,
          chainName: 'Base',
          suspectAssetCount: 2,
          suspectValueUsd: '0.50000000',
          checkedAssetCount: 0,
          disputedAssetCount: 0,
        }),
      ),
    ]);

    const view = selectAggregatePortfolio(state);
    expect(view?.suspectAssetCount).toBe(3);
    expect(view?.suspectValueUsd).toBe('900.50000000');
    // Excluded value is reported, never folded back into the total.
    expect(view?.totalValueUsd).toBe('4000.00000000');
  });

  it('sums unpriced counts across chains without inventing a total', () => {
    const unpriced = chainPortfolio({
      chainId: 8453,
      chainName: 'Base',
      totalValueUsd: null,
      netOfAaveDebtUsd: null,
      assets: [asset({ assetId: '8453:native', chainId: 8453, priceUsd: null, valueUsd: null })],
    });

    const view = selectAggregatePortfolio(fold([loaded(unpriced), loaded(ETHEREUM)]));

    expect(view?.unpricedAssetCount).toBe(1);
    expect(view?.pricedAssetCount).toBe(1);
    expect(view?.totalValueUsd).toBe('2000.00000000');
  });

  it('stamps the view with the oldest chain timestamp, not the newest', () => {
    // A chain served from a minute-old cache must not make the whole view look
    // fresher than it is.
    const stale = chainPortfolio({
      chainId: 8453,
      chainName: 'Base',
      fetchedAt: '2026-07-30T11:59:00.000Z',
    });

    expect(selectAggregatePortfolio(fold([loaded(ETHEREUM), loaded(stale)]))?.fetchedAt).toBe(
      '2026-07-30T11:59:00.000Z',
    );
    expect(selectAggregatePortfolio(fold([loaded(stale), loaded(ETHEREUM)]))?.fetchedAt).toBe(
      '2026-07-30T11:59:00.000Z',
    );
  });

  it('replaces a repeated result instead of counting the chain twice', () => {
    const refreshed = chainPortfolio({ totalValueUsd: '3000.00000000' });
    const view = selectAggregatePortfolio(fold([loaded(ETHEREUM), loaded(refreshed)]));

    expect(view?.chains).toHaveLength(1);
    expect(view?.totalValueUsd).toBe('3000.00000000');
  });

  it('drops a result for a network the view never requested', () => {
    // The request set is fixed when the view mounts, so an unknown id could only
    // add value the user did not ask about.
    const state = recordChainResult(fold([loaded(ETHEREUM)]), {
      chainId: 999,
      ok: true,
      portfolio: chainPortfolio({ chainId: 999, chainName: 'Nowhere' }),
    });

    expect(selectAggregatePortfolio(state)?.chains).toHaveLength(1);
    expect(selectAggregateProgress(state).settled).toBe(1);
  });

  it('leaves the caller its earlier states to compare against', () => {
    const first = fold([loaded(ETHEREUM)]);
    const second = recordChainResult(first, loaded(BASE));

    expect(selectAggregateProgress(first).settled).toBe(1);
    expect(selectAggregateProgress(second).settled).toBe(2);
  });
});

describe('selectAggregateError', () => {
  const rateLimited: ChainLoadResult = {
    chainId: 1,
    ok: false,
    error: { code: 'rate-limited', message: 'Too many requests. Please wait a moment.' },
  };
  const unavailable: ChainLoadResult = {
    chainId: 8453,
    ok: false,
    error: { code: 'upstream-unavailable', message: 'The data provider is unavailable.' },
  };

  it('stays silent while any network is still outstanding', () => {
    expect(selectAggregateError(fold([rateLimited, unavailable]))).toBeNull();
  });

  it('fails the view only when every network failed', () => {
    const state = fold([BSC_FAILED, unavailable, rateLimited]);

    expect(selectAggregatePortfolio(state)).toBeNull();
    // Registry order decides which failure is reported, so the same set of
    // failures always produces the same message.
    expect(selectAggregateError(state)?.code).toBe('rate-limited');
  });

  it('reports a readable failure when no network was requested at all', () => {
    const empty = start([]);

    expect(selectAggregateProgress(empty).complete).toBe(true);
    const error: ApiError['error'] | null = selectAggregateError(empty);
    expect(error?.code).toBe('upstream-unavailable');
  });
});
