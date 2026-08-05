import { describe, expect, it } from 'vitest';

import {
  comparePrices,
  DEFAULT_DISPUTE_TOLERANCE,
  largestDispute,
  selectAssetsToCrossCheck,
  summarizePriceChecks,
} from './priceCheck';
import type { PriceCheck } from './portfolio';

function candidate(id: string, valueUsd: string | null, priceUsd: string | null = '1') {
  return { assetId: id, valueUsd, priceUsd, contractAddress: null };
}

describe('selectAssetsToCrossCheck', () => {
  it('covers the requested share of value with the largest holdings first', () => {
    // 900 + 80 = 980 of 1000, which clears 95 %; the 15 and 5 are not worth quota.
    const selected = selectAssetsToCrossCheck(
      [candidate('a', '900'), candidate('b', '80'), candidate('c', '15'), candidate('d', '5')],
      { coverage: 0.95 },
    );

    expect(selected.map((a) => a.assetId)).toEqual(['a', 'b']);
  });

  it('includes the asset that crosses the threshold rather than stopping short', () => {
    // Two assets of 50 each: the first alone is 50 %, so the second is required.
    const selected = selectAssetsToCrossCheck([candidate('a', '50'), candidate('b', '50')], {
      coverage: 0.95,
    });
    expect(selected).toHaveLength(2);
  });

  it('sorts by value regardless of input order', () => {
    const selected = selectAssetsToCrossCheck([candidate('small', '1'), candidate('big', '999')], {
      coverage: 0.5,
    });
    expect(selected[0]?.assetId).toBe('big');
  });

  it('respects the per-chain cap even when coverage is not reached', () => {
    // Quota is finite; the cap is what bounds it.
    const many = Array.from({ length: 40 }, (_, i) => candidate(`a${i}`, '10'));
    expect(selectAssetsToCrossCheck(many, { coverage: 1, maxAssets: 25 })).toHaveLength(25);
  });

  it('skips unpriced assets, which have nothing to compare', () => {
    const selected = selectAssetsToCrossCheck([
      candidate('priced', '100'),
      candidate('unpriced', null, null),
    ]);
    expect(selected.map((a) => a.assetId)).toEqual(['priced']);
  });

  it('returns nothing for an empty portfolio', () => {
    expect(selectAssetsToCrossCheck([])).toEqual([]);
  });

  it('returns nothing when the cap is zero, rather than silently checking one', () => {
    expect(selectAssetsToCrossCheck([candidate('a', '100')], { maxAssets: 0 })).toEqual([]);
  });

  it('returns nothing when coverage is zero, which means switched off', () => {
    // Spending one call anyway would ignore an operator who asked for none.
    expect(selectAssetsToCrossCheck([candidate('a', '100')], { coverage: 0 })).toEqual([]);
    // Including the all-dust case, which otherwise checks one asset on purpose.
    expect(selectAssetsToCrossCheck([candidate('a', '0')], { coverage: 0 })).toEqual([]);
  });

  it('still checks one asset when everything rounds to no value', () => {
    // An all-dust wallet would otherwise cross-check nothing at all, making the
    // feature silently inert exactly where a fabricated price is most likely.
    const selected = selectAssetsToCrossCheck([candidate('a', '0'), candidate('b', '0')]);
    expect(selected).toHaveLength(1);
  });

  it('ranks by decimal value, not by float', () => {
    const selected = selectAssetsToCrossCheck(
      [candidate('lo', '9007199254740992'), candidate('hi', '9007199254740993')],
      { coverage: 0.1 },
    );
    expect(selected[0]?.assetId).toBe('hi');
  });
});

