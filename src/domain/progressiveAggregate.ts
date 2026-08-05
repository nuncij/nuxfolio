import type { WalletAddress } from './address';
import { chainFailureKindFromApiError, chainFailureMessage } from './chainFailure';
import { buildAggregatePortfolio } from './normalize';
import type { AggregatePortfolio, ApiError, Portfolio } from './portfolio';

/**
 * Assembling an all-networks view from per-chain results as they arrive.
 *
 * The browser requests one chain at a time, concurrently, so results land in
 * whatever order the networks happen to answer in. Everything here is a pure
 * function over the results collected so far, which buys two properties worth
 * stating:
 *
 *  - **Order independence.** The rendered aggregate is derived by walking the
 *    requested chains in registry order, never the arrival order, so the final
 *    view for a given set of results is the same view the server's
 *    `?chainId=all` path would have built from them — and an intermediate view
 *    is a prefix of that answer, not a different one.
 *  - **Testability.** Progressive rendering is exactly the behaviour that is
 *    awkward to reach through a live provider, so the assembly is unit-tested
 *    without React and without a network.
 *
 * The arithmetic is not repeated here: `buildAggregatePortfolio` sums the
 * subtotals and the counts, as it does on the server.
 */

/** A network the view is waiting for. The order of this list is registry order. */
export type RequestedChain = {
  readonly chainId: number;
  /** The network's full name, as `Portfolio.chainName` carries it. */
  readonly name: string;
};

/** What one per-chain request settled as. */
export type ChainLoadResult =
  | { readonly chainId: number; readonly ok: true; readonly portfolio: Portfolio }
  | { readonly chainId: number; readonly ok: false; readonly error: ApiError['error'] };

export type ProgressiveAggregateState = {
  readonly address: WalletAddress;
  readonly requested: readonly RequestedChain[];
  readonly results: ReadonlyMap<number, ChainLoadResult>;
};

/** How much of the view has arrived, for the "loading…" label. */
export type AggregateProgress = {
  /** Requests that have finished, successfully or not. */
  readonly settled: number;
  /** Requests that produced a portfolio. */
  readonly loaded: number;
  /** Requests that failed and are reported as unavailable networks. */
  readonly failed: number;
  readonly total: number;
  readonly complete: boolean;
};

export function createProgressiveAggregate(input: {
  address: WalletAddress;
  chains: readonly RequestedChain[];
}): ProgressiveAggregateState {
  return { address: input.address, requested: [...input.chains], results: new Map() };
}

/**
 * Adds one settled request. Returns a new state; nothing is mutated, so a
 * caller can keep an earlier state to compare against.
 *
 * A result for a chain the view did not request is dropped: the request set is
 * fixed when the view mounts, so an unrecognised id could only add a network to
 * the total that the user never asked for. A repeat result for a chain already
 * settled replaces it, which is what a refresh needs.
 */
export function recordChainResult(
  state: ProgressiveAggregateState,
  result: ChainLoadResult,
): ProgressiveAggregateState {
  if (!state.requested.some((chain) => chain.chainId === result.chainId)) {
    return state;
  }

  const results = new Map(state.results);
  results.set(result.chainId, result);
  return { ...state, results };
}

export function selectAggregateProgress(state: ProgressiveAggregateState): AggregateProgress {
  const settled = [...state.results.values()];
  const loaded = settled.filter((result) => result.ok).length;

  return {
    settled: settled.length,
    loaded,
    failed: settled.length - loaded,
    total: state.requested.length,
    complete: settled.length >= state.requested.length,
  };
}

/**
 * The view built from what has arrived, or null while nothing has.
 *
 * Null rather than an empty aggregate: an aggregate with no chains would render
 * as a portfolio worth nothing, and "we have not read anything yet" is a
 * different statement from "there is nothing there". The server draws the same
 * line by failing the request when no chain could be read.
 */
export function selectAggregatePortfolio(
  state: ProgressiveAggregateState,
): AggregatePortfolio | null {
  const chains: Portfolio[] = [];
  const failedChains: { chainId: number; chainName: string; message: string }[] = [];

  // Registry order, not arrival order: this is the ordering guarantee.
  for (const requested of state.requested) {
    const result = state.results.get(requested.chainId);
    if (result === undefined) {
      continue;
    }
    if (result.ok) {
      chains.push(result.portfolio);
    } else {
      failedChains.push({
        chainId: requested.chainId,
        chainName: requested.name,
        message: chainFailureMessage(chainFailureKindFromApiError(result.error.code)),
      });
    }
  }

  if (chains.length === 0) {
    return null;
  }

  return buildAggregatePortfolio({
    address: state.address,
    chains,
    failedChains,
    fetchedAt: oldestFetchedAt(chains),
  });
}

/**
 * The failure to show when the whole view failed, or null while any part of it
 * still stands.
 *
 * Mirrors the server rule: one network failing costs the user that network, but
 * every network failing leaves nothing to render, so it surfaces as an error the
 * user can retry. The first failure in registry order is reported — deliberately
 * not the first to arrive, so that the same set of failures always produces the
 * same message.
 */
export function selectAggregateError(state: ProgressiveAggregateState): ApiError['error'] | null {
  const progress = selectAggregateProgress(state);
  if (!progress.complete || progress.loaded > 0) {
    return null;
  }

  for (const requested of state.requested) {
    const result = state.results.get(requested.chainId);
    if (result !== undefined && !result.ok) {
      return result.error;
    }
  }

  // No chain loaded and no chain failed: the view was asked for no networks at
  // all. Unreachable through the chain registry, but silence would be worse than
  // a sentence the user can act on.
  return NO_NETWORK_REQUESTED;
}

const NO_NETWORK_REQUESTED: ApiError['error'] = {
  code: 'upstream-unavailable',
  message: 'No network could be read right now. Please try again shortly.',
};

/**
 * The aggregate is stamped with the oldest per-chain timestamp rather than with
 * "now": each chain answers with the moment its own data was assembled, some of
 * it from cache, and the combined view is only as current as its stalest part.
 * Deriving the timestamp from the results is also what keeps this module pure —
 * the same results produce the same aggregate, in any arrival order.
 */
function oldestFetchedAt(chains: readonly Portfolio[]): string {
  let oldest = chains[0]?.fetchedAt ?? '';
  let oldestMs = Date.parse(oldest);

  for (const portfolio of chains) {
    const candidateMs = Date.parse(portfolio.fetchedAt);
    if (Number.isNaN(candidateMs)) {
      continue;
    }
    if (Number.isNaN(oldestMs) || candidateMs < oldestMs) {
      oldest = portfolio.fetchedAt;
      oldestMs = candidateMs;
    }
  }

  return oldest;
}
