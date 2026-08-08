import type { ProtocolAccount } from './protocolAccount';
import type { PriceQuote, RawBalance } from '@/providers/types';
import { priceRefKey } from '@/providers/types';

import type { WalletAddress } from './address';
import {
  compareDecimal,
  formatBaseUnits,
  Money,
  multiplyToMoney,
  parseDecimal,
  percentageOf,
  sumMoney,
} from './money';
import type {
  AggregatePortfolio,
  AssetSortKey,
  Portfolio,
  PortfolioAsset,
  FxQuote,
  PriceCheck,
  PriceChange,
  PortfolioCoverage,
  PortfolioWarning,
  PriceQuality,
  SortDirection,
} from './portfolio';
import { computeNetOfDebt } from './netOfDebt';
import { toStakedPosition, type RawStakedPosition } from './stakedPosition';
import { largestDispute, summarizePriceChecks } from './priceCheck';
import {
  assessSuspect,
  createListedTokenIndex,
  type ListedToken,
  type ListedTokenIndex,
  type SuspectReason,
} from './suspect';

/**
 * Assembling a portfolio from raw balances and quotes.
 *
 * This is where the product's honesty rules live, so they are worth stating:
 *
 *  - The total is a **subtotal of priced assets**, never a claimed net worth.
 *    If nothing could be priced it is `null`, not `0` — zero would be a
 *    factual claim that the wallet is worthless.
 *  - Percentages are shares of that priced subtotal, so they describe the part
 *    of the portfolio that could be valued, and unpriced assets get `null`
 *    rather than a share of a total they are not in.
 *  - A quote that is old or low-confidence is labelled and kept, not silently
 *    dropped. Dropping it would make the subtotal quietly wrong; labelling it
 *    lets the user judge.
 *  - An asset that is probably not the user's at all — a spoofed symbol, a
 *    name that advertises at them — is excluded from the subtotal and counted
 *    separately, because here the doubt is about identity rather than price.
 *    See `suspect.ts` and ADR-014.
 */

export type BuildPortfolioInput = {
  address: WalletAddress;
  chain: { chainId: number; name: string; nativeSymbol: string };
  balances: readonly RawBalance[];
  /** The chain's bundled token list, which doubles as the spoofing whitelist. */
  listedTokens: readonly ListedToken[];
  quotes: ReadonlyMap<string, PriceQuote>;
  /**
   * Second-source comparisons, keyed by asset id. Absent entries mean the asset
   * was never checked — which the UI renders as such, never as agreement.
   */
  priceChecks?: ReadonlyMap<string, PriceCheck>;
  /**
   * Change figures, keyed by asset id. An absent entry means the asset was never
   * in scope for a historical lookup — which is a different claim from a lookup
   * that came back empty, and the reason `PriceChange` carries a status.
   */
  priceChanges?: ReadonlyMap<string, { readonly day: PriceChange; readonly week: PriceChange }>;
  coverage: PortfolioCoverage;
  balanceSource: string;
  priceSource: string | null;
  /**
   * Lending-protocol accounts read for this chain. Optional because most callers
   * — every existing test, and the progressive aggregate — have none, and an
   * absent list means nothing was asked rather than nothing was found.
   */
  protocolAccounts?: readonly ProtocolAccount[];
  /**
   * Positions held for the wallet by another protocol. Optional for the same reason as
   * `protocolAccounts`: an absent list means nothing was asked, and `stakedStatus`
   * carries the difference.
   */
  stakedPositions?: readonly RawStakedPosition[];
  stakedStatus?: 'ok' | 'failed' | 'unavailable';
  warnings: readonly PortfolioWarning[];
  fetchedAt: string;
  priceConfidenceMin: number;
  priceMaxAgeSeconds: number;
  maxAssets: number;
  /** Display-conversion rate to carry on the response. Null when unavailable. */
  fxRate?: FxQuote | null;
};

