import type { AggregatePortfolio, ApiError, Portfolio } from './portfolio';
import { hasPosition } from './protocolAccount';

/**
 * The dashboard's state machine, as a pure function.
 *
 * Keeping this out of the component means each state — including the awkward
 * ones like "loaded but nothing to show" and "loaded but nothing could be
 * priced" — is unit-testable without rendering anything. UI states that are
 * only reachable through a live provider outage are exactly the states that
 * otherwise never get tested.
 *
 * A single-chain view and an all-networks view share the machine: what differs
 * is the payload, not the states it can be in.
 */

/** What the view is displaying, whichever chain selection produced it. */
export type PortfolioData =
  { scope: 'chain'; portfolio: Portfolio } | { scope: 'aggregate'; aggregate: AggregatePortfolio };

export type PortfolioViewState =
  /** No request has been made yet. */
  | { kind: 'idle' }
  /** A request is in flight and there is nothing to show yet. */
  | { kind: 'loading' }
  /** The wallet is valid but holds nothing the provider can see. */
  | { kind: 'empty'; data: PortfolioData }
  /** Data arrived and at least one asset could be priced. */
  | { kind: 'ready'; data: PortfolioData }
  /** Data arrived but no asset could be priced; quantities only. */
  | { kind: 'unpriced'; data: PortfolioData }
  /** The request failed; nothing can be shown. */
  | { kind: 'error'; error: ApiError['error']; retryable: boolean };

const RETRYABLE_ERROR_CODES = new Set<ApiError['error']['code']>([
  'rate-limited',
  'upstream-rate-limited',
  'upstream-unavailable',
  'upstream-invalid-response',
  'timeout',
  'internal',
]);

export function selectPortfolioViewState(input: {
  requested: boolean;
  loading: boolean;
  data: PortfolioData | null;
  error: ApiError['error'] | null;
}): PortfolioViewState {
  if (input.error !== null) {
    return {
      kind: 'error',
      error: input.error,
      retryable: RETRYABLE_ERROR_CODES.has(input.error.code),
    };
  }

  // Keep showing the previous data while a refresh is in flight; replacing it
  // with a skeleton would make a manual refresh feel like data loss.
  if (input.loading && input.data === null) {
    return { kind: 'loading' };
  }

  if (input.data === null) {
    return input.requested ? { kind: 'loading' } : { kind: 'idle' };
  }

  const counts = countAssets(input.data);

  if (counts.assetCount === 0 && !holdsSomethingElsewhere(input.data)) {
    return { kind: 'empty', data: input.data };
  }
  if (counts.pricedAssetCount === 0) {
    return { kind: 'unpriced', data: input.data };
  }
  return { kind: 'ready', data: input.data };
}

function countAssets(data: PortfolioData): { assetCount: number; pricedAssetCount: number } {
  const source = data.scope === 'chain' ? data.portfolio : data.aggregate;
  return { assetCount: source.assetCount, pricedAssetCount: source.pricedAssetCount };
}

/**
 * Whether a protocol holds something for this wallet, whatever its token balances say.
 *
 * `empty` used to mean "no assets", which was the same thing until milestone 5. It is
 * not any more: a wallet can hold a Convex position — the LP is owned by Convex's reward
 * contract — or an Aave position with no receipt token, and see a balance read return
 * nothing at all. Verified against a real staker on 2026-08-08 whose entire visible
 * portfolio was empty while $45,035 sat in one Arbitrum pool, and who was shown
 * "No assets found".
 *
 * A failed staking read counts too. It is the one state where the wallet might hold
 * something and the page cannot say, which is precisely when "nothing here" is the
 * wrong sentence.
 */
function holdsSomethingElsewhere(data: PortfolioData): boolean {
  const chains = data.scope === 'chain' ? [data.portfolio] : data.aggregate.chains;

  return chains.some(
    (chain) =>
      chain.protocolAccounts.some(hasPosition) ||
      chain.stakedPositions.length > 0 ||
      chain.stakedStatus === 'failed',
  );
}
