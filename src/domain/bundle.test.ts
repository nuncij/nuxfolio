import { describe, expect, it } from 'vitest';

import type { WalletAddress } from './address';
import {
  createBundleState,
  recordBundleMember,
  selectBundleBreakdown,
  selectBundleConclusion,
  selectBundleFetchedAt,
  selectBundleFxRate,
  selectBundleProgress,
  selectBundleTotals,
  selectBundleWarnings,
  selectFailedMembers,
} from './bundle';
import { parseBundleRequest } from './bundleRequest';
import type { AggregatePortfolio, FxQuote, Portfolio } from './portfolio';

const A = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as WalletAddress;
const B = '0x3333333333333333333333333333333333333333' as WalletAddress;
const C = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as WalletAddress;

const RATE: FxQuote = { base: 'EUR', quote: 'USD', rate: '1.25', asOf: '2026-08-01' };

function chain(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    address: A,
    chainId: 1,
    chainName: 'Ethereum Mainnet',
    protocolAccounts: [],
    stakedPositions: [],
    stakedStatus: 'unavailable',
    totalValueUsd: '100.00000000',
    netOfAaveDebtUsd: null,
    assetCount: 1,
    pricedAssetCount: 1,
    unpricedAssetCount: 0,
    suspectAssetCount: 0,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    coverage: 'token-list',
    balanceSource: 'rpc-token-list',
    priceSource: 'defillama',
    assets: [],
    fxRate: null,
    fetchedAt: '2026-08-03T12:00:00.000Z',
    warnings: [],
    ...overrides,
  };
}

function aggregate(overrides: Partial<AggregatePortfolio> = {}): AggregatePortfolio {
  const chains = overrides.chains ?? [chain()];
  return {
    address: A,
    totalValueUsd: '100.00000000',
    netOfAaveDebtUsd: null,
    assetCount: 1,
    pricedAssetCount: 1,
    unpricedAssetCount: 0,
    suspectAssetCount: 0,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    chains,
    failedChains: [],
    fxRate: null,
    fetchedAt: '2026-08-03T12:00:00.000Z',
    ...overrides,
  };
}

function bundleOf(addresses: readonly WalletAddress[]) {
  return createBundleState(parseBundleRequest(addresses.join(',')));
}

describe('progress — four counts, not two', () => {
  it('separates settled from readable, so a failure is never counted as coverage', () => {
    // The defect this exists to prevent: "2 of 3 wallets" when one of the two
    // settled members failed. It settled; it is not covered by the figures.
    let state = bundleOf([A, B, C]);
    state = recordBundleMember(state, A, { status: 'loaded', aggregate: aggregate() });
    state = recordBundleMember(state, B, { status: 'failed', message: 'down' });

    expect(selectBundleProgress(state)).toEqual({
      total: 3,
      settled: 2,
      readable: 1,
      failed: 1,
      complete: false,
    });
  });

  it('is complete once every member has settled, however it settled', () => {
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, { status: 'failed', message: 'down' });
    state = recordBundleMember(state, B, { status: 'failed', message: 'down' });
    expect(selectBundleProgress(state).complete).toBe(true);
  });

  it('ignores a result for an address nobody asked for', () => {
    // A late response from a previous view must not join this bundle.
    const state = recordBundleMember(bundleOf([A]), C, {
      status: 'loaded',
      aggregate: aggregate(),
    });
    expect(selectBundleProgress(state).total).toBe(1);
    expect(selectBundleProgress(state).readable).toBe(0);
  });

  it('matches a result to its member whatever the casing', () => {
    const state = recordBundleMember(bundleOf([A]), A.toLowerCase(), {
      status: 'loaded',
      aggregate: aggregate(),
    });
    expect(selectBundleProgress(state).readable).toBe(1);
  });
});

