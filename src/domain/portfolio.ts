import { z } from 'zod';

import { isDecimalString } from './money';

/**
 * The normalised portfolio domain model and its wire schema.
 *
 * Providers map into these shapes; the API route validates against them before
 * responding; the client validates again after parsing. Monetary and quantity
 * fields are decimal strings — see docs/DECISIONS.md, ADR-003.
 */

const decimalString = z.string().refine(isDecimalString, {
  message: 'Expected a plain decimal string',
});

/** How much of the wallet the balance provider was able to see. */
export const portfolioCoverageSchema = z.enum([
  /** Every token the wallet holds was enumerated by an indexer. */
  'complete',
  /** Only tokens on the bundled list were checked; others are invisible. */
  'token-list',
  /** Discovery hit a configured ceiling, so assets are missing. */
  'truncated',
]);

export type PortfolioCoverage = z.infer<typeof portfolioCoverageSchema>;

/**
 * Whether a quote can be shown as-is, or needs a caveat next to it.
 *
 * `unknown-age` is distinct from `ok`: a provider that reports no timestamp has
 * not told us the quote is fresh, and treating silence as freshness is exactly
 * the quiet claim this product avoids.
 */
export const priceQualitySchema = z.enum(['ok', 'low-confidence', 'stale', 'unknown-age']);

export type PriceQuality = z.infer<typeof priceQualitySchema>;

/**
 * Why an asset is treated as probably not the user's. Both values name a
 * deterministic identity check — see `domain/suspect.ts` and ADR-014.
 */
export const suspectReasonSchema = z.enum(['symbol-spoof', 'bait-name']);

/**
 * A published FX reference rate, carried on the response so the UI can convert
 * for display and say which rate it used. `asOf` is the source's own date.
 */
export const fxQuoteSchema = z.object({
  base: z.literal('EUR'),
  quote: z.literal('USD'),
  rate: decimalString,
  asOf: z.string().min(1),
});

export type FxQuote = z.infer<typeof fxQuoteSchema>;

/**
 * Why a price change is, or is not, available.
 *
 * Four states rather than two, for the reason ADR-019 records: an observation
 * nobody asked for and an observation that came back empty are different claims,
 * and reporting the first as the second overstates how much is known.
 */
export const changeStatusSchema = z.enum([
  /** A usable observation. `pct` is set. */
  'ok',
  /** No request was made — the deadline expired, or the asset was out of scope. */
  'not-requested',
  /** Asked, and the source had no price for it. */
  'no-quote',
  /**
   * A price came back but cannot honestly be compared: too far from the target
   * instant, non-positive, or the current quote is itself stale or disputed.
   */
  'unusable',
]);

export type ChangeStatus = z.infer<typeof changeStatusSchema>;

export const priceChangeSchema = z.object({
  status: changeStatusSchema,
  /** Signed relative change, percent. Non-null only when status is `ok`. */
  pct: decimalString.nullable(),
  /** The historical price itself, so the UI can show what it was. */
  thenUsd: decimalString.nullable(),
  /** When that price actually is, per the source — not the instant requested. */
  asOf: z.string().nullable(),
});

export type PriceChange = z.infer<typeof priceChangeSchema>;

/**
 * The outcome of comparing a price against an independent second source.
 *
 * `null` on an asset means *not checked* — the verifier was never asked, because
 * the holding is too small to matter or the quota was spent elsewhere. It must
 * never be rendered as agreement.
 */
export const priceCheckStatusSchema = z.enum([
  /** Both sources agree within tolerance. */
  'agreed',
  /** They disagree beyond tolerance. Neither is preferred; both are shown. */
  'disputed',
  /** The second source had no opinion, or one that could not be compared. */
  'unverified',
]);

export type PriceCheckStatus = z.infer<typeof priceCheckStatusSchema>;

export const priceCheckSchema = z.object({
  status: priceCheckStatusSchema,
  /** Verifier id, e.g. `coingecko`. Drives the attribution credit. */
  source: z.string().min(1),
  /** The second opinion itself, so the UI can show both figures. */
  priceUsd: decimalString.nullable(),
  /** Relative difference from the primary, as a percentage. */
  deltaPct: decimalString.nullable(),
});

export type PriceCheck = z.infer<typeof priceCheckSchema>;

export const portfolioWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});

export type PortfolioWarning = z.infer<typeof portfolioWarningSchema>;

export const portfolioAssetSchema = z.object({
  /** Stable identity: `${chainId}:native` or `${chainId}:${contractAddress}`. */
  assetId: z.string().min(1),
  chainId: z.number().int().positive(),
  /** Null for the chain's native asset. */
  contractAddress: z.string().nullable(),
  name: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  /** Human-readable quantity, e.g. "1234.567891". */
  quantity: decimalString,
  /** Exact base units as a string, e.g. "1234567891". */
  rawQuantity: z.string().regex(/^\d+$/),
  priceUsd: decimalString.nullable(),
  valueUsd: decimalString.nullable(),
  /** Share of the priced subtotal. Null when the asset has no price. */
  portfolioSharePct: decimalString.nullable(),
  /**
   * Populated for future use but deliberately not rendered in milestone 1 —
   * see docs/DECISIONS.md, ADR-009.
   */
  logoUrl: z.string().nullable(),
  priceSource: z.string().nullable(),
  priceUpdatedAt: z.string().nullable(),
  priceQuality: priceQualitySchema.nullable(),
  /**
   * Change over a period. Null means this asset was never in scope for a
   * historical lookup at all — see `domain/priceHistory.ts` for why the four
   * statuses inside are not two.
   */
  priceChange24h: priceChangeSchema.nullable(),
  priceChange7d: priceChangeSchema.nullable(),
  /**
   * Second-source comparison. Null means not cross-checked, which is a different
   * claim from agreement — see `domain/priceCheck.ts` and ADR-019.
   */
  priceCheck: priceCheckSchema.nullable(),
  /**
   * True when the asset looks like a scam airdrop rather than a holding. Such
   * assets are still returned in full — they are simply excluded from
   * `totalValueUsd` and from every share.
   */
  suspect: z.boolean(),
  suspectReason: suspectReasonSchema.nullable(),
});

