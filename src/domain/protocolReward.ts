import { formatBaseUnits } from './money';

/**
 * An unclaimed incentive sitting in a lending market's rewards controller.
 *
 * Not a position and not an asset. It is not in the wallet — claiming it is a
 * transaction — so it is never summed into `totalValueUsd`, and it is not part of the
 * collateral or debt totals it appears beneath either. It is money the wallet is owed
 * and cannot see anywhere else in this product.
 *
 * **Priced by the market's oracle, when the market's oracle knows the token.** Measured
 * on 2026-08-08: `getAssetPrice` answers for OP, ARB and wstETH, and **reverts** for the
 * four Ethereum reward tokens that are themselves aTokens. So a null price here is the
 * common case rather than the exceptional one, and the amount has to stand on its own.
 *
 * **Rounded down**, like a supplied balance. This is a holding, and rounding a holding
 * up promises more than the protocol will hand over.
 */

/** Aave's base currency for every registered market: USD at 1e8. */
const BASE_CURRENCY_DECIMALS = 8;

export type ProtocolReward = {
  /** The reward token's address. */
  readonly token: string;
  /** Read from the token itself; null when it has none that can be decoded. */
  readonly symbol: string | null;
  /** Decimal amount unclaimed. Never "0" — a zero reward is not a reward. */
  readonly amount: string;
  /** Null when the market oracle has no price for this token, which is usual. */
  readonly valueUsd: string | null;
};

export type RawReward = {
  readonly token: string;
  readonly symbol: string | null;
  readonly decimals: number;
  readonly amount: bigint;
  readonly priceBase: bigint | null;
};

export function toProtocolReward(raw: RawReward): ProtocolReward {
  const unit = 10n ** BigInt(raw.decimals);

  return {
    token: raw.token,
    symbol: raw.symbol,
    amount: formatBaseUnits(raw.amount, raw.decimals),
    valueUsd:
      raw.priceBase === null
        ? null
        : formatBaseUnits((raw.amount * raw.priceBase) / unit, BASE_CURRENCY_DECIMALS),
  };
}

/**
 * Whether this reward is worth a row.
 *
 * `getAllUserRewards` returns an entry for every reward token the market has *ever*
 * configured — five on Ethereum — with a zero amount for the ones the wallet has not
 * earned. Rendering those would put four empty promises under every position.
 */
export function isUnclaimed(raw: RawReward): boolean {
  return raw.amount > 0n;
}
