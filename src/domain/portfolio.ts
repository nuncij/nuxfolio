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

/**
 * Whether a protocol read produced an answer.
 *
 * One definition for every protocol, because there were seven copies of this enum across
 * five files by the time the second adapter landed and a fourth value would have had to
 * be found in all of them.
 *
 *  - `ok` — read, and an empty result is a confirmed absence rather than an unasked
 *    question.
 *  - `failed` — asked, and the answer did not come. Says nothing about the wallet.
 *  - `unavailable` — this protocol cannot be read here at all: not deployed on the
 *    chain, or missing a contract the read depends on. Permanent, not transient.
 *
 * The distinction between the last two is the one this codebase exists to keep. Merging
 * them would report "we have never been able to look" and "we could not look just now"
 * as the same sentence.
 */
export const protocolReadStatusSchema = z.enum(['ok', 'failed', 'unavailable']);

export type ProtocolReadStatus = z.infer<typeof protocolReadStatusSchema>;

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

/**
 * One asset inside a lending market.
 *
 * Amounts and values are both priced by the market's own oracle, which is why they add
 * back up to the account totals below exactly — see `domain/protocolPosition.ts`.
 */
export const protocolPositionSchema = z.object({
  asset: z.string().min(1),
  /** Read from the token itself; null when it has none that can be decoded. */
  symbol: z.string().min(1).nullable(),
  supplied: decimalString,
  borrowed: decimalString,
  /**
   * False means this supply is outside the market's collateral total. Aave reports the
   * flag, not the reason for it — the user may have switched it off, or the reserve may
   * never have been collateral-eligible — so nothing here claims an intention.
   */
  usedAsCollateral: z.boolean(),
  /** The receipt token the supply is held as — what a net figure must not count twice. */
  aTokenAddress: z.string().min(1),
  /** Null when the market oracle had no price — never 0 in that case. */
  suppliedValueUsd: decimalString.nullable(),
  borrowedValueUsd: decimalString.nullable(),
});

export type ProtocolPositionDto = z.infer<typeof protocolPositionSchema>;

/**
 * An unclaimed incentive. Owed to the wallet, not held by it — claiming is a
 * transaction — so it is summed into nothing.
 */
export const protocolRewardSchema = z.object({
  token: z.string().min(1),
  symbol: z.string().min(1).nullable(),
  amount: decimalString,
  /** Null when the market oracle has no price for the reward token, which is usual. */
  valueUsd: decimalString.nullable(),
});

export type ProtocolRewardDto = z.infer<typeof protocolRewardSchema>;

/**
 * A lending-protocol account, beside the assets rather than among them.
 *
 * Never summed into `totalValueUsd`. These figures come from the protocol's own
 * oracle, not the price provider the assets use, and the collateral behind them is
 * invisible to the asset list — so combining the two would be arithmetic across two
 * scopes. See `domain/protocolAccount.ts` for the worked example.
 */
export const protocolAccountSchema = z.object({
  chainId: z.number().int().positive(),
  protocol: z.literal('aave-v3'),
  marketId: z.string().min(1),
  marketName: z.string().min(1),
  /** `failed` means the read did not answer — it is not a claim of "no debt". */
  status: z.enum(['ok', 'failed']),
  collateralValueUsd: decimalString.nullable(),
  borrowedValueUsd: decimalString.nullable(),
  /** Unitless, 18 decimals. Null when the wallet has no debt in this market. */
  healthFactor: decimalString.nullable(),
  /** Which assets the totals are made of. Empty unless `positionsStatus` is `ok`. */
  positions: z.array(protocolPositionSchema),
  /**
   * Whether the breakdown could be produced — a separate read from the totals, so a
   * market can report a good health factor beside a missing breakdown. `unavailable`
   * is permanent; `failed` may work on the next load.
   */
  positionsStatus: protocolReadStatusSchema,
  /** Unclaimed incentives, read separately from the positions. */
  rewards: z.array(protocolRewardSchema),
  rewardsStatus: protocolReadStatusSchema,
});

export type ProtocolAccountDto = z.infer<typeof protocolAccountSchema>;

/**
 * A position another protocol holds for the wallet.
 *
 * Distinct from a `PortfolioAsset` because the wallet does not hold it — Convex's reward
 * contract does — and distinct from a `ProtocolAccountDto` because there is no debt and
 * no health factor, only a balance somewhere else. See `domain/stakedPosition.ts`.
 */
export const stakedRewardSchema = z.object({
  token: z.string().min(1),
  symbol: z.string().min(1).nullable(),
  amount: decimalString,
  valueUsd: decimalString.nullable(),
});

export const stakedPositionSchema = z.object({
  positionId: z.string().min(1),
  chainId: z.number().int().positive(),
  protocol: z.literal('convex'),
  /** The staked token, which is what the price source was asked about. */
  stakedToken: z.string().min(1),
  symbol: z.string().min(1).nullable(),
  amount: decimalString,
  /** Null when the price source had no quote — measured at 28 % of used Convex pools. */
  valueUsd: decimalString.nullable(),
  /** Always empty in v1; see `domain/stakedPosition.ts` for why that is not a claim. */
  rewards: z.array(stakedRewardSchema),
});

export type StakedPositionDto = z.infer<typeof stakedPositionSchema>;

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
  /**
   * The total with the wallet's Aave position counted once and its Aave debt taken
   * off. Null whenever it cannot be computed exactly — including when there is no debt,
   * where it would only repeat `totalValueUsd`. See `domain/netOfDebt.ts` and ADR-029.
   */
  netOfAaveDebtUsd: decimalString.nullable(),
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
   * Lending-protocol accounts on this chain, one per market.
   *
   * Present but empty means "checked, and this wallet uses none" — the read
   * succeeded. Absent markets are not represented at all, and a market that could
   * not be read appears with `status: 'failed'` rather than being dropped, so a
   * broken read never renders as an absence of debt.
   */
  protocolAccounts: z.array(protocolAccountSchema),
  /**
   * Positions another protocol holds on the wallet's behalf, which no balance read can
   * see. Empty with `stakedStatus: 'ok'` is a confirmed absence.
   */
  stakedPositions: z.array(stakedPositionSchema),
  stakedStatus: protocolReadStatusSchema,
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
  /** As on a single chain, computed across all of them at once. */
  netOfAaveDebtUsd: decimalString.nullable(),
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
