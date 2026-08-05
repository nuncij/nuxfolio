import { compareDecimal, isPositive, Money, parseDecimal, percentageOf } from './money';
import type { PortfolioAsset, PriceCheck, PriceCheckStatus } from './portfolio';

/**
 * Cross-checking a price against a second source.
 *
 * `priceQuality` handles uncertainty a provider *declares* — a quote that is old,
 * or that it labels low-confidence. It cannot catch a quote that is confidently
 * wrong, and only a second opinion can. This is that second opinion's arithmetic.
 *
 * Two rules shape everything here:
 *
 *  - **Neither source wins a dispute.** The primary price stays in the total and
 *    the asset is flagged with both figures. Choosing a winner would assert a
 *    confidence we do not have; the same reasoning as ADR-005's flag-and-keep,
 *    applied to disagreement rather than staleness. See ADR-019.
 *  - **Silence is not agreement.** An asset nobody checked carries `null`, which
 *    the UI must render as "not cross-checked". Treating unchecked as verified
 *    would be the quiet overstatement this product exists to avoid.
 */

/** Relative difference at which two prices are called a dispute rather than noise. */
export const DEFAULT_DISPUTE_TOLERANCE = 0.02;

/** Share of the priced subtotal a cross-check should cover. */
export const DEFAULT_CROSSCHECK_COVERAGE = 0.95;

/** Per-chain ceiling on how many assets are sent to the verifier. */
export const DEFAULT_CROSSCHECK_MAX_ASSETS = 25;

type Valued = Pick<PortfolioAsset, 'assetId' | 'valueUsd' | 'priceUsd' | 'contractAddress'>;

/**
 * Picks the assets whose price actually matters to the total.
 *
 * A disagreement on a few cents of dust changes no decision a person would make;
 * one on a third of the portfolio changes the headline figure. The verifier's
 * quota is finite, so it is spent where being wrong would cost something.
 *
 * Assets without a price are excluded: there is nothing to compare.
 */
export function selectAssetsToCrossCheck<T extends Valued>(
  assets: readonly T[],
  options: { coverage?: number; maxAssets?: number } = {},
): T[] {
  const coverage = options.coverage ?? DEFAULT_CROSSCHECK_COVERAGE;
  const maxAssets = options.maxAssets ?? DEFAULT_CROSSCHECK_MAX_ASSETS;

  const priced = assets.filter(
    (asset): asset is T & { valueUsd: string; priceUsd: string } =>
      asset.valueUsd !== null && asset.priceUsd !== null,
  );
  // Zero coverage means cross-checking is switched off. Spending one call anyway
  // would ignore an operator who asked for none.
  if (priced.length === 0 || maxAssets < 1 || coverage <= 0) {
    return [];
  }

  const ranked = [...priced].sort((a, b) => -compareDecimal(a.valueUsd, b.valueUsd));

  const total = ranked.reduce<InstanceType<typeof Money>>(
    (sum, asset) => sum.plus(parseDecimal(asset.valueUsd)),
    new Money(0),
  );

  // Everything is worth nothing measurable, so nothing is material. Checking the
  // largest of them anyway keeps the feature observable rather than silently
  // doing nothing on an all-dust wallet.
  if (!total.gt(0)) {
    return ranked.slice(0, Math.min(1, maxAssets));
  }

  const target = total.mul(coverage);
  const selected: T[] = [];
  let accumulated = new Money(0);

  for (const asset of ranked) {
    if (selected.length >= maxAssets) {
      break;
    }
    selected.push(asset);
    accumulated = accumulated.plus(parseDecimal(asset.valueUsd));
    // Checked *after* adding, so the asset that crosses the threshold is included
    // rather than being the first one dropped.
    if (accumulated.gte(target)) {
      break;
    }
  }

  return selected;
}

/**
 * Compares a primary price against a second opinion.
 *
 * The delta is relative, not absolute: two cents apart matters enormously on a
 * $0.05 token and not at all on a $60,000 one.
 */
export function comparePrices(input: {
  primaryUsd: string;
  secondUsd: string | null;
  source: string;
  tolerance?: number;
}): PriceCheck {
  const tolerance = input.tolerance ?? DEFAULT_DISPUTE_TOLERANCE;

  if (input.secondUsd === null) {
    return { status: 'unverified', source: input.source, priceUsd: null, deltaPct: null };
  }

  // A non-positive primary cannot be a denominator, and a non-positive second
  // opinion is not a price. Either way there is no comparison to report.
  if (!isPositive(input.primaryUsd) || !isPositive(input.secondUsd)) {
    return {
      status: 'unverified',
      source: input.source,
      priceUsd: input.secondUsd,
      deltaPct: null,
    };
  }

  const primary = parseDecimal(input.primaryUsd);
  const second = parseDecimal(input.secondUsd);
  const difference = second.minus(primary).abs();

  // percentageOf keeps this in Decimal; a float division here would be the one
  // place a rounding artefact could flip a status at the boundary.
  const deltaPct = percentageOf(difference.toFixed(), primary.toFixed());
  const withinTolerance = difference.div(primary).lte(tolerance);

  return {
    status: withinTolerance ? 'agreed' : 'disputed',
    source: input.source,
    priceUsd: input.secondUsd,
    deltaPct,
  };
}

/**
 * How many assets in a set carry each status. Drives the summary and warnings.
 *
 * `agreed` is counted, not inferred from "checked minus disputed": an
 * `unverified` asset was asked about and got no answer, so folding it into
 * agreement would report a confirmation that never happened.
 */
export function summarizePriceChecks(assets: readonly Pick<PortfolioAsset, 'priceCheck'>[]): {
  checkedAssetCount: number;
  agreedAssetCount: number;
  disputedAssetCount: number;
} {
  const checks = assets
    .map((asset) => asset.priceCheck)
    .filter((check): check is PriceCheck => check !== null);

  return {
    checkedAssetCount: checks.length,
    agreedAssetCount: checks.filter((check) => check.status === 'agreed').length,
    disputedAssetCount: checks.filter((check) => check.status === 'disputed').length,
  };
}

/** The widest disagreement, for a warning that says how bad it actually is. */
export function largestDispute(
  assets: readonly Pick<PortfolioAsset, 'symbol' | 'priceCheck'>[],
): { symbol: string; deltaPct: string } | null {
  return assets.reduce<{ symbol: string; deltaPct: string } | null>((worst, asset) => {
    const check = asset.priceCheck;
    if (check === null || check.status !== 'disputed' || check.deltaPct === null) {
      return worst;
    }
    if (worst === null || compareDecimal(check.deltaPct, worst.deltaPct) > 0) {
      return { symbol: asset.symbol, deltaPct: check.deltaPct };
    }
    return worst;
  }, null);
}

export type { PriceCheckStatus };