export function buildPortfolio(input: BuildPortfolioInput): Portfolio {
  const fetchedAtMs = Date.parse(input.fetchedAt);
  const now = Number.isNaN(fetchedAtMs) ? Date.now() : fetchedAtMs;

  const listed = createListedTokenIndex({
    tokens: input.listedTokens,
    nativeSymbol: input.chain.nativeSymbol,
  });

  const valued = input.balances
    .filter((balance) => balance.raw > 0n)
    .map((balance) => toValuedAsset(balance, input, now, listed));

  // Sorting before truncation means the cap drops the least significant
  // holdings rather than an arbitrary slice.
  const sorted = sortAssets(valued, 'value', 'desc');
  const kept = sorted.slice(0, input.maxAssets);
  const droppedCount = sorted.length - kept.length;

  const suspects = kept.filter((asset) => asset.suspect);
  const pricedSubtotal = sumPricedValues(kept.filter((asset) => !asset.suspect));
  const suspectValueUsd = sumPricedValues(suspects);

  const assets: PortfolioAsset[] = kept.map((asset) => ({
    ...asset,
    portfolioSharePct:
      asset.valueUsd !== null && pricedSubtotal !== null && !asset.suspect
        ? percentageOf(asset.valueUsd, pricedSubtotal)
        : null,
  }));

  const pricedAssetCount = assets.filter((asset) => asset.valueUsd !== null).length;
  const unpricedAssetCount = assets.length - pricedAssetCount;
  const { checkedAssetCount, disputedAssetCount } = summarizePriceChecks(assets);

  // Deduplicated by code: two layers can legitimately raise the same concern
  // (a provider reporting a partial price fetch, say), and the UI keys warnings
  // by code. First occurrence wins, since the provider's message is the specific
  // one.
  const warnings = dedupeByCode([
    ...input.warnings,
    ...deriveSuspectWarnings(suspects),
    ...deriveDisputeWarnings(assets, disputedAssetCount),
    ...derivePriceWarnings({
      assets,
      unpricedAssetCount,
      droppedCount,
      maxAssets: input.maxAssets,
    }),
    PROTOCOL_COVERAGE_WARNING,
  ]);

  const accounts = (input.protocolAccounts ?? []).map((account) => ({
    ...account,
    positions: [...account.positions],
    rewards: [...account.rewards],
  }));

  return {
    address: input.address,
    chainId: input.chain.chainId,
    chainName: input.chain.name,
    // Empty is the honest default for a chain where nothing was asked: `failed`
    // accounts are the only way a read that did not answer reaches the wire.
    protocolAccounts: accounts,
    // Priced from the same quote batch as the assets, because the staked token was put
    // into the same price request — a Convex LP is an ordinary ERC-20 that happens to
    // live somewhere else, so it is valued the way every other holding is (ADR-030).
    stakedPositions: (input.stakedPositions ?? []).map((position) => {
      const built = toStakedPosition(position, (token) =>
        quoteFor(input.quotes, position.chainId, token),
      );
      return { ...built, rewards: [...built.rewards] };
    }),
    stakedStatus: input.stakedStatus ?? 'unavailable',
    totalValueUsd: pricedSubtotal,
    netOfAaveDebtUsd: computeNetOfDebt({
      totalValueUsd: pricedSubtotal,
      assets,
      accounts,
    }).valueUsd,
    assetCount: assets.length,
    pricedAssetCount,
    unpricedAssetCount,
    suspectAssetCount: suspects.length,
    suspectValueUsd,
    checkedAssetCount,
    disputedAssetCount,
    coverage: droppedCount > 0 ? 'truncated' : input.coverage,
    balanceSource: input.balanceSource,
    priceSource: input.priceSource,
    assets,
    fxRate: input.fxRate ?? null,
    fetchedAt: input.fetchedAt,
    warnings,
  };
}

type ValuedAsset = Omit<PortfolioAsset, 'portfolioSharePct'>;