describe('totals', () => {
  it('sums the readable members', () => {
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({ totalValueUsd: '100.00000000' }),
    });
    state = recordBundleMember(state, B, {
      status: 'loaded',
      aggregate: aggregate({ totalValueUsd: '250.50000000' }),
    });

    expect(selectBundleTotals(state).totalValueUsd).toBe('350.50000000');
  });

  it('excludes a failed member and names it, never counting it as zero', () => {
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({ totalValueUsd: '100.00000000' }),
    });
    state = recordBundleMember(state, B, { status: 'failed', message: 'provider down' });

    expect(selectBundleTotals(state).totalValueUsd).toBe('100.00000000');
    expect(selectFailedMembers(state)).toEqual([{ address: B, message: 'provider down' }]);
  });

  it('is null rather than zero when nothing could be priced', () => {
    // Zero is a claim that the wallets hold nothing.
    let state = bundleOf([A, B]);
    for (const address of [A, B]) {
      state = recordBundleMember(state, address, {
        status: 'loaded',
        aggregate: aggregate({ totalValueUsd: null }),
      });
    }
    expect(selectBundleTotals(state).totalValueUsd).toBeNull();
  });

  it('sums beyond float precision exactly', () => {
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({ totalValueUsd: '9007199254740993.00000000' }),
    });
    state = recordBundleMember(state, B, {
      status: 'loaded',
      aggregate: aggregate({ totalValueUsd: '1.00000000' }),
    });
    expect(selectBundleTotals(state).totalValueUsd).toBe('9007199254740994.00000000');
  });

  it('sums the counts too, so the summary can describe what it covers', () => {
    let state = bundleOf([A, B]);
    for (const address of [A, B]) {
      state = recordBundleMember(state, address, {
        status: 'loaded',
        aggregate: aggregate({ assetCount: 3, pricedAssetCount: 2, unpricedAssetCount: 1 }),
      });
    }
    const totals = selectBundleTotals(state);
    expect(totals.assetCount).toBe(6);
    expect(totals.unpricedAssetCount).toBe(2);
  });
});

describe('conclusion — what the bundle may say about itself', () => {
  it('says nothing while a member is still loading', () => {
    // "No assets found" here would speak for a wallet nobody has read yet.
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({ assetCount: 0, totalValueUsd: null }),
    });
    expect(selectBundleConclusion(state)).toBe('pending');
  });

  it('distinguishes every-member-failed from every-member-empty', () => {
    // The first is a load failure; the second is a fact about the wallets. Rendering
    // the first as "no prices available" would be a claim about prices.
    let allFailed = bundleOf([A, B]);
    for (const address of [A, B]) {
      allFailed = recordBundleMember(allFailed, address, { status: 'failed', message: 'down' });
    }
    expect(selectBundleConclusion(allFailed)).toBe('all-failed');

    let allEmpty = bundleOf([A, B]);
    for (const address of [A, B]) {
      allEmpty = recordBundleMember(allEmpty, address, {
        status: 'loaded',
        aggregate: aggregate({ assetCount: 0, pricedAssetCount: 0, totalValueUsd: null }),
      });
    }
    expect(selectBundleConclusion(allEmpty)).toBe('empty');
  });

  it('reports holdings once at least one readable member has any', () => {
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, { status: 'loaded', aggregate: aggregate() });
    state = recordBundleMember(state, B, { status: 'failed', message: 'down' });
    expect(selectBundleConclusion(state)).toBe('holdings');
  });
});

describe('freshness', () => {
  it('takes the oldest member chain, not the aggregate stamp', () => {
    // The aggregate endpoint stamps assembly time even when its chains came from a
    // nearly-expired cache, so trusting it would print "updated just now" about
    // minute-old data.
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({
        fetchedAt: '2026-08-03T12:00:00.000Z',
        chains: [chain({ fetchedAt: '2026-08-03T11:59:01.000Z' })],
      }),
    });
    state = recordBundleMember(state, B, {
      status: 'loaded',
      aggregate: aggregate({
        fetchedAt: '2026-08-03T12:00:00.000Z',
        chains: [chain({ fetchedAt: '2026-08-03T12:00:00.000Z' })],
      }),
    });

    expect(selectBundleFetchedAt(state)).toBe('2026-08-03T11:59:01.000Z');
  });

  it('is null when nothing readable has arrived', () => {
    expect(selectBundleFetchedAt(bundleOf([A]))).toBeNull();
  });

  it('ignores an unparseable timestamp rather than sorting on it', () => {
    let state = bundleOf([A]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({ chains: [chain({ fetchedAt: 'whenever' })] }),
    });
    expect(selectBundleFetchedAt(state)).toBeNull();
  });
});

