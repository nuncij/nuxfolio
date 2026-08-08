import { compareDecimal, sumMoney } from '@/domain/money';

/**
 * How the asset table is divided up, as a pure function.
 *
 * This is presentation only — nothing here changes a total. A wallet that has
 * been airdropped forty sub-dollar tokens is not wrong, it is unreadable, and
 * the fix for unreadable is a fold, not an exclusion. Every asset stays in the
 * response, in the counts, and (for dust) in the total.
 *
 * Suspect assets are a different matter and are separated first: they are
 * already outside the total on the server (ADR-014), so they must never share a
 * body with real holdings regardless of how much they are worth.
 */

/**
 * Below this many dollars a row is folded away by default. One dollar is a
 * round number rather than a derived one: it is small enough that no real
 * position is hidden by it and large enough to catch the airdrop tail.
 */
export const SMALL_BALANCE_THRESHOLD_USD = '1';

export type DisplayAsset = {
  readonly valueUsd: string | null;
  readonly suspect: boolean;
};

export type AssetGroups<T> = {
  readonly primary: T[];
  readonly dust: T[];
  readonly suspect: T[];
  /** Sum of the folded rows. Null when there are none. */
  readonly dustValueUsd: string | null;
  /** Sum of the excluded rows. Null when there are none priced. */
  readonly suspectValueUsd: string | null;
};

/**
 * Splits assets into the three bodies the table renders. Input order is
 * preserved inside each group, so the caller's sort survives the split.
 *
 * An asset with no price stays primary: it carries its own flags, cannot
 * distort the total, and is exactly the kind of row that should not be hidden.
 */
export function groupAssetsForDisplay<T extends DisplayAsset>(
  assets: readonly T[],
): AssetGroups<T> {
  const primary: T[] = [];
  const dust: T[] = [];
  const suspect: T[] = [];

  for (const asset of assets) {
    if (asset.suspect) {
      suspect.push(asset);
    } else if (isSmallBalance(asset)) {
      dust.push(asset);
    } else {
      primary.push(asset);
    }
  }

  return {
    primary,
    dust,
    suspect,
    dustValueUsd: sumPricedValues(dust),
    suspectValueUsd: sumPricedValues(suspect),
  };
}

/** Strictly below the threshold, so exactly $1.00 stays in the main table. */
export function isSmallBalance(asset: DisplayAsset): boolean {
  return asset.valueUsd !== null && compareDecimal(asset.valueUsd, SMALL_BALANCE_THRESHOLD_USD) < 0;
}

function sumPricedValues(assets: readonly DisplayAsset[]): string | null {
  const values = assets
    .map((asset) => asset.valueUsd)
    .filter((value): value is string => value !== null);
  return values.length > 0 ? sumMoney(values) : null;
}

/**
 * The same fold, applied to unclaimed rewards.
 *
 * Shares {@link SMALL_BALANCE_THRESHOLD_USD} rather than picking a second number: two
 * thresholds on one page would be two different opinions about what counts as money.
 *
 * It also inherits the rule that matters most here — **an unpriced row is never dust**.
 * On Ethereum four of the five reward tokens are aTokens the market oracle has no feed
 * for, so hiding what cannot be priced would fold away most of the feature.
 */
export function partitionRewards<T extends { valueUsd: string | null }>(
  rewards: readonly T[],
): { readonly shown: T[]; readonly small: T[]; readonly smallValueUsd: string | null } {
  const shown: T[] = [];
  const small: T[] = [];

  for (const reward of rewards) {
    (isSmallBalance({ ...reward, suspect: false }) ? small : shown).push(reward);
  }

  return {
    shown,
    small,
    smallValueUsd: sumPricedValues(small.map(({ valueUsd }) => ({ valueUsd, suspect: false }))),
  };
}