/** Sum of the priced values in a group; null when the group prices nothing. */
function sumPricedValues(assets: readonly { valueUsd: string | null }[]): string | null {
  const values = assets
    .map((asset) => asset.valueUsd)
    .filter((value): value is string => value !== null);
  return values.length > 0 ? sumMoney(values) : null;
}

function toValuedAsset(
  balance: RawBalance,
  input: BuildPortfolioInput,
  now: number,
  listed: ListedTokenIndex,
): ValuedAsset {
  const quantity = formatBaseUnits(balance.raw, balance.decimals);
  const quote = input.quotes.get(
    priceRefKey({ chainId: balance.chainId, contractAddress: balance.contractAddress }),
  );

  const priceUsd = quote?.priceUsd ?? null;
  const quality = quote
    ? assessPriceQuality(quote, {
        now,
        confidenceMin: input.priceConfidenceMin,
        maxAgeSeconds: input.priceMaxAgeSeconds,
      })
    : null;

  const assetId = `${balance.chainId}:${balance.contractAddress ?? 'native'}`;

  return {
    assetId,
    chainId: balance.chainId,
    contractAddress: balance.contractAddress,
    name: balance.name,
    symbol: balance.symbol,
    decimals: balance.decimals,
    quantity,
    rawQuantity: balance.raw.toString(),
    priceUsd,
    valueUsd: priceUsd === null ? null : multiplyToMoney(quantity, priceUsd),
    logoUrl: balance.logoUrl,
    priceSource: quote ? input.priceSource : null,
    priceUpdatedAt: quote?.updatedAt ?? null,
    priceQuality: quality,
    priceCheck: input.priceChecks?.get(assetId) ?? null,
    priceChange24h: input.priceChanges?.get(assetId)?.day ?? null,
    priceChange7d: input.priceChanges?.get(assetId)?.week ?? null,
    ...assessSuspect(balance, listed),
  };
}

export function assessPriceQuality(
  quote: PriceQuote,
  options: { now: number; confidenceMin: number; maxAgeSeconds: number },
): PriceQuality {
  if (quote.confidence !== null && quote.confidence < options.confidenceMin) {
    return 'low-confidence';
  }
  if (quote.updatedAt === null) {
    return 'unknown-age';
  }

  const updatedAtMs = Date.parse(quote.updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    // A timestamp we cannot read is no better than none at all.
    return 'unknown-age';
  }
  if (options.now - updatedAtMs > options.maxAgeSeconds * 1000) {
    return 'stale';
  }
  return 'ok';
}

/**
 * Sorts assets without ever comparing decimal strings with `<`.
 *
 * Unpriced assets sort after priced ones in both directions: they have no value
 * to compare, and burying them at the bottom of an ascending sort would hide
 * exactly the rows the user needs to notice.
 */
export function sortAssets<T extends { valueUsd: string | null; name: string; symbol: string }>(
  assets: readonly T[],
  key: AssetSortKey,
  direction: SortDirection,
): T[] {
  const factor = direction === 'asc' ? 1 : -1;

  // The direction factor applies only to the primary key. Flipping the
  // tie-break too would reorder equal rows when the user reverses the sort,
  // which reads as data changing under them.
  return [...assets].sort((a, b) => {
    if (key === 'name') {
      const byName = a.name.localeCompare(b.name, 'en');
      return byName !== 0 ? factor * byName : a.symbol.localeCompare(b.symbol, 'en');
    }

    if (a.valueUsd === null && b.valueUsd === null) {
      return a.symbol.localeCompare(b.symbol, 'en');
    }
    if (a.valueUsd === null) {
      return 1;
    }
    if (b.valueUsd === null) {
      return -1;
    }

    const byValue = compareDecimal(a.valueUsd, b.valueUsd);
    return byValue !== 0 ? factor * byValue : a.symbol.localeCompare(b.symbol, 'en');
  });
}

