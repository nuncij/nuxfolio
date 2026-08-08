import { formatBaseUnits, multiplyToMoney } from './money';

/**
 * A position a protocol holds on the wallet's behalf.
 *
 * The whole reason milestone 5 exists. A Convex staker's Curve LP token is owned by
 * Convex's reward contract, not by the wallet, so every balance-based read this product
 * does — token list or indexer — finds nothing at all. Unlike an Aave supply, there is
 * no receipt token sitting in the wallet to stand in for it: the position is invisible,
 * not double-counted.
 *
 * **That makes the pricing rule the opposite of ADR-027's.** An Aave row is priced by
 * Aave's own oracle so the rows reconcile with the totals above them. Nothing here has a
 * total to reconcile with, and the thing being valued is an ordinary ERC-20 that the
 * app's own price source may well know — so it is priced by that source (ADR-005), like
 * any other holding.
 *
 * **It is priced only 72 % of the time.** Measured on 2026-08-08 across the 330 Convex
 * pools with anything staked in them, DefiLlama priced 238 — every one at confidence
 * 0.9 or better — but only 13 of the 25 largest, because the biggest are Curve lending
 * market LPs it does not cover. So an unpriced staked position is ordinary here, and the
 * amount has to be able to stand on its own.
 */

export type StakedPosition = {
  /** `${chainId}:${rewardPool}` — stable, and unique per pool per chain. */
  readonly positionId: string;
  readonly chainId: number;
  readonly protocol: 'convex';
  /** The token that was staked, which is what a price source can be asked about. */
  readonly stakedToken: string;
  readonly symbol: string | null;
  /** Decimal amount staked. */
  readonly amount: string;
  /** Null when the price source has no quote for the staked token — often. */
  readonly valueUsd: string | null;
  /**
   * Incentives the pool owes and has not paid.
   *
   * **Always empty in v1, and that is not a claim that there are none.** A Convex
   * staker earns CRV, CVX and sometimes a third token, and CVX is minted on a schedule
   * rather than held anywhere a call can find — so reporting only what the pool
   * contracts can answer would understate, which is the mistake M5-4 measured and
   * refused. The field exists because the shape is right; it is filled when the whole
   * figure can be.
   */
  readonly rewards: readonly StakedReward[];
};

export type StakedReward = {
  readonly token: string;
  readonly symbol: string | null;
  readonly amount: string;
  readonly valueUsd: string | null;
};

export type RawStakedPosition = {
  readonly chainId: number;
  readonly rewardPool: string;
  readonly stakedToken: string;
  readonly symbol: string | null;
  readonly decimals: number;
  readonly amount: bigint;
  readonly rewards: readonly RawStakedReward[];
};

export type RawStakedReward = {
  readonly token: string;
  readonly symbol: string | null;
  readonly decimals: number;
  readonly amount: bigint;
};

/**
 * Turns a raw position into one the wire can carry.
 *
 * `priceUsd` is looked up rather than passed in whole, so a caller that has quotes for
 * some tokens and not others cannot accidentally report the missing ones as zero.
 */
export function toStakedPosition(
  raw: RawStakedPosition,
  priceUsd: (token: string) => string | null,
): StakedPosition {
  return {
    positionId: `${raw.chainId}:${raw.rewardPool.toLowerCase()}`,
    chainId: raw.chainId,
    protocol: 'convex',
    stakedToken: raw.stakedToken,
    symbol: raw.symbol,
    amount: formatBaseUnits(raw.amount, raw.decimals),
    valueUsd: value(raw.amount, raw.decimals, priceUsd(raw.stakedToken)),
    rewards: raw.rewards
      .filter((reward) => reward.amount > 0n)
      .map((reward) => ({
        token: reward.token,
        symbol: reward.symbol,
        amount: formatBaseUnits(reward.amount, reward.decimals),
        valueUsd: value(reward.amount, reward.decimals, priceUsd(reward.token)),
      })),
  };
}

/** Whether the wallet has anything here at all. */
export function isStaked(raw: RawStakedPosition): boolean {
  return raw.amount > 0n || raw.rewards.some((reward) => reward.amount > 0n);
}

/**
 * `amount × price`, or null when there is no price.
 *
 * Through the same `multiplyToMoney` every other holding uses, so a staked token and a
 * loose one of the same kind cannot be valued two different ways.
 */
function value(amount: bigint, decimals: number, priceUsd: string | null): string | null {
  if (priceUsd === null) {
    return null;
  }
  return multiplyToMoney(formatBaseUnits(amount, decimals), priceUsd);
}