describe('comparePrices', () => {
  const source = 'coingecko';

  it('agrees when the two sources are close', () => {
    expect(comparePrices({ primaryUsd: '100', secondUsd: '101', source })).toMatchObject({
      status: 'agreed',
      priceUsd: '101',
      deltaPct: '1.0000',
    });
  });

  it('disputes when they diverge beyond tolerance', () => {
    expect(comparePrices({ primaryUsd: '100', secondUsd: '140', source })).toMatchObject({
      status: 'disputed',
      deltaPct: '40.0000',
    });
  });

  it('treats exactly the tolerance as agreement, not dispute', () => {
    // A boundary decided by float arithmetic would be arbitrary; this pins it.
    const atBoundary = comparePrices({
      primaryUsd: '100',
      secondUsd: '102',
      source,
      tolerance: 0.02,
    });
    expect(atBoundary.status).toBe('agreed');

    const justOver = comparePrices({
      primaryUsd: '100',
      secondUsd: '102.01',
      source,
      tolerance: 0.02,
    });
    expect(justOver.status).toBe('disputed');
  });

  it('is symmetric about which source is higher', () => {
    const higher = comparePrices({ primaryUsd: '100', secondUsd: '150', source });
    const lower = comparePrices({ primaryUsd: '100', secondUsd: '50', source });
    expect(higher.deltaPct).toBe('50.0000');
    expect(lower.deltaPct).toBe('50.0000');
  });

  it('reports unverified when the second source has no opinion', () => {
    expect(comparePrices({ primaryUsd: '100', secondUsd: null, source })).toEqual({
      status: 'unverified',
      source,
      priceUsd: null,
      deltaPct: null,
    });
  });

  it.each(['0', '-1', '0.00'])(
    'reports unverified rather than dividing by a primary of %o',
    (primaryUsd) => {
      const result = comparePrices({ primaryUsd, secondUsd: '10', source });
      expect(result.status).toBe('unverified');
      expect(result.deltaPct).toBeNull();
    },
  );

  it('reports unverified for a non-positive second opinion, which is not a price', () => {
    expect(comparePrices({ primaryUsd: '100', secondUsd: '0', source }).status).toBe('unverified');
  });

  it('compares tiny prices by relative difference, where absolutes would mislead', () => {
    // Two hundredths of a cent apart is enormous on a $0.05 token.
    expect(comparePrices({ primaryUsd: '0.05', secondUsd: '0.07', source }).status).toBe(
      'disputed',
    );
    // The same absolute gap is nothing on a $60,000 one.
    expect(comparePrices({ primaryUsd: '60000', secondUsd: '60000.02', source }).status).toBe(
      'agreed',
    );
  });

  it('handles values beyond float precision exactly', () => {
    expect(
      comparePrices({
        primaryUsd: '9007199254740993',
        secondUsd: '9007199254740993',
        source,
      }),
    ).toMatchObject({ status: 'agreed', deltaPct: '0.0000' });
  });

  it('defaults to the documented tolerance', () => {
    expect(DEFAULT_DISPUTE_TOLERANCE).toBe(0.02);
    expect(comparePrices({ primaryUsd: '100', secondUsd: '103', source }).status).toBe('disputed');
  });
});

describe('summarizePriceChecks', () => {
  const check = (status: PriceCheck['status']): PriceCheck => ({
    status,
    source: 'coingecko',
    priceUsd: '1',
    deltaPct: '0.0000',
  });

  it('counts each outcome separately', () => {
    const summary = summarizePriceChecks([
      { priceCheck: check('agreed') },
      { priceCheck: check('disputed') },
      { priceCheck: check('unverified') },
      { priceCheck: null },
    ]);

    // Three were asked about; the fourth was never checked and is not counted as
    // agreement.
    expect(summary).toEqual({
      checkedAssetCount: 3,
      agreedAssetCount: 1,
      disputedAssetCount: 1,
    });
  });

  it('counts agreement rather than inferring it from "not disputed"', () => {
    // The distinction the summary sentence rests on: an asset the second source
    // declined to price was asked about and gave no answer. Treating it as
    // agreement would report a confirmation that never happened.
    const summary = summarizePriceChecks([
      { priceCheck: check('unverified') },
      { priceCheck: check('unverified') },
    ]);

    expect(summary.checkedAssetCount).toBe(2);
    expect(summary.disputedAssetCount).toBe(0);
    expect(summary.agreedAssetCount).toBe(0);
  });

  it('counts nothing for an unchecked portfolio', () => {
    expect(summarizePriceChecks([{ priceCheck: null }, { priceCheck: null }])).toEqual({
      checkedAssetCount: 0,
      agreedAssetCount: 0,
      disputedAssetCount: 0,
    });
  });
});

describe('largestDispute', () => {
  const disputed = (deltaPct: string): PriceCheck => ({
    status: 'disputed',
    source: 'coingecko',
    priceUsd: '1',
    deltaPct,
  });

  it('finds the widest disagreement, so a warning can say how bad it is', () => {
    expect(
      largestDispute([
        { symbol: 'AAA', priceCheck: disputed('5.0000') },
        { symbol: 'BBB', priceCheck: disputed('42.5000') },
        { symbol: 'CCC', priceCheck: disputed('12.0000') },
      ]),
    ).toEqual({ symbol: 'BBB', deltaPct: '42.5000' });
  });

  it('ignores agreements and unchecked assets', () => {
    expect(
      largestDispute([
        { symbol: 'AAA', priceCheck: { ...disputed('1.0000'), status: 'agreed' } },
        { symbol: 'BBB', priceCheck: null },
      ]),
    ).toBeNull();
  });

  it('compares deltas as decimals, not lexically', () => {
    // Sorted as text, "9" would beat "10".
    expect(
      largestDispute([
        { symbol: 'NINE', priceCheck: disputed('9.0000') },
        { symbol: 'TEN', priceCheck: disputed('10.0000') },
      ])?.symbol,
    ).toBe('TEN');
  });
});