export type PortfolioSummary = {
  totalValueUsd: string | null;
  /** The total net of Aave debt, or null when it cannot be computed (ADR-029). */
  netOfAaveDebtUsd: string | null;
  assetCount: number;
  pricedAssetCount: number;
  unpricedAssetCount: number;
  suspectAssetCount: number;
  suspectValueUsd: string | null;
  /** Largest position by value. Null when nothing could be priced. */
  largestAsset: { symbol: string; name: string; valueUsd: string; sharePct: string | null } | null;
  flaggedPriceCount: number;
  /**
   * The cross-check, counted from the rows themselves rather than copied from the
   * payload's own totals.
   *
   * Carried into the summary because the asset table marks only disagreements:
   * without these numbers an unmarked row would be indistinguishable from a
   * confirmed one. Derived, so the sentence the summary prints cannot contradict
   * the table underneath it — and `agreed` is counted rather than inferred from
   * "checked minus disputed", because an `unverified` asset was asked about and
   * got no answer.
   */
  checkedAssetCount: number;
  agreedAssetCount: number;
  disputedAssetCount: number;
  /**
   * Priced assets inside the total — the honest denominator for the check count.
   * `pricedAssetCount` includes suspect rows, which are excluded from the total
   * and therefore never worth a second opinion; counting them would understate
   * the coverage of a check that had in fact covered everything that matters.
   * Counting checks over the same non-suspect set is what keeps N ≤ M true by
   * construction rather than by assumption.
   */
  countedPricedAssetCount: number;
};

/**
 * The summary describes the total, so suspect assets are outside it: an
 * airdropped fake with a fabricated price must never become the headline
 * "largest position".
 */
function summarizeAssets<T extends PortfolioAsset>(
  assets: readonly T[],
): Pick<
  PortfolioSummary,
  | 'largestAsset'
  | 'flaggedPriceCount'
  | 'countedPricedAssetCount'
  | 'checkedAssetCount'
  | 'agreedAssetCount'
  | 'disputedAssetCount'
> {
  const counted = assets.filter((asset) => !asset.suspect);

  const priced = counted.filter(
    (asset): asset is T & { valueUsd: string } => asset.valueUsd !== null,
  );

  const largest = priced.reduce<(T & { valueUsd: string }) | null>(
    (best, asset) =>
      best === null || compareDecimal(asset.valueUsd, best.valueUsd) > 0 ? asset : best,
    null,
  );

  return {
    largestAsset:
      largest === null
        ? null
        : {
            symbol: largest.symbol,
            name: largest.name,
            valueUsd: largest.valueUsd,
            sharePct: largest.portfolioSharePct,
          },
    flaggedPriceCount: counted.filter(
      (asset) => asset.priceQuality !== null && asset.priceQuality !== 'ok',
    ).length,
    countedPricedAssetCount: priced.length,
    // Over `counted`, the same set as the denominator above.
    ...summarizePriceChecks(counted),
  };
}

export function summarizePortfolio(portfolio: Portfolio): PortfolioSummary {
  return {
    totalValueUsd: portfolio.totalValueUsd,
    netOfAaveDebtUsd: portfolio.netOfAaveDebtUsd,
    assetCount: portfolio.assetCount,
    pricedAssetCount: portfolio.pricedAssetCount,
    unpricedAssetCount: portfolio.unpricedAssetCount,
    suspectAssetCount: portfolio.suspectAssetCount,
    suspectValueUsd: portfolio.suspectValueUsd,
    // checkedAssetCount / disputedAssetCount come from summarizeAssets below,
    // counted from the rows rather than taken from the payload's own totals.
    ...summarizeAssets(portfolio.assets),
  };
}

/**
 * A dispute is reported with its worst case, because "3 prices disagree" and
 * "3 prices disagree, the largest by 40 %" call for different reactions.
 */
