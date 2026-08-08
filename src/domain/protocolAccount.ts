import { Decimal } from 'decimal.js';

import type { ProtocolPosition } from './protocolPosition';
import type { ProtocolReward } from './protocolReward';

/**
 * What a wallet owes a lending protocol, and how close it is to liquidation.
 *
 * This is not an asset and must never be summed into one. `PortfolioAsset` answers
 * "what does this wallet hold"; a protocol account answers "what is it doing", and
 * the two are denominated by different price sources (ADR-005 vs Aave's own oracle —
 * see `M5_PLAN.md` §5a). Keeping them apart is what lets the health factor and the
 * debt figure reconcile with Aave's own interface to the cent.
 *
 * **No net total is derived from these.** Review round 12 (F-02) worked the example:
 * Aave v3 receipt tokens are absent from the bundled lists, so supplied collateral is
 * invisible to `totalValueUsd`. Subtracting debt from that total would report a wallet
 * supplying $100k and borrowing $40k as worth **$0** against a true $60k. The
 * arithmetic crosses two scopes, and no measurement catches that — only working an
 * example end to end does.
 */

/** Aave scales the health factor by 1e18. */
const HEALTH_FACTOR_DECIMALS = 18;

/** Aave's base currency for every registered market: USD at 1e8. */
const BASE_CURRENCY_DECIMALS = 8;

/**
 * `uint256` max. Aave returns this as the health factor when a wallet has no debt —
 * measured, not assumed. Divided naively it renders as `1.157e+59`, so it has to be
 * recognised rather than formatted.
 */
const NO_DEBT_SENTINEL = (2n ** 256n - 1n).toString();

export type ProtocolAccountStatus = 'ok' | 'failed';

/**
 * Whether the per-asset breakdown could be produced, separately from whether the
 * market's totals could.
 *
 * The two reads are different calls to different contracts, and one failing does not
 * make the other wrong. A market whose totals are good but whose breakdown is missing
 * should show the totals — collapsing the two into one status would throw away a
 * perfectly good health factor because a second call timed out (review round 13, F5).
 *
 *  - `ok` — read, and the rows are the whole of it. An empty list here is a confirmed
 *    absence, not an unasked question.
 *  - `failed` — asked, and the market did not answer.
 *  - `unavailable` — this market has no verified detail provider, so its breakdown is
 *    permanently absent rather than temporarily. Two of the seven are in that state.
 *
 * There was briefly a fourth, `not-requested`, for markets whose totals came back at
 * zero on both sides: the breakdown was skipped there to save a call. Measured, that
 * call costs 134 ms across all three Ethereum markets — and skipping it hid every
 * supply with collateral switched off, which is invisible to the totals by definition.
 * Paying the 134 ms buys back both the position and the fourth state (round 13).
 */
export type PositionsStatus = 'ok' | 'failed' | 'unavailable';

export type ProtocolAccount = {
  readonly chainId: number;
  readonly protocol: 'aave-v3';
  /** `${chainId}:${slug}` — Ethereum runs three markets, each with its own figures. */
  readonly marketId: string;
  readonly marketName: string;
  /**
   * `ok` — the read succeeded and the figures below are real, so a zero means zero.
   * `failed` — the call did not answer and the figures are null, which says nothing
   * about the wallet. Collapsing these two would report a broken read as "no debt",
   * which is the substitution this codebase exists to refuse.
   */
  readonly status: ProtocolAccountStatus;
  /**
   * **Collateral, not everything supplied.** `getUserAccountData` counts only reserves
   * the user enabled as collateral, so a supply-with-collateral-off position is
   * invisible here (round 12, F-03). Decimal string, as reported by Aave.
   */
  readonly collateralValueUsd: string | null;
  readonly borrowedValueUsd: string | null;
  /**
   * Aave's own figure, unitless, at 18 decimals. Null when there is no debt — the
   * sentinel above — which the UI renders as "not applicable" rather than a number.
   */
  readonly healthFactor: string | null;
  /**
   * Which assets the totals above are made of, priced by the same oracle that
   * computed them — so the rows add back up to the headline exactly. Empty whenever
   * `positionsStatus` is not `ok`.
   */
  readonly positions: readonly ProtocolPosition[];
  readonly positionsStatus: PositionsStatus;
  /**
   * Incentives the market owes but has not paid out. Not a position and not an asset:
   * claiming is a transaction, so this is never summed into anything above it.
   */
  readonly rewards: readonly ProtocolReward[];
  /** Read separately from the positions, so one failing does not cost the other. */
  readonly rewardsStatus: PositionsStatus;
};

/** What one market's raw `getUserAccountData` returns, before any scaling. */
export type RawAccountData = {
  readonly totalCollateralBase: string;
  readonly totalDebtBase: string;
  readonly healthFactor: string;
};

/**
 * Turns one raw response into an account.
 *
 * Every conversion goes through `Decimal`, never a float: the base figures are 8
 * decimals and the health factor 18, and `Number` loses digits well before either
 * exhausts its range (ADR-003).
 */
