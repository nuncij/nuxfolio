/**
 * Aave's fixed-point arithmetic, reproduced exactly.
 *
 * Aave stores a user's balance *scaled*: divided by an ever-growing index that
 * accrues interest. The real amount is `scaled × index / 1e27`, and every figure this
 * product shows about a position depends on getting that one multiplication right.
 *
 * **The index must be the normalized one, not the stored one.** `Pool.getReserveData`
 * returns the index as of the last time anyone touched that reserve;
 * `getReserveNormalizedIncome` / `getReserveNormalizedVariableDebt` accrue it to now,
 * and that is what the aToken's `balanceOf` uses. Review round 13 caught this: an
 * earlier version of this file claimed the arithmetic was "verified exactly" against
 * a real balance, which was true — of one busy reserve touched minutes earlier.
 * Measured on 2026-08-07, all five reserves checked had a stored index behind the
 * normalized one. The gap grows with time since the last update: at a 5 % supply rate
 * it is about $14 per $100,000 after a day and $411 after a month, always understating,
 * always in the protocol's favour.
 *
 * **Rounding follows Aave's own direction per side.** Current Aave rounds an aToken
 * balance **down** and a variable debt **up** (`TokenMath`), so neither figure
 * flatters the user. Older versions used half-up, which is what this file did first.
 * The difference is at most one base unit — $0.000001 on USDC — and it is matched
 * anyway, because the entire claim of this feature is that its figures reconcile with
 * Aave's interface, and a number off by one unit from the source it mirrors is one
 * someone eventually has to explain.
 *
 * `bigint` throughout: an 18-decimal balance times a 27-decimal index exceeds
 * `Number.MAX_SAFE_INTEGER` by twenty orders of magnitude, so a float here would not
 * be imprecise, it would be wrong (ADR-003).
 */

/** Aave's ray: fixed point with 27 decimals. */
export const RAY = 10n ** 27n;

function guard(scaled: bigint, index: bigint): void {
  if (scaled < 0n || index < 0n) {
    // Neither a balance nor an index is signed on chain, so a negative here means a
    // decoding bug upstream — worth failing loudly rather than scaling it.
    throw new RangeError('rayMul takes non-negative values; both are unsigned on chain');
  }
}

/**
 * A supplied balance: `scaled × index`, rounded **down**.
 *
 * Down because that is what Aave's aToken does, and rounding a holding up would
 * report more than the protocol will hand back.
 */
export function rayMulSupply(scaled: bigint, normalizedIncome: bigint): bigint {
  guard(scaled, normalizedIncome);
  return (scaled * normalizedIncome) / RAY;
}

/**
 * A borrowed balance: `scaled × index`, rounded **up**.
 *
 * Up, for the same reason in the other direction: a debt rounded down is a debt
 * understated, and this is the number a reader is deciding about.
 */
export function rayMulDebt(scaled: bigint, normalizedDebt: bigint): bigint {
  guard(scaled, normalizedDebt);
  const product = scaled * normalizedDebt;
  return product === 0n ? 0n : (product + RAY - 1n) / RAY;
}

/**
 * A ray as a decimal string, for display or for `Decimal` to take over.
 *
 * Not `Number(ray) / 1e27` — that loses digits before it starts.
 */
export function rayToDecimalString(ray: bigint): string {
  const whole = ray / RAY;
  const fraction = (ray % RAY).toString().padStart(27, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}
