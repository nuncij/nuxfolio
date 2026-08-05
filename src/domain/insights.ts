import { classifyAsset, type HoldingForm, type TrackedAsset } from './assetClass';
import { compareDecimal, percentageOf, sumMoney } from './money';
import type { PortfolioAsset } from './portfolio';

/**
 * Facts about a portfolio, computed from data it already carries.
 *
 * Three rules, and they are the whole design:
 *
 *  - **Facts, not advice.** "One asset is 33.9% of the subtotal" is a fact.
 *    "You are over-concentrated" is a recommendation, and this product does not
 *    make them. Where the line is unclear, the number is stated and nothing else.
 *  - **One honest universe.** Every numerator and denominator is the set of
 *    priced, non-suspect assets. Neither `assetCount` (which includes unpriced
 *    and spam rows) nor `pricedAssetCount` (which includes priced spam) is a
 *    denominator a share can be taken against without overstating coverage.
 *  - **Structured output, no sentences.** This module returns decimal strings and
 *    counts. Phrasing and formatting belong to the component, because
 *    `lib/format.ts` already imports from here — a domain module reaching back
 *    into the formatter would invert the dependency and break the layering.
 */

export type Concentration = {
  /** Priced, non-suspect holdings. The denominator for everything here. */
  readonly holdingCount: number;
  readonly largest: { readonly symbol: string; readonly sharePct: string } | null;
  /** Share held by the top three, when there are more than three holdings. */
  readonly topThreeSharePct: string | null;
  /** How few holdings account for 90% of the subtotal. */
  readonly holdingsToReachNinetyPct: number | null;
};

export type ExposureSlice = {
  readonly tracks: TrackedAsset;
  readonly sharePct: string;
  readonly valueUsd: string;
  /** Forms present in this slice, so a receipt is not silently called a balance. */
  readonly forms: readonly HoldingForm[];
};

export type NetworkSlice = {
  readonly chainName: string;
  readonly sharePct: string;
};

export type PortfolioInsights = {
  readonly concentration: Concentration;
  readonly exposure: readonly ExposureSlice[];
  /**
   * Null while an aggregate is still arriving, or on a single-network view.
   *
   * A cross-network claim computed from a partial aggregate would say "100% sits
   * on Ethereum" while four networks were still loading — the same defect as an
   * empty state that spoke for a network it had not read (ADR-015).
   */
  readonly networks: readonly NetworkSlice[] | null;
  /** What the shares above deliberately leave out. */
  readonly excluded: {
    readonly unpricedCount: number;
    readonly suspectCount: number;
  };
};

/** Below this many priced holdings there is nothing worth characterising. */
export const MIN_HOLDINGS_FOR_INSIGHTS = 2;

type InsightAsset = Pick<
  PortfolioAsset,
  'symbol' | 'valueUsd' | 'chainId' | 'contractAddress' | 'suspect'
> & { readonly chainName?: string };

/**
 * Computes the facts, or null when the portfolio is too small to say anything
 * about.
 *
 * `networksComplete` must be false whenever a cross-network view is still
 * arriving. It is a required argument rather than an optional one so a caller
 * cannot leave a partial aggregate looking settled by forgetting it.
 */
export function computeInsights(input: {
  assets: readonly InsightAsset[];
  networksComplete: boolean;
  /** False on a single-network view, where a network breakdown says nothing. */
  includeNetworks: boolean;
}): PortfolioInsights | null {
  const counted = input.assets.filter((asset) => !asset.suspect);
  const priced = counted.filter(
    (asset): asset is InsightAsset & { valueUsd: string } => asset.valueUsd !== null,
  );

  if (priced.length < MIN_HOLDINGS_FOR_INSIGHTS) {
    return null;
  }

  const subtotal = sumMoney(priced.map((asset) => asset.valueUsd));
  if (compareDecimal(subtotal, '0') <= 0) {
    // Everything rounds to nothing, so every share would be a division by zero
    // or a meaningless 100%.
    return null;
  }

  const ranked = [...priced].sort((a, b) => -compareDecimal(a.valueUsd, b.valueUsd));

  return {
    concentration: {
      holdingCount: priced.length,
      largest:
        ranked[0] === undefined
          ? null
          : {
              symbol: ranked[0].symbol,
              sharePct: share(ranked[0].valueUsd, subtotal),
            },
      topThreeSharePct:
        ranked.length > 3
          ? share(sumMoney(ranked.slice(0, 3).map((a) => a.valueUsd)), subtotal)
          : null,
      holdingsToReachNinetyPct: countToReach(ranked, subtotal, '90'),
    },
    exposure: computeExposure(ranked, subtotal),
    networks:
      input.includeNetworks && input.networksComplete ? computeNetworks(ranked, subtotal) : null,
    excluded: {
      unpricedCount: counted.length - priced.length,
      suspectCount: input.assets.length - counted.length,
    },
  };
}

/**
 * How many holdings, largest first, are needed to reach a share of the subtotal.
 *
 * Null when the target is never reached, which cannot happen for a target below
 * 100 but is expressed rather than assumed.
 */
function countToReach(
  ranked: readonly { valueUsd: string }[],
  subtotal: string,
  targetPct: string,
): number | null {
  let accumulated = '0';
  for (const [index, asset] of ranked.entries()) {
    accumulated = sumMoney([accumulated, asset.valueUsd]);
    const reached = percentageOf(accumulated, subtotal);
    if (reached !== null && compareDecimal(reached, targetPct) >= 0) {
      return index + 1;
    }
  }
  return null;
}

/**
 * Value grouped by what it is designed to track.
 *
 * Unclassified is a slice like any other, and deliberately not folded into an
 * "other" bucket: a reader is entitled to know how much of the figure the
 * registry could not speak for.
 */
function computeExposure(
  ranked: readonly (InsightAsset & { valueUsd: string })[],
  subtotal: string,
): ExposureSlice[] {
  const groups = new Map<TrackedAsset, { values: string[]; forms: Set<HoldingForm> }>();

  for (const asset of ranked) {
    const { tracks, form } = classifyAsset(asset);
    const group = groups.get(tracks) ?? { values: [], forms: new Set<HoldingForm>() };
    group.values.push(asset.valueUsd);
    group.forms.add(form);
    groups.set(tracks, group);
  }

  return [...groups.entries()]
    .map(([tracks, group]) => {
      const valueUsd = sumMoney(group.values);
      return { tracks, valueUsd, sharePct: share(valueUsd, subtotal), forms: [...group.forms] };
    })
    .sort((a, b) => -compareDecimal(a.valueUsd, b.valueUsd));
}

/** Value grouped by network, for the cross-chain view only. */
function computeNetworks(
  ranked: readonly (InsightAsset & { valueUsd: string })[],
  subtotal: string,
): NetworkSlice[] {
  const groups = new Map<string, string[]>();
  for (const asset of ranked) {
    const name = asset.chainName;
    if (name === undefined) {
      continue;
    }
    groups.set(name, [...(groups.get(name) ?? []), asset.valueUsd]);
  }

  return [...groups.entries()]
    .map(([chainName, values]) => ({
      chainName,
      total: sumMoney(values),
    }))
    .sort((a, b) => -compareDecimal(a.total, b.total))
    .map(({ chainName, total }) => ({ chainName, sharePct: share(total, subtotal) }));
}

/** A share of the subtotal. The subtotal is known positive by the caller. */
function share(value: string, subtotal: string): string {
  return percentageOf(value, subtotal) ?? '0.0000';
}
