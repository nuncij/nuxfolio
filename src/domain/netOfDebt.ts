import { Decimal } from 'decimal.js';

import type { PortfolioAsset } from './portfolio';
import type { ProtocolAccount } from './protocolAccount';

/**
 * The wallet's value once its Aave position is counted exactly once and its Aave debt is
 * taken off.
 *
 * ADR-026 refused this figure, and the refusal was right at the time: `total − debt` is
 * correct for a wallet whose receipt token happens to be on a bundled list and wrong by
 * the entire collateral for one whose is not, with nothing at runtime telling the two
 * apart. M5-2 supplied the missing piece — every position now carries the address of the
 * receipt token it is held as — so the two cases can finally be distinguished rather
 * than gambled on. See ADR-029.
 *
 * The arithmetic, per chain:
 *
 * ```
 *   priced subtotal                     (assets, priced by the app's source)
 * − receipt tokens already in it        (removing the double count)
 * + supplied, priced by the market      (adding the position back, once)
 * − borrowed, priced by the market
 * ```
 *
 * **It answers null far more readily than it answers a number**, and that is the whole
 * design. Every condition below is a case where the sum would be wrong in a way no
 * reader could detect, and a plausible wrong net worth is the single most damaging thing
 * this product could show.
 */

export type NetOfDebt = {
  /** The figure, or null when it cannot be computed exactly. */
  readonly valueUsd: string | null;
  /**
   * Why there is no figure. Null when there is one — and `no-debt` when the wallet
   * simply owes nothing, where a "net" is just the total and worth no second number.
   */
  readonly reason: 'no-debt' | 'nothing-priced' | 'market-unreadable' | 'position-unpriced' | null;
};

export function computeNetOfDebt(input: {
  totalValueUsd: string | null;
  assets: readonly PortfolioAsset[];
  accounts: readonly ProtocolAccount[];
}): NetOfDebt {
  const { totalValueUsd, assets, accounts } = input;

  const engaged = accounts.filter(
    (account) =>
      account.status === 'failed' ||
      isPositive(account.collateralValueUsd) ||
      isPositive(account.borrowedValueUsd) ||
      account.positions.length > 0,
  );

  // A market that did not answer, or that cannot say which assets its totals are made
  // of, leaves the double count undetectable: adding its collateral would count a
  // listed receipt token twice, and not adding it would drop the collateral entirely.
  // Both are wrong by thousands of dollars, so neither is guessed at. Checked before
  // the debt test, because "no debt" is a claim about a market that answered — a failed
  // read showing no debt is a market whose debt is invisible, not absent (round 15).
  if (engaged.some((account) => account.status === 'failed' || account.positionsStatus !== 'ok')) {
    return { valueUsd: null, reason: 'market-unreadable' };
  }

  if (!engaged.some((account) => isPositive(account.borrowedValueUsd))) {
    // Nothing is owed, so the net figure is the total and a second copy of it would
    // only invite the reader to look for a difference that is not there.
    return { valueUsd: null, reason: 'no-debt' };
  }

  if (totalValueUsd === null) {
    return { valueUsd: null, reason: 'nothing-priced' };
  }

  const positions = engaged.flatMap((account) => account.positions);
  if (
    positions.some(
      (position) => position.suppliedValueUsd === null || position.borrowedValueUsd === null,
    )
  ) {
    // The market oracle had no price for something the wallet holds in it. Leaving that
    // position out would understate by exactly the amount nobody can see.
    return { valueUsd: null, reason: 'position-unpriced' };
  }

  // Only assets that are actually inside the subtotal can be double counted. A suspect
  // asset was excluded from it (ADR-014), an unpriced one contributes nothing, and one
  // dropped by the per-chain cap never reached this list at all.
  const counted = new Map<string, string>();
  for (const asset of assets) {
    if (asset.suspect || asset.valueUsd === null || asset.contractAddress === null) {
      continue;
    }
    counted.set(`${asset.chainId}:${asset.contractAddress.toLowerCase()}`, asset.valueUsd);
  }

  let net = new Decimal(totalValueUsd);

  for (const account of engaged) {
    for (const position of account.positions) {
      const alreadyCounted = counted.get(
        `${account.chainId}:${position.aTokenAddress.toLowerCase()}`,
      );
      if (alreadyCounted !== undefined) {
        net = net.minus(alreadyCounted);
      }
      net = net.plus(position.suppliedValueUsd ?? '0').minus(position.borrowedValueUsd ?? '0');
    }
  }

  return { valueUsd: net.toFixed(), reason: null };
}

function isPositive(value: string | null): boolean {
  return value !== null && new Decimal(value).greaterThan(0);
}
