import { describe, expect, it } from 'vitest';

import { AAVE_MARKETS, marketsForChain, marketsWithDetail } from './aaveMarkets';

/**
 * The registry is hand-maintained data, and every entry was verified against a live
 * endpoint before it was written down. These tests cannot re-verify that — they pin
 * the invariants that a careless edit would break.
 */
describe('AAVE_MARKETS', () => {
  it('gives every market a unique id', () => {
    const ids = AAVE_MARKETS.map((market) => market.marketId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keys each id on its own chain, so a copied entry cannot hide', () => {
    for (const market of AAVE_MARKETS) {
      expect(market.marketId.startsWith(`${market.chainId}:`)).toBe(true);
    }
  });

  it('registers only USD markets, at eight decimals', () => {
    // A market whose oracle reports a different base would make every `…ValueUsd`
    // field a lie. Verified per market on 2026-08-06; pinned here so a new entry
    // cannot be added without the same check.
    for (const market of AAVE_MARKETS) {
      expect(market.baseCurrencyDecimals).toBe(8);
    }
  });

  it('records when each address was verified', () => {
    for (const market of AAVE_MARKETS) {
      expect(market.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('finds all three Ethereum markets', () => {
    // The finding that mattered in review round 12: reading only Core would report a
    // wallet borrowing on Prime or EtherFi as debt-free.
    expect(marketsForChain(1).map((market) => market.marketId)).toEqual([
      '1:core',
      '1:prime',
      '1:etherfi',
    ]);
  });

  it('returns nothing for a chain where Aave is not deployed', () => {
    expect(marketsForChain(999)).toEqual([]);
  });
});

describe('marketsWithDetail', () => {
  it('is a subset — two markets have no verified detail provider', () => {
    // Optimism and BNB: the provider addresses tried did not answer. They still
    // report totals and a health factor; they cannot report which assets those are.
    // A guessed address that decodes to nonsense would be worse than a stated gap.
    expect(marketsWithDetail(1)).toHaveLength(3);
    expect(marketsWithDetail(10)).toHaveLength(0);
    expect(marketsWithDetail(56)).toHaveLength(0);
    expect(marketsWithDetail(8453)).toHaveLength(1);
  });

  it('never returns a market without both addresses', () => {
    for (const market of AAVE_MARKETS) {
      const hasBoth =
        market.detail?.addressesProvider !== undefined &&
        market.detail?.uiPoolDataProvider !== undefined;
      expect(marketsWithDetail(market.chainId).includes(market)).toBe(hasBoth);
    }
  });
});
