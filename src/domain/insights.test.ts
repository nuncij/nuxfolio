import { describe, expect, it } from 'vitest';

import { classifyAsset, REGISTRY_SIZE } from './assetClass';
import { computeInsights, MIN_HOLDINGS_FOR_INSIGHTS } from './insights';

const WSTETH = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0';
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
const SYRUP_USDC = '0x80ac24aA929eaF5013f6436cdA2a7ba190f5Cc0b';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
/** Off the registry by construction. */
const UNKNOWN = '0x00000000000000000000000000000000DeaDBeef';

function asset(overrides: {
  symbol?: string;
  valueUsd?: string | null;
  chainId?: number;
  contractAddress?: string | null;
  suspect?: boolean;
  chainName?: string;
}) {
  return {
    symbol: 'TKN',
    valueUsd: '100',
    chainId: 1,
    contractAddress: null,
    suspect: false,
    chainName: 'Ethereum Mainnet',
    ...overrides,
  };
}

function insights(assets: Parameters<typeof computeInsights>[0]['assets']) {
  return computeInsights({ assets, networksComplete: true, includeNetworks: true });
}

describe('computeInsights — the universe it counts', () => {
  it('takes every share against the priced, non-suspect subtotal', () => {
    // A spoofed asset with a fabricated price must not appear in a statement about
    // the portfolio, having already been excluded from the total.
    const result = insights([
      asset({ symbol: 'REAL', valueUsd: '750' }),
      asset({ symbol: 'ALSO', valueUsd: '250', contractAddress: USDC }),
      asset({ symbol: 'FAKE', valueUsd: '1000000', contractAddress: UNKNOWN, suspect: true }),
      asset({ symbol: 'NOPRICE', valueUsd: null, contractAddress: UNKNOWN }),
    ]);

    expect(result?.concentration.holdingCount).toBe(2);
    // 750 of 1,000, not of 1,001,000.
    expect(result?.concentration.largest).toEqual({ symbol: 'REAL', sharePct: '75.0000' });
    expect(result?.excluded).toEqual({ unpricedCount: 1, suspectCount: 1 });
  });

  it('reports what it left out rather than only what it counted', () => {
    const result = insights([
      asset({ valueUsd: '100' }),
      asset({ valueUsd: '100', contractAddress: USDC }),
      asset({ valueUsd: null, contractAddress: UNKNOWN }),
    ]);
    expect(result?.excluded.unpricedCount).toBe(1);
  });

  it('says nothing about a portfolio too small to characterise', () => {
    expect(MIN_HOLDINGS_FOR_INSIGHTS).toBe(2);
    expect(insights([asset({ valueUsd: '100' })])).toBeNull();
    expect(insights([])).toBeNull();
  });

  it('says nothing when nothing could be priced', () => {
    expect(
      insights([asset({ valueUsd: null }), asset({ valueUsd: null, contractAddress: USDC })]),
    ).toBeNull();
  });

  it('says nothing when everything rounds to no value', () => {
    // Every share would be a division by zero or a meaningless 100%.
    expect(
      insights([asset({ valueUsd: '0' }), asset({ valueUsd: '0', contractAddress: USDC })]),
    ).toBeNull();
  });
});

