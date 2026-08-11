import { describe, expect, it, vi } from 'vitest';

import type { WalletAddress } from '@/domain/address';
import type { AggregatePortfolio, Portfolio } from '@/domain/portfolio';
import { TEST_ADDRESS } from '@/test/helpers';

import { captureSnapshots } from './snapshotJob';
import { openSnapshotStore } from './snapshotStore';

const AT = '2026-08-10T09:00:00.000Z';
const now = () => new Date(AT);

function chain(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    address: TEST_ADDRESS,
    chainId: 1,
    chainName: 'Ethereum Mainnet',
    protocolAccounts: [],
    stakedPositions: [],
    stakedStatus: 'unavailable',
    totalValueUsd: '17604.90314556',
    netOfAaveDebtUsd: '9523.39497980',
    assetCount: 4,
    pricedAssetCount: 4,
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
    fetchedAt: AT,
    warnings: [],
    ...overrides,
  };
}

function aggregate(overrides: Partial<AggregatePortfolio> = {}): AggregatePortfolio {
  return {
    address: TEST_ADDRESS,
    totalValueUsd: '17604.90314556',
    netOfAaveDebtUsd: '9523.39497980',
    assetCount: 4,
    pricedAssetCount: 4,
    unpricedAssetCount: 0,
    suspectAssetCount: 0,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    chains: [chain(), chain({ chainId: 8453, chainName: 'Base', totalValueUsd: '0.04' })],
    failedChains: [],
    fxRate: null,
    fetchedAt: AT,
    ...overrides,
  } as AggregatePortfolio;
}

const run = (
  load: Parameters<typeof captureSnapshots>[0]['load'],
  store = openSnapshotStore(':memory:'),
) =>
  captureSnapshots({ wallets: [TEST_ADDRESS], load, store, now }).then((outcome) => ({
    outcome,
    store,
  }));

describe('captureSnapshots', () => {
  it('writes one row per chain, stamped with a single instant', async () => {
    // The chains finish milliseconds apart; a shared timestamp is what makes the rows
    // recognisable as one reading rather than five.
    const { outcome, store } = await run(async () => aggregate());

    expect(outcome.captured).toBe(1);
    const rows = store.history(TEST_ADDRESS);
    expect(rows.map((row) => row.chainId)).toEqual([1, 8453]);
    expect(new Set(rows.map((row) => row.capturedAt))).toEqual(new Set([AT]));
  });

  it('stores the total as the net for a chain that owes nothing', async () => {
    // The page's field is null for a debt-free chain (a second copy of the total says
    // nothing, ADR-029), but in storage that null would be ambiguous with "could not
    // be computed" and would drop the chain from any summed net (round 15). The job
    // recomputes the reason and stores what a net of zero debt is: the total.
    const { store } = await run(async () => aggregate());

    expect(store.history(TEST_ADDRESS)[0]).toMatchObject({
      totalValueUsd: '17604.90314556',
      netOfAaveDebtUsd: '17604.90314556',
    });
  });

  it('stores null for a chain whose market could not be read', async () => {
    // A failed market may hide debt, so "no debt visible" must not become "no debt".
    const failedMarket = {
      chainId: 1,
      protocol: 'aave-v3' as const,
      marketId: '1:core',
      marketName: 'Aave v3 Core',
      status: 'failed' as const,
      collateralValueUsd: null,
      borrowedValueUsd: null,
      healthFactor: null,
      positions: [],
      positionsStatus: 'failed' as const,
      rewards: [],
      rewardsStatus: 'failed' as const,
    };
    const { store } = await run(async () =>
      aggregate({ chains: [chain({ protocolAccounts: [failedMarket] })] }),
    );

    expect(store.history(TEST_ADDRESS)[0]).toMatchObject({
      totalValueUsd: '17604.90314556',
      netOfAaveDebtUsd: null,
    });
  });

  it('writes nothing for a wallet whose network failed', async () => {
    // A total missing one network is smaller than the truth. Stored, it would draw a
    // loss on the chart that never happened; missing, it is a gap the chart can show.
    const { outcome, store } = await run(async () =>
      aggregate({
        failedChains: [{ chainId: 8453, chainName: 'Base', message: 'unavailable' }],
      }),
    );

    expect(outcome.captured).toBe(0);
    expect(outcome.skipped[0]?.reason).toMatch(/could not be read/);
    expect(store.history(TEST_ADDRESS)).toEqual([]);
  });

  it('writes nothing when the load throws, and says which wallet', async () => {
    const { outcome, store } = await run(async () => {
      throw new Error('upstream is down');
    });

    expect(outcome.captured).toBe(0);
    expect(outcome.skipped).toEqual([{ address: TEST_ADDRESS, reason: 'Error' }]);
    expect(store.history(TEST_ADDRESS)).toEqual([]);
  });

  it('keeps going after one wallet fails', async () => {
    // One unreachable wallet must not cost the others their day.
    // Deliberately not the shared `TEST_ADDRESS`, which is vitalik's — an earlier
    // version of this test used it as the "other" wallet, so both entries were the same
    // address and both threw.
    const OTHER = '0xF635aaEE995E61102Dd237Fd3AE66EEAf7EA7054' as WalletAddress;
    const store = openSnapshotStore(':memory:');
    const load = vi.fn(async (address: WalletAddress) => {
      if (address === TEST_ADDRESS) throw new Error('nope');
      return aggregate({ address: OTHER, chains: [chain({ address: OTHER })] });
    });

    const outcome = await captureSnapshots({
      wallets: [TEST_ADDRESS, OTHER],
      load,
      store,
      now,
    });

    expect(outcome.captured).toBe(1);
    expect(store.history(OTHER)).toHaveLength(1);
    expect(store.history(TEST_ADDRESS)).toEqual([]);
  });

  it('is a no-op with nothing configured', async () => {
    const load = vi.fn();
    const outcome = await captureSnapshots({
      wallets: [],
      load: load as never,
      store: openSnapshotStore(':memory:'),
      now,
    });

    expect(outcome).toEqual({ captured: 0, skipped: [] });
    expect(load).not.toHaveBeenCalled();
  });

  it('re-running the same day changes nothing', async () => {
    // The property the whole day-keyed schema exists for: a retry is free.
    const store = openSnapshotStore(':memory:');
    await run(async () => aggregate(), store);
    await run(async () => aggregate(), store);

    expect(store.history(TEST_ADDRESS)).toHaveLength(2); // two chains, one day
  });
});