function deriveDisputeWarnings(
  assets: readonly PortfolioAsset[],
  disputedAssetCount: number,
): PortfolioWarning[] {
  if (disputedAssetCount === 0) {
    return [];
  }

  const worst = largestDispute(assets);
  // Rounded in Decimal, not through `Number`. A percentage is a value like any
  // other here, and this is the one line in the file that was routing one through
  // a float — the rule exists because that is exactly how it happens.
  const scale =
    worst === null
      ? ''
      : ` The widest gap is ${worst.symbol}, where the two sources differ by ${parseDecimal(
          worst.deltaPct,
        ).toFixed(1, Money.ROUND_HALF_UP)} %.`;

  return [
    {
      code: 'prices.disputed',
      message: `${disputedAssetCount} price${disputedAssetCount === 1 ? '' : 's'} could not be confirmed by a second source and ${disputedAssetCount === 1 ? 'is' : 'are'} still counted in the total.${scale}`,
    },
  ];
}

/**
 * The one caveat that is always true.
 *
 * Every other warning here reports something that went wrong *this time*. This one
 * reports a permanent boundary of the product, and it is unconditional for the reason
 * the whole panel exists: a wallet with a Compound loan and no Aave position sees no
 * lending panel at all, so silence about coverage is indistinguishable from a confirmed
 * absence. `M5_PLAN.md` §6 made this a rule for milestone 5 — "reading Aave and not
 * Compound means a wallet can have positions Nuxfolio cannot see" — and M5-1 and M5-2
 * both shipped without meeting it.
 *
 * The second sentence matters as much as the first. Receipt tokens *are* counted, so a
 * flat "other protocols are not shown" would understate what the page does, in a product
 * whose whole claim is that it neither overstates nor understates.
 */
const PROTOCOL_COVERAGE_WARNING: PortfolioWarning = {
  code: 'protocols.coverage',
  message:
    'Aave v3 is the only protocol whose own accounting is read. A position held by ' +
    'another protocol — a Compound loan, a Convex stake — is not shown, though a ' +
    'receipt token for one sitting in the wallet is still counted as a token.',
};

/** The price of one token from the batch the assets were priced by. */
function quoteFor(
  quotes: ReadonlyMap<string, PriceQuote>,
  chainId: number,
  token: string,
): string | null {
  return (
    quotes.get(priceRefKey({ chainId, contractAddress: token as `0x${string}` }))?.priceUsd ?? null
  );
}

function dedupeByCode(warnings: readonly PortfolioWarning[]): PortfolioWarning[] {
  const seen = new Set<string>();
  return warnings.filter((warning) => {
    if (seen.has(warning.code)) {
      return false;
    }
    seen.add(warning.code);
    return true;
  });
}

/**
 * Noun phrases rather than verbs, so one sentence can carry both reasons
 * without the counts fighting the grammar.
 */
const SUSPECT_REASON_PHRASE: Record<SuspectReason, string> = {
  'symbol-spoof': 'with a copied symbol',
  'bait-name': 'with claim-bait naming',
};

function deriveSuspectWarnings(
  suspects: readonly { suspectReason: SuspectReason | null }[],
): PortfolioWarning[] {
  if (suspects.length === 0) {
    return [];
  }

  const one = suspects.length === 1;
  // With a single asset the count would just repeat the total in the same
  // sentence, so the phrase stands on its own.
  const reasons = (Object.keys(SUSPECT_REASON_PHRASE) as SuspectReason[])
    .map((reason) => ({
      phrase: SUSPECT_REASON_PHRASE[reason],
      count: suspects.filter((asset) => asset.suspectReason === reason).length,
    }))
    .filter((entry) => entry.count > 0)
    .map((entry) => (one ? entry.phrase : `${entry.count} ${entry.phrase}`));

  return [
    {
      code: 'assets.suspect',
      message:
        `${suspects.length} asset${one ? '' : 's'} look${one ? 's' : ''} like spam ` +
        `(${reasons.join(', ')}) and ${one ? 'is' : 'are'} excluded from the total. ` +
        `Review ${one ? 'it' : 'them'} below.`,
    },
  ];
}

