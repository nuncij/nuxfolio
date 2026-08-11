import { describe, expect, it } from 'vitest';

import type { Snapshot } from '@/server/snapshotStore';

import { describeChange, toHistorySeries } from './history';

function row(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    address: '0xf635aaee995e61102dd237fd3ae66eeaf7ea7054',
    chainId: 1,
    capturedAt: '2026-08-10T09:00:00.000Z',
    totalValueUsd: '100',
    netOfAaveDebtUsd: '80',
    assetCount: 1,
    pricedCount: 1,
    coverage: 'token-list',
    ...overrides,
  };
}

const onDay = (day: string, values: readonly (string | null)[]) =>
  values.map((value, index) =>
    row({ capturedAt: `${day}T09:00:00.000Z`, chainId: index + 1, totalValueUsd: value }),
  );

describe('toHistorySeries', () => {
  it('sums the chains recorded on a day into one point', () => {
    const series = toHistorySeries(onDay('2026-08-10', ['17445.71428866', '5.12476225']));

    expect(series).toHaveLength(1);
    expect(series[0]?.totalValueUsd).toBe('17450.83905091');
  });

  it('sums in Decimal, so a total is not rounded on its way to a chart', () => {
    // The reason the column is TEXT and the sum is here rather than in SQL: `SUM()` on
    // decimal text would return a float, in the one place nobody would look.
    const series = toHistorySeries(onDay('2026-08-10', ['0.1', '0.2']));

    expect(series[0]?.totalValueUsd).toBe('0.3');
  });

  it('orders days oldest first', () => {
    const series = toHistorySeries([
      ...onDay('2026-08-11', ['2']),
      ...onDay('2026-08-09', ['1']),
      ...onDay('2026-08-10', ['3']),
    ]);

    expect(series.map((point) => point.day)).toEqual(['2026-08-09', '2026-08-10', '2026-08-11']);
  });

  it('reports a day where nothing priced as no figure, never as zero', () => {
    const series = toHistorySeries(onDay('2026-08-10', [null, null]));

    expect(series[0]?.totalValueUsd).toBeNull();
    expect(series[0]?.chainCount).toBe(2);
  });

  it('marks a day whose chain set differs from the newest', () => {
    // Adding a sixth network would make today's total jump for a reason that is not the
    // market. The older days stay in the series and say they are not comparable.
    const series = toHistorySeries([
      ...onDay('2026-08-09', ['10', '20']),
      ...onDay('2026-08-10', ['10', '20', '30']),
    ]);

    expect(series.map((point) => [point.day, point.chainCount, point.comparable])).toEqual([
      ['2026-08-09', 2, false],
      ['2026-08-10', 3, true],
    ]);
  });

  it('marks a swapped chain as not comparable, even at the same count', () => {
    // Replacing one network with another keeps the count while changing what the
    // total measures — the set is the identity, not its size (round 15).
    const series = toHistorySeries([
      row({ capturedAt: '2026-08-09T09:00:00.000Z', chainId: 56 }),
      row({ capturedAt: '2026-08-10T09:00:00.000Z', chainId: 10 }),
    ]);

    expect(series.map((point) => point.comparable)).toEqual([false, true]);
  });

  it('answers no net at all when any chain has none', () => {
    // A stored null means "could not be computed" — the job stores the total for a
    // debt-free chain — so a summed net missing one chain would understate by an
    // amount nobody can see. The total keeps sum-of-present semantics because
    // chainCount qualifies it; the net is exact or absent (round 15).
    const day = [
      row({ capturedAt: '2026-08-10T09:00:00.000Z', chainId: 1, netOfAaveDebtUsd: '80' }),
      row({ capturedAt: '2026-08-10T09:00:00.000Z', chainId: 10, netOfAaveDebtUsd: null }),
    ];
    const series = toHistorySeries(day);

    expect(series[0]?.totalValueUsd).toBe('200');
    expect(series[0]?.netOfAaveDebtUsd).toBeNull();
  });

  it('is empty for a wallet with no history', () => {
    expect(toHistorySeries([])).toEqual([]);
  });
});

describe('describeChange', () => {
  it('measures first to last', () => {
    const change = describeChange(
      toHistorySeries([...onDay('2026-08-09', ['100']), ...onDay('2026-08-10', ['150'])]),
    );

    expect(change).toEqual({ pct: '50.00', from: '2026-08-09', to: '2026-08-10' });
  });

  it('says nothing from a single day, because one point is not a change', () => {
    expect(describeChange(toHistorySeries(onDay('2026-08-10', ['100'])))).toBeNull();
  });

  it('ignores days that are not comparable', () => {
    // Measuring from a two-chain day to a three-chain day would report a network being
    // added as if it were a gain.
    const change = describeChange(
      toHistorySeries([
        ...onDay('2026-08-08', ['1000', '1000']),
        ...onDay('2026-08-09', ['100', '100', '100']),
        ...onDay('2026-08-10', ['100', '100', '400']),
      ]),
    );

    expect(change).toEqual({ pct: '100.00', from: '2026-08-09', to: '2026-08-10' });
  });

  it('says nothing when the first comparable day had no figure', () => {
    expect(
      describeChange(
        toHistorySeries([...onDay('2026-08-09', [null]), ...onDay('2026-08-10', ['100'])]),
      ),
    ).toBeNull();
  });

  it('refuses to divide by a zero start', () => {
    expect(
      describeChange(
        toHistorySeries([...onDay('2026-08-09', ['0']), ...onDay('2026-08-10', ['100'])]),
      ),
    ).toBeNull();
  });
});
