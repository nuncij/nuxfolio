import { describe, expect, it } from 'vitest';

import { groupAssetsForDisplay, SMALL_BALANCE_THRESHOLD_USD } from './assetGroups';

function row(symbol: string, valueUsd: string | null, suspect = false) {
  return { symbol, valueUsd, suspect };
}

describe('groupAssetsForDisplay', () => {
  it('keeps a balance of exactly the threshold in the main table', () => {
    const groups = groupAssetsForDisplay([row('ONE', SMALL_BALANCE_THRESHOLD_USD)]);

    expect(groups.primary.map((asset) => asset.symbol)).toEqual(['ONE']);
    expect(groups.dust).toHaveLength(0);
    expect(groups.dustValueUsd).toBeNull();
  });

  it('folds a balance one cent below the threshold', () => {
    const groups = groupAssetsForDisplay([row('DUST', '0.99')]);

    expect(groups.primary).toHaveLength(0);
    expect(groups.dust.map((asset) => asset.symbol)).toEqual(['DUST']);
  });

  it('compares as decimals rather than through floats', () => {
    // Number('0.1') + Number('0.2') is the classic float trap; the sum here is
    // exact and the comparison never converts.
    const groups = groupAssetsForDisplay([row('A', '0.1'), row('B', '0.2')]);
    expect(groups.dustValueUsd).toBe('0.30000000');
  });

  it('sums the folded rows so the expander can account for them', () => {
    const groups = groupAssetsForDisplay([row('BIG', '1000'), row('A', '0.50'), row('B', '0.25')]);

    expect(groups.primary.map((asset) => asset.symbol)).toEqual(['BIG']);
    expect(groups.dust.map((asset) => asset.symbol)).toEqual(['A', 'B']);
    expect(groups.dustValueUsd).toBe('0.75000000');
  });

  it('leaves an unpriced asset in the main table', () => {
    // It carries its own flags and cannot distort the total, so hiding it would
    // remove exactly the row that needs looking at.
    const groups = groupAssetsForDisplay([row('NOPRICE', null)]);

    expect(groups.primary.map((asset) => asset.symbol)).toEqual(['NOPRICE']);
    expect(groups.dust).toHaveLength(0);
  });

  it('handles an all-dust portfolio', () => {
    const groups = groupAssetsForDisplay([row('A', '0.10'), row('B', '0.20')]);

    expect(groups.primary).toHaveLength(0);
    expect(groups.dust).toHaveLength(2);
    expect(groups.dustValueUsd).toBe('0.30000000');
  });

  it('handles an empty dust set', () => {
    const groups = groupAssetsForDisplay([row('A', '10'), row('B', '20')]);

    expect(groups.dust).toHaveLength(0);
    expect(groups.dustValueUsd).toBeNull();
  });

  it('handles no assets at all', () => {
    const groups = groupAssetsForDisplay([]);

    expect(groups).toMatchObject({
      primary: [],
      dust: [],
      suspect: [],
      dustValueUsd: null,
      suspectValueUsd: null,
    });
  });

  it('separates suspect assets before size is considered', () => {
    const groups = groupAssetsForDisplay([
      row('FAKE', '5000', true),
      row('TINY', '0.01', true),
      row('REAL', '100'),
    ]);

    expect(groups.suspect.map((asset) => asset.symbol)).toEqual(['FAKE', 'TINY']);
    expect(groups.primary.map((asset) => asset.symbol)).toEqual(['REAL']);
    expect(groups.dust).toHaveLength(0);
    expect(groups.suspectValueUsd).toBe('5000.01000000');
  });

  it('reports no suspect value when the flagged assets have no price', () => {
    const groups = groupAssetsForDisplay([row('FAKE', null, true)]);

    expect(groups.suspect).toHaveLength(1);
    expect(groups.suspectValueUsd).toBeNull();
  });

  it('preserves input order inside each group, so the caller sort survives', () => {
    const groups = groupAssetsForDisplay([
      row('C', '30'),
      row('D', '0.30'),
      row('A', '10'),
      row('B', '0.10'),
    ]);

    expect(groups.primary.map((asset) => asset.symbol)).toEqual(['C', 'A']);
    expect(groups.dust.map((asset) => asset.symbol)).toEqual(['D', 'B']);
  });
});