function derivePriceWarnings(input: {
  assets: readonly PortfolioAsset[];
  unpricedAssetCount: number;
  droppedCount: number;
  maxAssets: number;
}): PortfolioWarning[] {
  const warnings: PortfolioWarning[] = [];

  if (input.droppedCount > 0) {
    warnings.push({
      code: 'assets.truncated',
      message: `Only the ${input.maxAssets} largest holdings are shown; ${input.droppedCount} smaller ones were omitted.`,
    });
  }

  if (input.unpricedAssetCount > 0) {
    warnings.push({
      code: 'prices.missing',
      message: `${input.unpricedAssetCount} asset${input.unpricedAssetCount === 1 ? '' : 's'} had no price available and ${input.unpricedAssetCount === 1 ? 'is' : 'are'} excluded from the total.`,
    });
  }

  const stale = input.assets.filter((asset) => asset.priceQuality === 'stale').length;
  if (stale > 0) {
    warnings.push({
      code: 'prices.stale',
      message: `${stale} price${stale === 1 ? '' : 's'} ${stale === 1 ? 'is' : 'are'} older than expected and may not reflect the current market.`,
    });
  }

  const lowConfidence = input.assets.filter(
    (asset) => asset.priceQuality === 'low-confidence',
  ).length;
  if (lowConfidence > 0) {
    warnings.push({
      code: 'prices.low_confidence',
      message: `${lowConfidence} price${lowConfidence === 1 ? '' : 's'} ${lowConfidence === 1 ? 'was' : 'were'} reported with low confidence by the price provider.`,
    });
  }

  const unknownAge = input.assets.filter((asset) => asset.priceQuality === 'unknown-age').length;
  if (unknownAge > 0) {
    warnings.push({
      code: 'prices.unknown_age',
      message: `${unknownAge} price${unknownAge === 1 ? '' : 's'} arrived without a timestamp, so how current ${unknownAge === 1 ? 'it is' : 'they are'} cannot be confirmed.`,
    });
  }

  return warnings;
}

/**
 * Combines per-chain portfolios into one cross-chain view.
 *
 * A chain that failed is carried in `failedChains` rather than dropped: a total
 * that silently omits a network is the same category of quiet error as a total
 * that silently omits an unpriced asset.
 */
export function buildAggregatePortfolio(input: {
  address: WalletAddress;
  chains: readonly Portfolio[];
  failedChains: readonly { chainId: number; chainName: string; message: string }[];
  fetchedAt: string;
}): AggregatePortfolio {
  return {
    address: input.address,
    ...sumPortfolioTotals(input.chains),
    // Recomputed across every chain at once rather than summed from the per-chain
    // figures. Summing would need a rule for a chain whose net is null because it has
    // no debt — its assets still belong in the sum — and inventing that rule is how a
    // net worth quietly loses a network. One calculation over everything has no such
    // seam, and `netOfDebt` already keys its matching on chain id.
    netOfAaveDebtUsd: computeNetOfDebt({
      totalValueUsd: sumPortfolioTotals(input.chains).totalValueUsd,
      assets: input.chains.flatMap((chain) => chain.assets),
      accounts: input.chains.flatMap((chain) => chain.protocolAccounts),
    }).valueUsd,
    chains: [...input.chains],
    failedChains: [...input.failedChains],
    // Taken from the first chain that carried one rather than passed in: every
    // chain in one request shares a rate, and a mismatch would mean two figures
    // on the same page converted at different rates.
    fxRate: input.chains.find((portfolio) => portfolio.fxRate !== null)?.fxRate ?? null,
    fetchedAt: input.fetchedAt,
  };
}

/**
 * The counts and money figures shared by every way of combining portfolios.
 *
 * Extracted so the two aggregation axes — several networks for one wallet, several
 * wallets in a bundle — add up through **one** implementation. Two copies of this
 * arithmetic would be two places for a subtotal to drift, and the second axis was
 * added a milestone after the first.
 *
 * Takes only what it sums, so a bundle can pass its members' aggregates without
 * pretending they are chains.
 */
