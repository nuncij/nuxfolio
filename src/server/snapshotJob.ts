import 'server-only';

import type { WalletAddress } from '@/domain/address';
import type { AggregatePortfolio } from '@/domain/portfolio';

import type { Logger } from './logger';
import type { Snapshot, SnapshotStore } from './snapshotStore';

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
 */
function toSnapshots(aggregate: AggregatePortfolio, capturedAt: string): readonly Snapshot[] {
  return aggregate.chains.map((chain) => ({
    address: aggregate.address,
    chainId: chain.chainId,
    capturedAt,
    totalValueUsd: chain.totalValueUsd,
    netOfAaveDebtUsd: chain.netOfAaveDebtUsd,
    assetCount: chain.assetCount,
    pricedCount: chain.pricedAssetCount,
    coverage: chain.coverage,
  }));
}
