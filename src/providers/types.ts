import type { ChainConfig } from '@/config/chains';
import type { WalletAddress } from '@/domain/address';
import type { FxQuote, PortfolioCoverage, PortfolioWarning } from '@/domain/portfolio';
import type { Deadline } from '@/server/deadline';
import type { Logger } from '@/server/logger';

/**
 * Provider contracts.
 *
 * Adapters translate one external API into these shapes and nothing more. No
 * raw provider payload, URL, header or error object crosses this boundary, so
 * swapping a provider cannot ripple into the service layer or the UI.
 */

/** Injected so adapters are testable without a network and cancellable. */
export type ProviderContext = {
  readonly deadline: Deadline;
  readonly fetch: typeof globalThis.fetch;
  readonly logger: Logger;
  /**
   * Hard ceiling on assets an adapter may return. Discovery is unbounded by
   * nature — anyone can airdrop tokens into any wallet — so the ceiling lives
   * in the context rather than in each adapter's own constants.
   */
  readonly maxAssets: number;
  /**
   * Age in days past which a bundled token list is reported as aged. Deployment
   * policy read from the environment, like {@link maxAssets}, rather than a
   * constant inside one adapter; adapters that discover tokens through an index
   * instead of a bundled list ignore it.
   */
  readonly tokenListMaxAgeDays: number;
};

/** A balance exactly as read from the chain: base units, no valuation. */
export type RawBalance = {
  readonly chainId: number;
  /** Null identifies the chain's native asset. */
  readonly contractAddress: WalletAddress | null;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly raw: bigint;
  readonly logoUrl: string | null;
};

export type BalanceSnapshot = {
  readonly providerId: string;
  readonly chainId: number;
  /** Honest statement of what the provider could and could not see. */
  readonly coverage: PortfolioCoverage;
  readonly balances: readonly RawBalance[];
  readonly warnings: readonly PortfolioWarning[];
};

export interface PortfolioProvider {
  readonly id: string;
  supportsChain(chainId: number): boolean;
  fetchBalances(input: {
    address: WalletAddress;
    chain: ChainConfig;
    context: ProviderContext;
  }): Promise<BalanceSnapshot>;
}

/**
 * A vendor-neutral asset identity. Price adapters map this onto whatever
 * namespace their API uses; no vendor concept appears in chain config or in
 * the service layer. See docs/DECISIONS.md, ADR-005.
 */
export type PriceRef = {
  readonly chainId: number;
  /** Null identifies the chain's native asset. */
  readonly contractAddress: WalletAddress | null;
};

export type PriceQuote = {
  readonly priceUsd: string;
  /**
   * ISO 8601 timestamp reported by the provider, or null when it reports none.
   * Null means "age unknown", which is not the same as "fresh".
   */
  readonly updatedAt: string | null;
  /** 0-1 when the provider reports one, otherwise null. */
  readonly confidence: number | null;
};

export type PriceLookup = {
  readonly providerId: string;
  /** Keyed by {@link priceRefKey}. Missing entries mean "no price known". */
  readonly quotes: ReadonlyMap<string, PriceQuote>;
  readonly warnings: readonly PortfolioWarning[];
};

export interface PriceProvider {
  readonly id: string;
  fetchPrices(input: {
    chain: ChainConfig;
    refs: readonly PriceRef[];
    context: ProviderContext;
  }): Promise<PriceLookup>;
  /**
   * Prices as they were at an instant.
   *
   * Optional: a source with no history is still a perfectly good price provider,
   * and the change column simply does not appear. `atUnixSeconds` is what was
   * *asked for* — each quote's own `updatedAt` says what the source actually had,
   * which can be hours away and is why the caller checks the drift.
   */
  fetchHistoricalPrices?(input: {
    chain: ChainConfig;
    refs: readonly PriceRef[];
    atUnixSeconds: number;
    context: ProviderContext;
  }): Promise<AttemptedLookup>;
}

/**
 * A lookup that also reports which refs a request was actually issued for.
 *
 * Shared by the verifier and the historical lookup, because both face the same
 * trap: a ref the adapter never reached looks identical to one the source
 * declined to price, and reporting the first as the second overstates how much
 * was actually established.
 */
export type AttemptedLookup = PriceLookup & {
  /** Keys, per {@link priceRefKey}, of refs a request was actually made for. */
  readonly attemptedRefKeys: ReadonlySet<string>;
};

/**
 * What a verifier returns.
 *
 * `attemptedRefKeys` is what keeps the feature honest: without it, a ref the
 * verifier never got to — because the deadline expired, or its batch failed —
 * looks identical to one it asked about and got no answer for. The first is "not
 * checked", the second is "checked, no opinion", and reporting the first as the
 * second overstates how much verification happened. It would also credit the
 * source for data it never returned.
 */
export type PriceVerification = AttemptedLookup;

/**
 * A second opinion on prices, layered over {@link PriceProvider} rather than
 * replacing it.
 *
 * Structurally a price lookup on purpose: the comparison is between like and
 * like, and a third source needs no new type. A verifier that has no opinion
 * simply returns fewer quotes — that is not a failure.
 */
export interface PriceVerifier {
  readonly id: string;
  verify(input: {
    chain: ChainConfig;
    refs: readonly PriceRef[];
    context: ProviderContext;
  }): Promise<PriceVerification>;
}

/**
 * A foreign-exchange reference rate, as published rather than as of now.
 *
 * `asOf` is the date the *source* attached to the rate, never the moment it was
 * fetched. The ECB publishes on business days only, so a Monday request returns
 * Friday's figure — and a UI that stamped the fetch time on it would claim a
 * freshness nobody offered.
 *
 * `rate` is a decimal string like every other value here, and reads as
 * "1 {base} = {rate} {quote}".
 *
 * Re-exported from the domain rather than redeclared: two structurally identical
 * definitions are two things that can drift apart.
 */
export type { FxQuote };

/**
 * A source of exchange rates.
 *
 * Deliberately narrow: Nuxfolio computes in USD and converts only for display, so
 * one rate is all this ever needs to supply.
 */
export interface RateProvider {
  readonly id: string;
  fetchRate(input: { context: ProviderContext }): Promise<FxQuote>;
}

/** Canonical key for a {@link PriceRef}; lowercased so casing never splits it. */
export function priceRefKey(ref: PriceRef): string {
  return `${ref.chainId}:${ref.contractAddress?.toLowerCase() ?? 'native'}`;
}

export type ProviderErrorKind =
  /** The request exceeded its timeout or the overall deadline. */
  | 'timeout'
  /** The provider answered 429, or told us to slow down. */
  | 'rate-limited'
  /** Network failure, 5xx, or any other transport-level problem. */
  | 'unavailable'
  /** The response parsed as JSON but did not match the expected schema. */
  | 'invalid-response'
  /** Nuxfolio itself is misconfigured — an operator problem, not a user one. */
  | 'misconfigured';

/**
 * The only error type allowed to leave a provider.
 *
 * `message` is written for an operator reading logs. It must never contain a
 * credential or a full provider URL; adapters pass a redacted description.
 */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly providerId: string;
  /** HTTP status, when the failure came from a response rather than transport. */
  status?: number;
  /** Parsed `Retry-After`, in milliseconds. */
  retryAfterMs?: number;

  constructor(
    kind: ProviderErrorKind,
    providerId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ProviderError';
    this.kind = kind;
    this.providerId = providerId;
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

export function coverageIsPartial(coverage: PortfolioCoverage): boolean {
  return coverage !== 'complete';
}