export function sumPortfolioTotals(
  parts: readonly Pick<
    Portfolio,
    | 'totalValueUsd'
    | 'assetCount'
    | 'pricedAssetCount'
    | 'unpricedAssetCount'
    | 'suspectAssetCount'
    | 'suspectValueUsd'
    | 'checkedAssetCount'
    | 'disputedAssetCount'
  >[],
): {
  totalValueUsd: string | null;
  assetCount: number;
  pricedAssetCount: number;
  unpricedAssetCount: number;
  suspectAssetCount: number;
  suspectValueUsd: string | null;
  checkedAssetCount: number;
  disputedAssetCount: number;
} {
  const subtotals = parts
    .map((part) => part.totalValueUsd)
    .filter((value): value is string => value !== null);

  return {
    // Null rather than 0 when nothing could be priced: zero is a claim that the
    // holdings are worthless, which is not what "we priced nothing" means.
    totalValueUsd: subtotals.length > 0 ? sumMoney(subtotals) : null,
    assetCount: parts.reduce((sum, part) => sum + part.assetCount, 0),
    pricedAssetCount: parts.reduce((sum, part) => sum + part.pricedAssetCount, 0),
    unpricedAssetCount: parts.reduce((sum, part) => sum + part.unpricedAssetCount, 0),
    suspectAssetCount: parts.reduce((sum, part) => sum + part.suspectAssetCount, 0),
    suspectValueUsd: sumPricedValues(parts.map((part) => ({ valueUsd: part.suspectValueUsd }))),
    checkedAssetCount: parts.reduce((sum, part) => sum + part.checkedAssetCount, 0),
    disputedAssetCount: parts.reduce((sum, part) => sum + part.disputedAssetCount, 0),
  };
}

/** Every asset across every chain, with its chain's identity attached. */
export type CrossChainAsset = PortfolioAsset & { chainName: string };

export function flattenAggregateAssets(aggregate: AggregatePortfolio): CrossChainAsset[] {
  return aggregate.chains.flatMap((portfolio) =>
    portfolio.assets.map((asset) => ({ ...asset, chainName: portfolio.chainName })),
  );
}

/**
 * Shares across an aggregate are computed against the cross-chain priced total,
 * not the per-chain one each asset already carries — otherwise every chain's
 * assets would sum to 100 % on their own and the column would be meaningless.
 */
export function withCrossChainShares(
  assets: readonly CrossChainAsset[],
  totalValueUsd: string | null,
): CrossChainAsset[] {
  if (totalValueUsd === null) {
    return assets.map((asset) => ({ ...asset, portfolioSharePct: null }));
  }
  return assets.map((asset) => ({
    ...asset,
    // Suspect assets are outside the total they would be shares of.
    portfolioSharePct:
      asset.valueUsd === null || asset.suspect ? null : percentageOf(asset.valueUsd, totalValueUsd),
  }));
}

/** Aggregate-level summary, mirroring {@link summarizePortfolio}. */
export function summarizeAggregate(aggregate: AggregatePortfolio): PortfolioSummary & {
  chainCount: number;
} {
  const assets = withCrossChainShares(flattenAggregateAssets(aggregate), aggregate.totalValueUsd);

  return {
    totalValueUsd: aggregate.totalValueUsd,
    netOfAaveDebtUsd: aggregate.netOfAaveDebtUsd,
    assetCount: aggregate.assetCount,
    pricedAssetCount: aggregate.pricedAssetCount,
    unpricedAssetCount: aggregate.unpricedAssetCount,
    suspectAssetCount: aggregate.suspectAssetCount,
    suspectValueUsd: aggregate.suspectValueUsd,
    // As above: counted from the flattened rows, so the sentence the summary
    // prints cannot contradict the table it sits over.
    ...summarizeAssets(assets),
    chainCount: aggregate.chains.length,
  };
}