describe('computeInsights — concentration', () => {
  it('finds the largest holding and its share', () => {
    const result = insights([
      asset({ symbol: 'BIG', valueUsd: '900' }),
      asset({ symbol: 'SMALL', valueUsd: '100', contractAddress: USDC }),
    ]);
    expect(result?.concentration.largest).toEqual({ symbol: 'BIG', sharePct: '90.0000' });
  });

  it('counts how few holdings reach ninety per cent', () => {
    const result = insights([
      asset({ symbol: 'A', valueUsd: '500' }),
      asset({ symbol: 'B', valueUsd: '400', contractAddress: USDC }),
      asset({ symbol: 'C', valueUsd: '50', contractAddress: WBTC }),
      asset({ symbol: 'D', valueUsd: '50', contractAddress: UNKNOWN }),
    ]);
    // 500 + 400 = 900 of 1,000.
    expect(result?.concentration.holdingsToReachNinetyPct).toBe(2);
  });

  it('gives a top-three share only when there are more than three holdings', () => {
    const three = insights([
      asset({ symbol: 'A', valueUsd: '100' }),
      asset({ symbol: 'B', valueUsd: '100', contractAddress: USDC }),
      asset({ symbol: 'C', valueUsd: '100', contractAddress: WBTC }),
    ]);
    // "The top three are 100% of three holdings" is noise, not a fact worth a line.
    expect(three?.concentration.topThreeSharePct).toBeNull();

    const four = insights([
      asset({ symbol: 'A', valueUsd: '100' }),
      asset({ symbol: 'B', valueUsd: '100', contractAddress: USDC }),
      asset({ symbol: 'C', valueUsd: '100', contractAddress: WBTC }),
      asset({ symbol: 'D', valueUsd: '100', contractAddress: UNKNOWN }),
    ]);
    expect(four?.concentration.topThreeSharePct).toBe('75.0000');
  });

  it('ranks by decimal value, not by float or by text', () => {
    const result = insights([
      asset({ symbol: 'LO', valueUsd: '9007199254740992' }),
      asset({ symbol: 'HI', valueUsd: '9007199254740993', contractAddress: USDC }),
    ]);
    expect(result?.concentration.largest?.symbol).toBe('HI');
  });
});

describe('computeInsights — what the value tracks', () => {
  it('groups by what each asset is designed to track', () => {
    // The benchmark wallet's actual shape: roughly equal thirds.
    const result = insights([
      asset({ symbol: 'WSTETH', valueUsd: '3500', contractAddress: WSTETH }),
      asset({ symbol: 'SYRUPUSDC', valueUsd: '3400', contractAddress: SYRUP_USDC }),
      asset({ symbol: 'WBTC', valueUsd: '3100', contractAddress: WBTC }),
    ]);

    expect(result?.exposure.map((slice) => [slice.tracks, slice.sharePct])).toEqual([
      ['eth', '35.0000'],
      ['usd', '34.0000'],
      ['btc', '31.0000'],
    ]);
  });

  it('names how the exposure is held, so a receipt is not called a balance', () => {
    const result = insights([
      asset({ symbol: 'SYRUPUSDC', valueUsd: '900', contractAddress: SYRUP_USDC }),
      asset({ symbol: 'USDC', valueUsd: '100', contractAddress: USDC }),
    ]);
    const usd = result?.exposure.find((slice) => slice.tracks === 'usd');
    // Both forms present: a lending receipt carries protocol risk a plain balance
    // does not, and lumping them together would hide that.
    expect(usd?.forms).toContain('lending-receipt');
    expect(usd?.forms).toContain('direct');
  });

  it('reports the unclassified share rather than hiding it', () => {
    const result = insights([
      asset({ symbol: 'KNOWN', valueUsd: '600', contractAddress: USDC }),
      asset({ symbol: 'MYSTERY', valueUsd: '400', contractAddress: UNKNOWN }),
    ]);
    const unclassified = result?.exposure.find((slice) => slice.tracks === 'unclassified');
    expect(unclassified?.sharePct).toBe('40.0000');
  });

  it('sorts slices by value, largest first', () => {
    const result = insights([
      asset({ symbol: 'SMALLUSD', valueUsd: '100', contractAddress: USDC }),
      asset({ symbol: 'BIGBTC', valueUsd: '900', contractAddress: WBTC }),
    ]);
    expect(result?.exposure[0]?.tracks).toBe('btc');
  });
});