export function toProtocolAccount(input: {
  chainId: number;
  marketId: string;
  marketName: string;
  raw: RawAccountData;
  positions?: readonly ProtocolPosition[];
  positionsStatus: PositionsStatus;
  rewards?: readonly ProtocolReward[];
  rewardsStatus: PositionsStatus;
}): ProtocolAccount {
  const { raw } = input;

  return {
    chainId: input.chainId,
    protocol: 'aave-v3',
    marketId: input.marketId,
    marketName: input.marketName,
    status: 'ok',
    collateralValueUsd: scale(raw.totalCollateralBase, BASE_CURRENCY_DECIMALS),
    borrowedValueUsd: scale(raw.totalDebtBase, BASE_CURRENCY_DECIMALS),
    healthFactor: toHealthFactor(raw.healthFactor),
    positions: input.positions ?? [],
    positionsStatus: input.positionsStatus,
    rewards: input.rewards ?? [],
    rewardsStatus: input.rewardsStatus,
  };
}

/** A market that could not be read. Its figures are absent, not zero. */
export function failedProtocolAccount(input: {
  chainId: number;
  marketId: string;
  marketName: string;
  positionsStatus: PositionsStatus;
  rewardsStatus: PositionsStatus;
}): ProtocolAccount {
  return {
    chainId: input.chainId,
    protocol: 'aave-v3',
    marketId: input.marketId,
    marketName: input.marketName,
    status: 'failed',
    collateralValueUsd: null,
    borrowedValueUsd: null,
    healthFactor: null,
    positions: [],
    positionsStatus: input.positionsStatus,
    rewards: [],
    rewardsStatus: input.rewardsStatus,
  };
}

/**
 * The health factor, or null when the wallet has no debt.
 *
 * The sentinel check is an exact string comparison against `uint256` max rather than
 * a threshold: "very large" and "the specific value meaning none" are different
 * claims, and a threshold would quietly reclassify a real-but-huge factor.
 */
export function toHealthFactor(raw: string): string | null {
  if (raw === NO_DEBT_SENTINEL) {
    return null;
  }
  return scale(raw, HEALTH_FACTOR_DECIMALS);
}

/** True when this account is worth showing at all. */
export function hasPosition(account: ProtocolAccount): boolean {
  if (account.status === 'failed') {
    // A failed read is worth showing precisely because it is not "no position".
    return true;
  }
  return (
    isPositive(account.collateralValueUsd) ||
    isPositive(account.borrowedValueUsd) ||
    // A supply with collateral switched off contributes to neither total, so without
    // this clause the one wallet whose position is *only* visible in the breakdown
    // would see an empty panel. Rewards do the same: measured on Optimism, most wallets
    // with something unclaimed hold nothing in the market any more.
    account.positions.length > 0 ||
    account.rewards.length > 0
  );
}

/**
 * Total debt across accounts, with the coverage that qualifies it.
 *
 * Deliberately not routed through `sumPortfolioTotals`: that reducer drops null
 * subtotals before summing, which is right for a chain that failed to load but wrong
 * here — it would turn a failed Aave read into a smaller, complete-looking debt figure
 * (round 12, F-06). The counts travel with the number so the UI can say "so far".
 */
export function summarizeAccounts(accounts: readonly ProtocolAccount[]): {
  readonly borrowedValueUsd: string | null;
  readonly collateralValueUsd: string | null;
  readonly marketsChecked: number;
  readonly marketsFailed: number;
  /** The closest any market is to liquidation. Health factors are not additive. */
  readonly lowestHealthFactor: string | null;
} {
  const ok = accounts.filter((account) => account.status === 'ok');
  const failed = accounts.length - ok.length;

  const borrowed = sumDecimals(ok.map((account) => account.borrowedValueUsd));
  const collateral = sumDecimals(ok.map((account) => account.collateralValueUsd));

  const factors = ok
    .map((account) => account.healthFactor)
    .filter((value): value is string => value !== null);

  const lowest = factors.length === 0 ? null : factors.reduce((a, b) => (lt(a, b) ? a : b));

  return {
    borrowedValueUsd: borrowed,
    collateralValueUsd: collateral,
    marketsChecked: ok.length,
    marketsFailed: failed,
    lowestHealthFactor: lowest,
  };
}

function scale(raw: string, decimals: number): string {
  return new Decimal(raw).dividedBy(new Decimal(10).pow(decimals)).toFixed();
}

function sumDecimals(values: readonly (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null);
  if (present.length === 0) {
    return null;
  }
  return present.reduce((total, value) => new Decimal(total).plus(value).toFixed(), '0');
}

function isPositive(value: string | null): boolean {
  return value !== null && new Decimal(value).greaterThan(0);
}

function lt(a: string, b: string): boolean {
  return new Decimal(a).lessThan(b);
}
