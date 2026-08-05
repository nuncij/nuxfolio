import {
  aggregateResponseSchema,
  apiErrorSchema,
  ALL_CHAINS,
  portfolioResponseSchema,
  type AggregatePortfolio,
  type ApiError,
  type Portfolio,
} from '@/domain/portfolio';
import type { ChainLoadResult } from '@/domain/progressiveAggregate';

/**
 * The browser's client for `/api/portfolio`.
 *
 * Kept out of the component so that request handling, response validation and
 * error mapping are testable without rendering React, and so the component is
 * left with nothing but state transitions.
 *
 * Failures are returned, not thrown: every outcome here is a state the UI has
 * to render, so making the caller write a try/catch would only invite one of
 * those states to be forgotten.
 */

export type PortfolioFetchResult =
  | { ok: true; portfolio: Portfolio; aggregate: null; cached: boolean }
  | { ok: true; portfolio: null; aggregate: AggregatePortfolio; cached: boolean }
  | { ok: false; error: ApiError['error'] };

/** A chain id, or the sentinel asking for every supported network at once. */
export type ChainSelection = number | typeof ALL_CHAINS;

const UNREADABLE_RESPONSE: ApiError['error'] = {
  code: 'internal',
  message: 'Nuxfolio received an unexpected response. Please try again.',
};

const UNREADABLE_PORTFOLIO: ApiError['error'] = {
  code: 'internal',
  message: 'Nuxfolio received portfolio data it could not read. Please try again.',
};

const NETWORK_FAILURE: ApiError['error'] = {
  code: 'upstream-unavailable',
  message: 'Nuxfolio could not reach the server. Check your connection and try again.',
};

/** Signals that the caller aborted; the caller should leave state untouched. */
export const ABORTED = Symbol('aborted');

export async function fetchPortfolioFromApi(input: {
  address: string;
  chainId: ChainSelection;
  // Explicitly `| undefined` so a caller fanning out over several chains can
  // forward an optional signal without rebuilding the argument object
  // (`exactOptionalPropertyTypes` is on).
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof globalThis.fetch | undefined;
}): Promise<PortfolioFetchResult | typeof ABORTED> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const query = new URLSearchParams({
    address: input.address,
    chainId: String(input.chainId),
  });

  let response: Response;
  try {
    response = await fetchImpl(`/api/portfolio?${query.toString()}`, {
      signal: input.signal ?? null,
      headers: { accept: 'application/json' },
    });
  } catch (caught) {
    if (isAbortError(caught)) {
      return ABORTED;
    }
    return { ok: false, error: NETWORK_FAILURE };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (caught) {
    if (isAbortError(caught)) {
      return ABORTED;
    }
    return { ok: false, error: UNREADABLE_RESPONSE };
  }

  if (!response.ok) {
    const parsed = apiErrorSchema.safeParse(payload);
    return { ok: false, error: parsed.success ? parsed.data.error : UNREADABLE_RESPONSE };
  }

  // The success body is validated against the same schema the server produced
  // it from, so an API change surfaces as a clear failure rather than as
  // `undefined` rendered into the asset table.
  if (input.chainId === ALL_CHAINS) {
    const parsed = aggregateResponseSchema.safeParse(payload);
    return parsed.success
      ? { ok: true, portfolio: null, aggregate: parsed.data.aggregate, cached: parsed.data.cached }
      : { ok: false, error: UNREADABLE_PORTFOLIO };
  }

  const parsed = portfolioResponseSchema.safeParse(payload);
  return parsed.success
    ? { ok: true, portfolio: parsed.data.portfolio, aggregate: null, cached: parsed.data.cached }
    : { ok: false, error: UNREADABLE_PORTFOLIO };
}

/**
 * Requests every chain at once through the single-chain endpoint, reporting each
 * one the moment it settles.
 *
 * **What this costs.** An all-networks view spends one rate-limit token per
 * network — five today, against `RATE_LIMIT_MAX_REQUESTS` (default 30 per
 * minute) — where the server-side `?chainId=all` path spends exactly one. The
 * upstream provider load is unchanged: both paths read the same per-chain server
 * cache, so the extra requests are cheap for everyone except the rate limiter.
 * The trade is deliberate — it is what lets a fast network render without
 * waiting for the slowest one — and the aggregate endpoint remains the
 * single-request alternative for API callers who prefer one round trip. A chain
 * the limiter refuses comes back as one unavailable network rather than as a
 * failed view, so exhausting the budget degrades the page instead of emptying
 * it.
 *
 * Failures are per chain and never rejected: the returned promise settles once
 * every request has, and a chain that failed is reported as a failure. Aborted
 * requests are reported not at all — their view is going away.
 */