describe('computeInsights — networks', () => {
  it('groups value by network once every network has answered', () => {
    const result = computeInsights({
      assets: [
        asset({ symbol: 'A', valueUsd: '990', chainName: 'Ethereum Mainnet' }),
        asset({ symbol: 'B', valueUsd: '10', chainId: 8453, chainName: 'Base' }),
      ],
      networksComplete: true,
      includeNetworks: true,
    });
    expect(result?.networks).toEqual([
      { chainName: 'Ethereum Mainnet', sharePct: '99.0000' },
      { chainName: 'Base', sharePct: '1.0000' },
    ]);
  });

  it('withholds the network breakdown while an aggregate is still arriving', () => {
    // The defect this prevents: Ethereum arrives first, and the panel announces
    // "100% sits on Ethereum Mainnet" while four networks are still loading.
    const result = computeInsights({
      assets: [
        asset({ symbol: 'A', valueUsd: '990' }),
        asset({ symbol: 'B', valueUsd: '10', contractAddress: USDC }),
      ],
      networksComplete: false,
      includeNetworks: true,
    });
    expect(result).not.toBeNull();
    expect(result?.networks).toBeNull();
    // Everything that is not a cross-network claim still holds.
    expect(result?.concentration.largest?.sharePct).toBe('99.0000');
  });

  it('withholds it on a single-network view, where it would say nothing', () => {
    const result = computeInsights({
      assets: [
        asset({ symbol: 'A', valueUsd: '900' }),
        asset({ symbol: 'B', valueUsd: '100', contractAddress: USDC }),
      ],
      networksComplete: true,
      includeNetworks: false,
    });
    expect(result?.networks).toBeNull();
  });
});

describe('classifyAsset', () => {
  it('classifies by address, ignoring the symbol entirely', () => {
    // The security property. An airdropped token calling itself USDC on an
    // unregistered address must not become dollar exposure.
    expect(classifyAsset({ chainId: 1, contractAddress: UNKNOWN, suspect: false }).tracks).toBe(
      'unclassified',
    );
    expect(classifyAsset({ chainId: 1, contractAddress: USDC, suspect: false }).tracks).toBe('usd');
  });

  it('never classifies a suspect asset, whatever its address', () => {
    // Belt and braces: a suspect asset is outside the total, so it must not appear
    // in an exposure figure even if its address is a real one.
    expect(classifyAsset({ chainId: 1, contractAddress: USDC, suspect: true }).tracks).toBe(
      'unclassified',
    );
  });

  it('treats the same address on another chain as a different contract', () => {
    // The same bytes are unrelated contracts across EVM chains, so a global
    // address map would confidently mis-classify.
    expect(classifyAsset({ chainId: 1, contractAddress: USDC, suspect: false }).tracks).toBe('usd');
    expect(classifyAsset({ chainId: 42161, contractAddress: USDC, suspect: false }).tracks).toBe(
      'unclassified',
    );
  });

  it('matches an address whatever its casing', () => {
    // Addresses reach here checksummed, lowercased from a provider, or upper-cased
    // by a paste. All three are the same contract, and a casing mismatch silently
    // downgrading a known asset to unclassified would be a coverage bug.
    for (const form of [USDC, USDC.toLowerCase(), USDC.toUpperCase()]) {
      expect(
        classifyAsset({ chainId: 1, contractAddress: form, suspect: false }).tracks,
        `casing: ${form}`,
      ).toBe('usd');
    }
  });

  it('classifies each chain’s native asset', () => {
    expect(classifyAsset({ chainId: 1, contractAddress: null, suspect: false }).tracks).toBe('eth');
    expect(classifyAsset({ chainId: 8453, contractAddress: null, suspect: false }).tracks).toBe(
      'eth',
    );
    // BNB follows none of the three, and saying so beats forcing it into a bucket.
    expect(classifyAsset({ chainId: 56, contractAddress: null, suspect: false }).tracks).toBe(
      'unclassified',
    );
  });

  it('carries a note on every entry, so an addition is a decision not a guess', () => {
    expect(REGISTRY_SIZE).toBeGreaterThan(10);
    expect(
      classifyAsset({ chainId: 1, contractAddress: SYRUP_USDC, suspect: false }).note,
    ).toContain('Maple');
  });
});