export type PortfolioAsset = z.infer<typeof portfolioAssetSchema>;

export const portfolioSchema = z.object({
  /** Checksummed address. */
  address: z.string().min(1),
  chainId: z.number().int().positive(),
  chainName: z.string().min(1),
  /**
   * Sum of the assets that have a usable price — a subtotal, not a net worth.
   * Null when nothing could be priced, never 0 in that case.
   */
  totalValueUsd: decimalString.nullable(),
  assetCount: z.number().int().min(0),
  pricedAssetCount: z.number().int().min(0),
  unpricedAssetCount: z.number().int().min(0),
  /**
   * How much was withheld from the total as likely spam, and how many assets
   * that was. Nothing is excluded without an accounting of what was excluded.
   */
  suspectAssetCount: z.number().int().min(0),
  suspectValueUsd: decimalString.nullable(),
  /** How many assets a second source was asked about. */
  checkedAssetCount: z.number().int().min(0),
  /** How many of those disagreed beyond tolerance. */
  disputedAssetCount: z.number().int().min(0),
  coverage: portfolioCoverageSchema,
  balanceSource: z.string().min(1),
  priceSource: z.string().nullable(),
  assets: z.array(portfolioAssetSchema),
  /**
   * The FX rate offered for display conversion, or null when none could be
   * fetched. Carried on the response rather than fetched by the browser: a
   * request from the user's browser to a third party would disclose that they are
   * looking at a portfolio, which ADR-009 exists to prevent.
   */
  fxRate: fxQuoteSchema.nullable(),
  /** ISO 8601 timestamp of the moment the data was assembled. */
  fetchedAt: z.string().min(1),
  warnings: z.array(portfolioWarningSchema),
});

export type Portfolio = z.infer<typeof portfolioSchema>;

/**
 * A portfolio across several chains.
 *
 * Deliberately a wrapper around per-chain `Portfolio` values rather than a
 * flattened list: the per-chain totals are what a user actually wants to see,
 * and a chain that fails must be reportable on its own without invalidating the
 * others.
 */
export const aggregatePortfolioSchema = z.object({
  address: z.string().min(1),
  /** Sum across every chain that returned a priced subtotal; null if none did. */
  totalValueUsd: decimalString.nullable(),
  assetCount: z.number().int().min(0),
  pricedAssetCount: z.number().int().min(0),
  unpricedAssetCount: z.number().int().min(0),
  suspectAssetCount: z.number().int().min(0),
  suspectValueUsd: decimalString.nullable(),
  checkedAssetCount: z.number().int().min(0),
  disputedAssetCount: z.number().int().min(0),
  /** One entry per chain that answered, in registry order. */
  chains: z.array(portfolioSchema),
  /** Chains that could not be read at all, with a safe reason. */
  failedChains: z.array(
    z.object({
      chainId: z.number().int().positive(),
      chainName: z.string().min(1),
      message: z.string().min(1),
    }),
  ),
  /**
   * The FX rate offered for display conversion, or null when none could be
   * fetched. Carried on the response rather than fetched by the browser: a
   * request from the user's browser to a third party would disclose that they are
   * looking at a portfolio, which ADR-009 exists to prevent.
   */
  fxRate: fxQuoteSchema.nullable(),
  fetchedAt: z.string().min(1),
});

export type AggregatePortfolio = z.infer<typeof aggregatePortfolioSchema>;

/** Successful `/api/portfolio` payload for a single chain. */
export const portfolioResponseSchema = z.object({
  portfolio: portfolioSchema,
  /** True when this response was served from the in-process cache. */
  cached: z.boolean(),
});

export type PortfolioResponse = z.infer<typeof portfolioResponseSchema>;

/** Successful `/api/portfolio?chainId=all` payload. */
export const aggregateResponseSchema = z.object({
  aggregate: aggregatePortfolioSchema,
  cached: z.boolean(),
});

export type AggregateResponse = z.infer<typeof aggregateResponseSchema>;

/** Query value that asks for every supported chain at once. */
export const ALL_CHAINS = 'all';

/**
 * Error payload. Deliberately narrow: a stable machine code plus a sentence
 * safe to render. Provider URLs, keys and stack traces never appear here.
 */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum([
      'invalid-address',
      'invalid-chain',
      'unsupported-chain',
      'rate-limited',
      'upstream-rate-limited',
      'upstream-unavailable',
      'upstream-invalid-response',
      'timeout',
      'internal',
    ]),
    message: z.string().min(1),
  }),
});

export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorCode = ApiError['error']['code'];

export const ASSET_SORT_KEYS = ['value', 'name'] as const;
export type AssetSortKey = (typeof ASSET_SORT_KEYS)[number];
export type SortDirection = 'asc' | 'desc';