export async function fetchChainPortfolios(input: {
  address: string;
  chainIds: readonly number[];
  /** Called once per chain, in arrival order, as each request settles. */
  onSettled?: ((result: ChainLoadResult) => void) | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof globalThis.fetch | undefined;
}): Promise<readonly ChainLoadResult[]> {
  const settled = await Promise.all(
    input.chainIds.map(async (chainId) => {
      const result = await fetchPortfolioFromApi({
        address: input.address,
        chainId,
        signal: input.signal,
        fetchImpl: input.fetchImpl,
      });

      if (result === ABORTED) {
        return null;
      }

      const outcome = toChainLoadResult(chainId, result);
      input.onSettled?.(outcome);
      return outcome;
    }),
  );

  // In `chainIds` order, whatever order the requests came back in.
  return settled.filter((outcome): outcome is ChainLoadResult => outcome !== null);
}

function toChainLoadResult(chainId: number, result: PortfolioFetchResult): ChainLoadResult {
  if (!result.ok) {
    return { chainId, ok: false, error: result.error };
  }

  // A numeric `chainId` is answered with a single-chain body, and the response is
  // validated against the schema for it. Either surprise here — an aggregate
  // body, or a portfolio for a chain other than the one asked for — would put a
  // network's assets under the wrong name, so it is treated as unreadable.
  if (result.portfolio === null || result.portfolio.chainId !== chainId) {
    return { chainId, ok: false, error: UNREADABLE_PORTFOLIO };
  }

  return { chainId, ok: true, portfolio: result.portfolio };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * Members loaded at once for a bundle.
 *
 * Two, deliberately low. Each member is a `?chainId=all` request, and the server
 * scans that wallet's networks at `CHAIN_SCAN_CONCURRENCY` (3) — a setting that is
 * per **request**, so nothing before this bounded ten wallets' worth of upstream work
 * opening simultaneously. Ten members at once would permit thirty concurrent chain
 * loads from a single link.
 *
 * The page still fills progressively; it simply does not start everything at once.
 */
export const BUNDLE_MEMBER_CONCURRENCY = 2;

export type BundleMemberLoad = {
  readonly address: string;
  /**
   * Never `ABORTED`: an aborted member is not reported at all, because its view is
   * going away. Encoded in the type so no caller has to re-establish it.
   */
  readonly result: PortfolioFetchResult;
};

/**
 * Loads each wallet of a bundle, at most {@link BUNDLE_MEMBER_CONCURRENCY} at a time.
 *
 * Uses the aggregate endpoint once per wallet rather than one request per network.
 * Both paths do the same cold work and share the same per-chain server cache, so this
 * is not cheaper upstream — it is fewer round trips and, with the bound below, a
 * fan-out that cannot multiply.
 *
 * Deliberately does **not** reuse `server/concurrency.ts`: nothing in `lib/` imports
 * from `server/`, and keeping it that way is what stops server code drifting into the
 * browser bundle. The eight lines below are the price of that boundary.
 *
 * Never rejects. A member that failed is reported as a failure; an aborted one is not
 * reported at all, because its view is going away.
 */
export async function fetchBundleMembers(input: {
  addresses: readonly string[];
  onSettled?: ((load: BundleMemberLoad) => void) | undefined;
  concurrency?: number | undefined;
  signal?: AbortSignal | undefined;
  fetchImpl?: typeof globalThis.fetch | undefined;
}): Promise<readonly BundleMemberLoad[]> {
  const limit = Math.max(1, input.concurrency ?? BUNDLE_MEMBER_CONCURRENCY);
  const settled: BundleMemberLoad[] = [];
  let next = 0;

  async function worker(): Promise<void> {
    while (next < input.addresses.length) {
      const address = input.addresses[next];
      next += 1;
      if (address === undefined) {
        return;
      }

      const result = await fetchPortfolioFromApi({
        address,
        chainId: ALL_CHAINS,
        signal: input.signal,
        fetchImpl: input.fetchImpl,
      });

      if (result === ABORTED) {
        continue;
      }
      const load: BundleMemberLoad = { address, result };
      settled.push(load);
      input.onSettled?.(load);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, input.addresses.length) }, worker));
  return settled;
}
