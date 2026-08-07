import { Decimal } from 'decimal.js';

import { formatBaseUnits } from './money';

/**
 * One asset inside a lending market: how much of it the wallet supplied or borrowed,
 * and what the market's own oracle says that is worth.
 *
 * **Priced by the market, not by the app.** Every other value in this product comes
 * from the price provider in ADR-005; these come from the same `AaveOracle` that
 * computed the market totals shown above them. That is deliberate, and it is what makes
 * the rows *explain* the headline rather than merely sit under it: measured on
 * 2026-08-07 across four consecutive blocks, the rows summed to `getUserAccountData`'s
 * collateral and debt to **zero base units** on both sides. A row priced by DefiLlama
 * under a total priced by Aave would be off by a different fraction of a percent every
 * block, and no one looking at the page could tell whether that gap was rounding or a
 * bug. See ADR-027.
 *
 * **Rounding follows Aave's, at both steps.** A supplied balance floors when it is
 * scaled and floors again when it is valued; a debt ceils at both. That is not a
 * stylistic choice — it is the difference measured: with the value division floored on
 * both sides the debt total came out 3 base units short, exactly one per borrowed row,
 * and ceiling it landed on zero. Neither figure is allowed to flatter the reader.
 */

/** Aave's base currency for every registered market: USD at 1e8. */
const BASE_CURRENCY_DECIMALS = 8;

export type ProtocolPosition = {
  /** The underlying token's address, as the market reports it. */
  readonly asset: string;
  /** Read from the token itself. Null when it has no symbol that can be decoded. */
  readonly symbol: string | null;
  /** Decimal amount supplied, "0" when none. */
  readonly supplied: string;
  /** Decimal amount borrowed, "0" when none. */
  readonly borrowed: string;
  /**
   * Whether this supply backs the wallet's borrowing. A supply with this off is
   * invisible to the market's collateral total, so the flag is what explains a row
   * that appears to be missing from the headline above it.
   */
  readonly usedAsCollateral: boolean;
  /** Null when the market oracle had no price, never 0 in that case. */
  readonly suppliedValueUsd: string | null;
  readonly borrowedValueUsd: string | null;
};

/** One reserve's raw figures, in base units of the asset and of the market's currency. */
export type RawPosition = {
  readonly asset: string;
  readonly symbol: string | null;
  readonly decimals: number;
  readonly supplied: bigint;
  readonly borrowed: bigint;
  readonly usedAsCollateral: boolean;
  readonly priceBase: bigint | null;
};

export function toProtocolPosition(raw: RawPosition): ProtocolPosition {
  const unit = 10n ** BigInt(raw.decimals);

  return {
    asset: raw.asset,
    symbol: raw.symbol,
    supplied: formatBaseUnits(raw.supplied, raw.decimals),
    borrowed: formatBaseUnits(raw.borrowed, raw.decimals),
    usedAsCollateral: raw.usedAsCollateral,
    suppliedValueUsd: value(raw.supplied, raw.priceBase, unit, floorDiv),
    borrowedValueUsd: value(raw.borrowed, raw.priceBase, unit, ceilDiv),
  };
}

/**
 * Whether a position is worth a row.
 *
 * A reserve the wallet has neither supplied to nor borrowed from is not a position, and
 * a row of zeroes would be a claim about an asset the wallet does not hold.
 */
export function isOpen(position: ProtocolPosition): boolean {
  return !isZero(position.supplied) || !isZero(position.borrowed);
}

function value(
  amount: bigint,
  priceBase: bigint | null,
  unit: bigint,
  divide: (numerator: bigint, denominator: bigint) => bigint,
): string | null {
  if (priceBase === null) {
    return null;
  }
  return scale(divide(amount * priceBase, unit), BASE_CURRENCY_DECIMALS);
}

function floorDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator / denominator;
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

/**
 * A value in the market's base currency as a decimal string.
 *
 * `formatBaseUnits` rather than `Decimal.dividedBy`: decimal.js rounds a division to 20
 * significant digits by default, so a 21-digit base-unit figure comes back quietly
 * short — `123456789012345678901` at 18 decimals renders as `123.4567890123456789`,
 * losing the last two units. Review round 13 caught that; shifting the decimal point is
 * exact by construction and cannot round at all.
 */
function scale(baseUnits: bigint, decimals: number): string {
  return formatBaseUnits(baseUnits, decimals);
}

function isZero(value: string): boolean {
  // `Decimal` is exact here — it is only `dividedBy` above that rounds.
  return new Decimal(value).isZero();
}