describe('fx rate', () => {
  it('converts when every readable member agrees', () => {
    let state = bundleOf([A, B]);
    for (const address of [A, B]) {
      state = recordBundleMember(state, address, {
        status: 'loaded',
        aggregate: aggregate({ fxRate: RATE }),
      });
    }
    expect(selectBundleFxRate(state)).toEqual(RATE);
  });

  it('offers no rate when members disagree on the date', () => {
    // Two figures on one page converted at different rates is worse than no
    // conversion at all.
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({ fxRate: RATE }),
    });
    state = recordBundleMember(state, B, {
      status: 'loaded',
      aggregate: aggregate({ fxRate: { ...RATE, asOf: '2026-07-25' } }),
    });
    expect(selectBundleFxRate(state)).toBeNull();
  });

  it('offers no rate when one member could not fetch one', () => {
    // That member carries a warning saying figures are dollars only; showing euro
    // beside it would contradict it.
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({ fxRate: RATE }),
    });
    state = recordBundleMember(state, B, {
      status: 'loaded',
      aggregate: aggregate({ fxRate: null }),
    });
    expect(selectBundleFxRate(state)).toBeNull();
  });

  it('ignores a failed member when deciding', () => {
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({ fxRate: RATE }),
    });
    state = recordBundleMember(state, B, { status: 'failed', message: 'down' });
    expect(selectBundleFxRate(state)).toEqual(RATE);
  });
});

describe('warnings', () => {
  it('carries a member’s coverage caveat into the bundle, named by wallet', () => {
    // A wallet can be read and still have enumerated only a bundled token list. A
    // headline without that caveat claims more completeness than it has.
    let state = bundleOf([A]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({
        chains: [
          chain({
            warnings: [{ code: 'coverage.token-list', message: 'Checked a fixed list.' }],
          }),
        ],
      }),
    });

    const warnings = selectBundleWarnings(state);
    expect(warnings[0]?.message).toContain('Checked a fixed list.');
    expect(warnings[0]?.message).toContain('0xd8dA');
  });

  it('collapses an identical warning from several wallets into one line', () => {
    let state = bundleOf([A, B]);
    for (const address of [A, B]) {
      state = recordBundleMember(state, address, {
        status: 'loaded',
        aggregate: aggregate({
          chains: [chain({ warnings: [{ code: 'coverage.token-list', message: 'Same text.' }] })],
        }),
      });
    }

    const warnings = selectBundleWarnings(state);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe('Several wallets: Same text.');
  });

  it('keeps two differing messages that share a code', () => {
    // The same code carries different specifics per chain — "1,037 Arbitrum tokens"
    // against "5,078 Ethereum" — and collapsing those would drop information.
    let state = bundleOf([A]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({
        chains: [
          chain({ warnings: [{ code: 'coverage.token-list', message: '5,078 Ethereum.' }] }),
          chain({ warnings: [{ code: 'coverage.token-list', message: '1,037 Arbitrum.' }] }),
        ],
      }),
    });
    expect(selectBundleWarnings(state)).toHaveLength(2);
  });

  it('says nothing for a member that has not arrived', () => {
    expect(selectBundleWarnings(bundleOf([A]))).toEqual([]);
  });
});

describe('breakdown', () => {
  it('ranks wallets by value, largest first', () => {
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({ totalValueUsd: '10.00000000' }),
    });
    state = recordBundleMember(state, B, {
      status: 'loaded',
      aggregate: aggregate({ totalValueUsd: '90.00000000' }),
    });
    expect(selectBundleBreakdown(state)[0]?.address).toBe(B);
  });

  it('keeps a failed or valueless wallet on the list, last', () => {
    // Never hidden: a wallet that could not be read is exactly what the reader needs
    // to see.
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, { status: 'failed', message: 'down' });
    state = recordBundleMember(state, B, {
      status: 'loaded',
      aggregate: aggregate({ totalValueUsd: '90.00000000' }),
    });

    const breakdown = selectBundleBreakdown(state);
    expect(breakdown).toHaveLength(2);
    expect(breakdown[1]?.address).toBe(A);
  });

  it('ranks by decimal value, not lexically', () => {
    let state = bundleOf([A, B]);
    state = recordBundleMember(state, A, {
      status: 'loaded',
      aggregate: aggregate({ totalValueUsd: '9.00000000' }),
    });
    state = recordBundleMember(state, B, {
      status: 'loaded',
      aggregate: aggregate({ totalValueUsd: '10.00000000' }),
    });
    expect(selectBundleBreakdown(state)[0]?.address).toBe(B);
  });
});
