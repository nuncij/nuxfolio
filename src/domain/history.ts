import { Decimal } from 'decimal.js';

import type { Snapshot } from '@/server/snapshotStore';

/**
 * Turning stored per-chain rows into the series a chart draws.
 *
 * One point per UTC day, summed across the chains recorded that day. The sum happens here
 * rather than in SQL because `total_value_usd` is a decimal string — stored as `TEXT`
 * precisely so SQLite could not turn it into a float — and `SUM()` would undo that in the
 * one place nobody would look (review round 14).
 *
 * **A day is comparable only to a day with the same chains.** The job writes every chain
 * or none, so within one deployment every day has the same set. Adding a sixth network
 * would make tomorrow's total jump for a reason that is not the market, so each point
 * carries the number of chains behind it and the series marks the ones that differ from
 * the most recent. Codex raised this at plan review, and it is cheap to answer here and
 * impossible to answer later.
 */

export type HistoryPoint = {
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  /** Sum across the chains recorded that day. Null when none of them could be priced. */
  readonly totalValueUsd: string | null;
  /** The same, net of Aave debt. Null when no chain had a computable figure. */
  readonly netOfAaveDebtUsd: string | null;
  /** How many chains contributed. */
  readonly chainCount: number;
  /**
   * True when this day covered a different set of chains from the newest point, so a
   * change against its neighbours is not necessarily a change in the money.
   */
  readonly comparable: boolean;
};

export function toHistorySeries(snapshots: readonly Snapshot[]): readonly HistoryPoint[] {
  const byDay = new Map<string, Snapshot[]>();

  for (const snapshot of snapshots) {
    const day = snapshot.capturedAt.slice(0, 10);
    const existing = byDay.get(day);
    if (existing === undefined) {
      byDay.set(day, [snapshot]);
    } else {
      existing.push(snapshot);
    }
  }

  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  // The newest day defines what "a full reading" looks like for this deployment. Older
  // days with a different chain count are marked rather than dropped: they are real
  // observations, they are simply not comparable with the ones beside them.
  const newestChainCount = days.at(-1)?.[1].length ?? 0;

  return days.map(([day, rows]) => ({
    day,
    totalValueUsd: sum(rows.map((row) => row.totalValueUsd)),
    netOfAaveDebtUsd: sum(rows.map((row) => row.netOfAaveDebtUsd)),
    chainCount: rows.length,
    comparable: rows.length === newestChainCount,
  }));
}

/**
 * Sum of the values that exist, or null when none do.
 *
 * Null is not zero, the same rule the whole product follows: a day on which nothing could
 * be priced is a day with no figure, not a day the wallet was worthless. A day where
 * *some* chains priced is summed from those — `sumPortfolioTotals` does the same, and the
 * chart's own `chainCount` is what says how much of the picture that was.
 */
function sum(values: readonly (string | null)[]): string | null {
  const present = values.filter((value): value is string => value !== null);
  if (present.length === 0) {
    return null;
  }
  return present.reduce((total, value) => new Decimal(total).plus(value).toFixed(), '0');
}

/**
 * The change between the first and last comparable points, as a percentage.
 *
 * Null unless there are two comparable points with figures: one point is not a change,
 * and a change measured against a day with a different chain set would be arithmetic
 * across two different questions.
 */
export function describeChange(
  points: readonly HistoryPoint[],
): { readonly pct: string; readonly from: string; readonly to: string } | null {
  const usable = points.filter((point) => point.comparable && point.totalValueUsd !== null);
  const first = usable.at(0);
  const last = usable.at(-1);

  if (first === undefined || last === undefined || first.day === last.day) {
    return null;
  }

  const start = new Decimal(first.totalValueUsd!);
  if (start.isZero()) {
    return null;
  }

  return {
    pct: new Decimal(last.totalValueUsd!).minus(start).dividedBy(start).times(100).toFixed(2),
    from: first.day,
    to: last.day,
  };
}
