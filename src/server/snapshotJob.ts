import 'server-only';

import type { ServerEnv } from '@/config/env';
import type { WalletAddress } from '@/domain/address';
import { valueManualEntries } from '@/domain/manual';
import { computeNetOfDebt } from '@/domain/netOfDebt';
import type { AggregatePortfolio } from '@/domain/portfolio';
import { fetchManualRefPrices } from '@/providers/prices/defiLlama';
import type { PriceQuote, ProviderContext } from '@/providers/types';

import { Deadline } from './deadline';
import type { Logger } from './logger';
import { utcDay, type Snapshot, type SnapshotStore } from './snapshotStore';

/**
 * Taking one day's snapshot of the tracked wallets.
 *
 * **A lean load, not the page's load.** The page fetches a second opinion on prices, two
 * historical price batches and a euro rate; a snapshot stores none of those. Reading them
 * anyway would spend the CoinGecko quota ADR-019 budgets for real visitors on a job that
 * throws the answers away — the review put the daily cost at more than the whole monthly
 * allowance for a hundred wallets. Every one of them is already a seam on
 * `PortfolioServiceDependencies`, so skipping them costs nothing but saying so.
 *
 * **A wallet is snapshotted whole or not at all.** If any chain failed, its total is a
 * smaller number than the truth, and storing that would draw a loss on a chart that never
 * happened. The day is simply missing instead, which the chart can show as a gap.
 */

export type SnapshotOutcome = {
  readonly captured: number;
  /** Wallets skipped because a chain could not be read, with the reason for each. */
  readonly skipped: readonly { readonly address: string; readonly reason: string }[];
};

export type LoadAggregate = (address: WalletAddress) => Promise<AggregatePortfolio>;

export async function captureSnapshots(input: {
  wallets: readonly WalletAddress[];
  load: LoadAggregate;
  store: SnapshotStore;
  logger?: Logger;
  now: () => Date;
}): Promise<SnapshotOutcome> {
  const { wallets, load, store, logger, now } = input;

  let captured = 0;
  const skipped: { address: string; reason: string }[] = [];

  // One wallet at a time. Two cores, and the chain-level scan inside each load already
  // runs several networks at once — a second layer of fan-out would multiply load on
  // public endpoints to finish a job nobody is waiting for.
  for (const address of wallets) {
    let aggregate: AggregatePortfolio;
    try {
      aggregate = await load(address);
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown error';
      skipped.push({ address, reason });
      logger?.warn('snapshot.wallet_failed', { address, reason });
      continue;
    }

    if (aggregate.failedChains.length > 0) {
      const reason = `${aggregate.failedChains.length} network(s) could not be read`;
      skipped.push({ address, reason });
      logger?.warn('snapshot.wallet_incomplete', { address, reason });
      continue;
    }

    store.record(toSnapshots(aggregate, now().toISOString()));
    captured += 1;
  }

  logger?.info('snapshot.run_finished', { captured, skipped: skipped.length });
  return { captured, skipped };
}

/**
 * One row per chain, stamped with a single instant.
 *
 * The instant is the job's, not each chain's: the chains finish milliseconds apart and a
 * shared timestamp is what makes the five rows recognisable as one reading. The day they
 * belong to is derived from it inside the store.
 *
 * **The stored net fills in what the page leaves blank.** On the page, a debt-free
 * chain's `netOfAaveDebtUsd` is null because a second copy of the total says nothing
 * (ADR-029). In storage that null would be ambiguous with "could not be computed", and
 * summing across chains would then silently drop every debt-free chain from the
 * aggregate net — review round 15's one high finding. So the reason is recovered here,
 * and a chain that owes nothing stores its total as its net, which is what a net of
 * zero debt is. Null in a stored row always means "not computable".
 */
function toSnapshots(aggregate: AggregatePortfolio, capturedAt: string): readonly Snapshot[] {
  return aggregate.chains.map((chain) => {
    const net = computeNetOfDebt({
      totalValueUsd: chain.totalValueUsd,
      assets: chain.assets,
      accounts: chain.protocolAccounts,
    });
    return {
      address: aggregate.address,
      chainId: chain.chainId,
      capturedAt,
      totalValueUsd: chain.totalValueUsd,
      netOfAaveDebtUsd: net.reason === 'no-debt' ? chain.totalValueUsd : net.valueUsd,
      assetCount: chain.assetCount,
      pricedCount: chain.pricedAssetCount,
      coverage: chain.coverage,
    };
  });
}

/** The identity the manual pseudo-row is stored under. Not a wallet address on
 * purpose: it fails address validation everywhere a wallet is expected, so it
 * cannot leak into any wallet's history (verified in review round 16). */
export const MANUAL_SNAPSHOT_ADDRESS = 'manual';
export const MANUAL_SNAPSHOT_CHAIN_ID = 0;

/**
 * One row per day for the owner's manual entries, written after the wallet
 * rows and independent of them — an empty tracked list must not skip this.
 *
 * The shape was fixed at plan time because history cannot be backfilled:
 * the net equals the total (a reported balance owes Aave nothing, and round 15
 * established that a debt-free total is its net), the counts are entry counts,
 * and coverage says 'manual'. When the last entry is deleted, the same day's
 * row is removed rather than left standing as if it were still true.
 */
export async function captureManualSnapshot(input: {
  store: SnapshotStore;
  env: ServerEnv;
  logger: Logger;
  now: () => Date;
  /** Seam for tests; defaults to the DefiLlama by-ref lookup. */
  fetchQuotes?: (
    refs: readonly string[],
    context: ProviderContext,
  ) => Promise<ReadonlyMap<string, PriceQuote>>;
}): Promise<'recorded' | 'none'> {
  const { store, env, logger, now } = input;

  const entries = store.listManualEntries();
  const capturedAt = now().toISOString();
  const day = utcDay(capturedAt);

  if (entries.length === 0) {
    store.deleteDay(MANUAL_SNAPSHOT_ADDRESS, day, MANUAL_SNAPSHOT_CHAIN_ID);
    return 'none';
  }

  const fetchQuotes =
    input.fetchQuotes ?? ((refs, context) => fetchManualRefPrices({ refs, context }));
  const refs = entries.map((entry) => entry.priceRef).filter((ref): ref is string => ref !== null);
  const quotes = await fetchQuotes(refs, {
    deadline: new Deadline(env.REQUEST_DEADLINE_MS),
    fetch: globalThis.fetch,
    logger,
    maxAssets: env.MAX_ASSETS_PER_PORTFOLIO,
    tokenListMaxAgeDays: env.TOKEN_LIST_MAX_AGE_DAYS,
  });

  const valued = valueManualEntries(entries, quotes, {
    now: now().getTime(),
    confidenceMin: env.PRICE_CONFIDENCE_MIN,
    maxAgeSeconds: env.PRICE_MAX_AGE_SECONDS,
  });

  store.record([
    {
      address: MANUAL_SNAPSHOT_ADDRESS,
      chainId: MANUAL_SNAPSHOT_CHAIN_ID,
      capturedAt,
      totalValueUsd: valued.totalValueUsd,
      netOfAaveDebtUsd: valued.totalValueUsd,
      assetCount: entries.length,
      pricedCount: valued.pricedCount,
      coverage: 'manual',
    },
  ]);

  logger.info('snapshot.manual_recorded', {
    entries: entries.length,
    priced: valued.pricedCount,
  });
  return 'recorded';
}
