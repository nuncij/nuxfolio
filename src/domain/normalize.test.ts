import { describe, expect, it } from 'vitest';

import type { PriceQuote, RawBalance } from '@/providers/types';
import { priceRefKey } from '@/providers/types';
import { TEST_ADDRESS, USDC, WETH } from '@/test/helpers';

import type { WalletAddress } from './address';
import {
  assessPriceQuality,
  buildPortfolio,
  sortAssets,
  summarizePortfolio,
  type BuildPortfolioInput,
} from './normalize';
import { portfolioSchema } from './portfolio';

const FETCHED_AT = '2026-07-30T12:00:00.000Z';

const nativeBalance: RawBalance = {
  chainId: 1,
  contractAddress: null,
  name: 'Ether',
  symbol: 'ETH',
  decimals: 18,
  raw: 2_000_000_000_000_000_000n, // 2 ETH
  logoUrl: null,
};

const usdcBalance: RawBalance = {
  chainId: 1,
  contractAddress: USDC,
  name: 'USD Coin',
  symbol: 'USDC',
  decimals: 6,
  raw: 1_500_000_000n, // 1500 USDC
  logoUrl: null,
};

const wethBalance: RawBalance = {
  chainId: 1,
  contractAddress: WETH,
  name: 'Wrapped Ether',
  symbol: 'WETH',
  decimals: 18,
  raw: 500_000_000_000_000_000n, // 0.5 WETH
  logoUrl: null,
};

function quote(priceUsd: string, overrides: Partial<PriceQuote> = {}): PriceQuote {
  return { priceUsd, updatedAt: FETCHED_AT, confidence: 0.99, ...overrides };
}

function buildInput(overrides: Partial<BuildPortfolioInput> = {}): BuildPortfolioInput {
  return {
    address: TEST_ADDRESS,
    chain: { chainId: 1, name: 'Ethereum Mainnet', nativeSymbol: 'ETH' },
    balances: [nativeBalance, usdcBalance],
    listedTokens: [
      { address: USDC, symbol: 'USDC' },
      { address: WETH, symbol: 'WETH' },
    ],
    quotes: new Map([
      [priceRefKey({ chainId: 1, contractAddress: null }), quote('2000')],
      [priceRefKey({ chainId: 1, contractAddress: USDC }), quote('1')],
    ]),
    coverage: 'token-list',
    balanceSource: 'rpc-token-list',
    priceSource: 'defillama',
    warnings: [],
    fetchedAt: FETCHED_AT,
    priceConfidenceMin: 0.7,
    priceMaxAgeSeconds: 3600,
    maxAssets: 400,
    ...overrides,
  };
}

describe('buildPortfolio', () => {
  it('multiplies quantity by price for each asset', () => {
    const portfolio = buildPortfolio(buildInput());

    const eth = portfolio.assets.find((asset) => asset.symbol === 'ETH');
    const usdc = portfolio.assets.find((asset) => asset.symbol === 'USDC');

    expect(eth?.quantity).toBe('2');
    expect(eth?.valueUsd).toBe('4000.00000000');
    expect(usdc?.quantity).toBe('1500');
    expect(usdc?.valueUsd).toBe('1500.00000000');
    expect(portfolio.totalValueUsd).toBe('5500.00000000');
  });

  it('carries the exact base-unit quantity alongside the human one', () => {
    const portfolio = buildPortfolio(buildInput());
    const eth = portfolio.assets.find((asset) => asset.symbol === 'ETH');
    expect(eth?.rawQuantity).toBe('2000000000000000000');
  });

  it('computes shares of the priced subtotal that add up to 100', () => {
    const portfolio = buildPortfolio(buildInput());
    const total = portfolio.assets.reduce(
      (sum, asset) => sum + Number(asset.portfolioSharePct ?? 0),
      0,
    );
    expect(total).toBeCloseTo(100, 3);
    expect(portfolio.assets.find((a) => a.symbol === 'ETH')?.portfolioSharePct).toBe('72.7273');
  });

  it('assigns a stable asset id per chain and contract', () => {
    const portfolio = buildPortfolio(buildInput());
    expect(portfolio.assets.map((asset) => asset.assetId)).toEqual(
      expect.arrayContaining(['1:native', `1:${USDC}`]),
    );
  });

  it('drops zero balances, which providers may still report', () => {
    const portfolio = buildPortfolio(
      buildInput({ balances: [nativeBalance, { ...usdcBalance, raw: 0n }] }),
    );
    expect(portfolio.assets).toHaveLength(1);
    expect(portfolio.assetCount).toBe(1);
  });

  it('sorts by value descending by default', () => {
    const portfolio = buildPortfolio(buildInput());
    expect(portfolio.assets.map((asset) => asset.symbol)).toEqual(['ETH', 'USDC']);
  });

  it('preserves provider warnings and appends its own', () => {
    const portfolio = buildPortfolio(
      buildInput({ warnings: [{ code: 'coverage.token-list', message: 'Partial coverage.' }] }),
    );
    expect(portfolio.warnings.map((warning) => warning.code)).toContain('coverage.token-list');
  });

  it('deduplicates warnings by code, keeping the first message', () => {
    // The UI keys warnings by code, so a duplicate would collide.
    const portfolio = buildPortfolio(
      buildInput({
        warnings: [
          { code: 'prices.partial', message: 'From the provider.' },
          { code: 'prices.partial', message: 'Raised again elsewhere.' },
        ],
      }),
    );

    const partial = portfolio.warnings.filter((w) => w.code === 'prices.partial');
    expect(partial).toHaveLength(1);
    expect(partial[0]?.message).toBe('From the provider.');
  });

  describe('missing prices', () => {
    it('keeps the asset, nulls its value and share, and excludes it from the total', () => {
      const portfolio = buildPortfolio(
        buildInput({
          balances: [nativeBalance, usdcBalance, wethBalance],
        }),
      );

      const weth = portfolio.assets.find((asset) => asset.symbol === 'WETH');
      expect(weth).toBeDefined();
      expect(weth?.quantity).toBe('0.5');
      expect(weth?.priceUsd).toBeNull();
      expect(weth?.valueUsd).toBeNull();
      expect(weth?.portfolioSharePct).toBeNull();
      expect(weth?.priceSource).toBeNull();

      // The total is unchanged by the unpriced asset.
      expect(portfolio.totalValueUsd).toBe('5500.00000000');
      expect(portfolio.pricedAssetCount).toBe(2);
      expect(portfolio.unpricedAssetCount).toBe(1);
    });

    it('warns about unpriced assets in the singular and the plural', () => {
      const one = buildPortfolio(
        buildInput({ balances: [nativeBalance, usdcBalance, wethBalance] }),
      );
      expect(one.warnings.find((w) => w.code === 'prices.missing')?.message).toContain('1 asset ');

      const two = buildPortfolio(
        buildInput({
          balances: [nativeBalance, usdcBalance, wethBalance],
          quotes: new Map([[priceRefKey({ chainId: 1, contractAddress: null }), quote('2000')]]),
        }),
      );
      expect(two.warnings.find((w) => w.code === 'prices.missing')?.message).toContain('2 assets');
    });

    it('reports a null total, never zero, when nothing could be priced', () => {
      const portfolio = buildPortfolio(buildInput({ quotes: new Map() }));

      expect(portfolio.totalValueUsd).toBeNull();
      expect(portfolio.assetCount).toBe(2);
      expect(portfolio.pricedAssetCount).toBe(0);
      expect(portfolio.assets.every((asset) => asset.portfolioSharePct === null)).toBe(true);
    });

    it('sorts unpriced assets last so they stay visible instead of vanishing', () => {
      const portfolio = buildPortfolio(
        buildInput({
          balances: [wethBalance, nativeBalance, usdcBalance],
        }),
      );
      expect(portfolio.assets.map((asset) => asset.symbol)).toEqual(['ETH', 'USDC', 'WETH']);
    });
  });

  describe('price quality', () => {
    it('flags a low-confidence quote and warns about it', () => {
      const portfolio = buildPortfolio(
        buildInput({
          quotes: new Map([
            [
              priceRefKey({ chainId: 1, contractAddress: null }),
              quote('2000', { confidence: 0.2 }),
            ],
            [priceRefKey({ chainId: 1, contractAddress: USDC }), quote('1')],
          ]),
        }),
      );

      const eth = portfolio.assets.find((asset) => asset.symbol === 'ETH');
      expect(eth?.priceQuality).toBe('low-confidence');
      // The value is still counted: dropping it would make the subtotal wrong
      // without telling anyone.
      expect(eth?.valueUsd).toBe('4000.00000000');
      expect(portfolio.warnings.map((w) => w.code)).toContain('prices.low_confidence');
    });

    it('flags a stale quote and warns about it', () => {
      const portfolio = buildPortfolio(
        buildInput({
          quotes: new Map([
            [
              priceRefKey({ chainId: 1, contractAddress: null }),
              quote('2000', { updatedAt: '2026-07-29T00:00:00.000Z' }),
            ],
          ]),
          balances: [nativeBalance],
        }),
      );

      expect(portfolio.assets[0]?.priceQuality).toBe('stale');
      expect(portfolio.warnings.map((w) => w.code)).toContain('prices.stale');
    });

    it('flags a quote with no timestamp as unknown-age rather than treating it as fresh', () => {
      // A provider's silence about age is not a statement that the price is
      // current, so it must not render like one.
      const portfolio = buildPortfolio(
        buildInput({
          balances: [nativeBalance],
          quotes: new Map([
            [
              priceRefKey({ chainId: 1, contractAddress: null }),
              quote('2000', { updatedAt: null }),
            ],
          ]),
        }),
      );

      expect(portfolio.assets[0]?.priceQuality).toBe('unknown-age');
      expect(portfolio.assets[0]?.priceUpdatedAt).toBeNull();
      expect(portfolio.warnings.map((w) => w.code)).toContain('prices.unknown_age');
      // The value still counts: the price is usable, just not verifiably fresh.
      expect(portfolio.totalValueUsd).toBe('4000.00000000');
    });
  });

  describe('truncation', () => {
    it('keeps the largest holdings, marks coverage truncated and says how many were dropped', () => {
      const many: RawBalance[] = Array.from({ length: 5 }, (_, index) => ({
        ...usdcBalance,
        contractAddress: `0x${String(index).repeat(40)}` as RawBalance['contractAddress'],
        symbol: `T${index}`,
        name: `Token ${index}`,
        raw: BigInt((index + 1) * 1_000_000),
      }));

      const quotes = new Map(
        many.map((balance) => [
          priceRefKey({ chainId: 1, contractAddress: balance.contractAddress }),
          quote('1'),
        ]),
      );

      const portfolio = buildPortfolio(buildInput({ balances: many, quotes, maxAssets: 2 }));

      expect(portfolio.assets.map((asset) => asset.symbol)).toEqual(['T4', 'T3']);
      expect(portfolio.coverage).toBe('truncated');
      expect(portfolio.warnings.find((w) => w.code === 'assets.truncated')?.message).toContain(
        '3 smaller ones were omitted',
      );
    });

    it('leaves coverage untouched when nothing was dropped', () => {
      const portfolio = buildPortfolio(buildInput({ coverage: 'complete' }));
      expect(portfolio.coverage).toBe('complete');
    });
  });

  describe('suspect assets', () => {
    const FAKE_ADDRESS: WalletAddress = '0x1111111111111111111111111111111111111111';
    const BAIT_ADDRESS: WalletAddress = '0x2222222222222222222222222222222222222222';

    const FAKE_USDC: RawBalance = {
      chainId: 1,
      contractAddress: FAKE_ADDRESS,
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6,
      raw: 1_000_000_000_000n, // 1,000,000 fake USDC
      logoUrl: null,
    };

    const BAIT: RawBalance = {
      chainId: 1,
      contractAddress: BAIT_ADDRESS,
      name: 'Claim your reward at free-eth.com',
      symbol: 'VISIT',
      decimals: 18,
      raw: 1_000_000_000_000_000_000n,
      logoUrl: null,
    };

    function withSpam(
      extra: readonly RawBalance[],
      prices: readonly [WalletAddress, string][] = [],
    ) {
      return buildInput({
        balances: [nativeBalance, usdcBalance, ...extra],
        quotes: new Map([
          [priceRefKey({ chainId: 1, contractAddress: null }), quote('2000')],
          [priceRefKey({ chainId: 1, contractAddress: USDC }), quote('1')],
          ...prices.map(
            ([address, price]) =>
              [priceRefKey({ chainId: 1, contractAddress: address }), quote(price)] as const,
          ),
        ]),
      });
    }

    it('flags an off-list contract that copies a listed symbol', () => {
      const portfolio = buildPortfolio(withSpam([FAKE_USDC]));
      const fake = portfolio.assets.find((asset) => asset.assetId.endsWith('1111'));

      expect(fake).toMatchObject({ suspect: true, suspectReason: 'symbol-spoof' });
      expect(portfolio.suspectAssetCount).toBe(1);
    });

    it('keeps a priced fake out of the total and out of every share', () => {
      // The only way this product could overstate a portfolio: a scam token
      // carrying a price. $1,000,000 of it must not reach the headline figure.
      const portfolio = buildPortfolio(withSpam([FAKE_USDC], [[FAKE_ADDRESS, '1']]));

      expect(portfolio.totalValueUsd).toBe('5500.00000000');
      expect(portfolio.suspectValueUsd).toBe('1000000.00000000');

      const fake = portfolio.assets.find((asset) => asset.suspect);
      expect(fake?.valueUsd).toBe('1000000.00000000');
      expect(fake?.portfolioSharePct).toBeNull();

      // Shares of the real holdings are of the suspect-free subtotal.
      expect(portfolio.assets.find((a) => a.symbol === 'ETH')?.portfolioSharePct).toBe('72.7273');
    });

    it('sums the excluded value across several flagged assets', () => {
      const portfolio = buildPortfolio(
        withSpam(
          [FAKE_USDC, BAIT],
          [
            [FAKE_ADDRESS, '1'],
            [BAIT_ADDRESS, '0.5'],
          ],
        ),
      );

      expect(portfolio.suspectAssetCount).toBe(2);
      expect(portfolio.suspectValueUsd).toBe('1000000.50000000');
      expect(portfolio.totalValueUsd).toBe('5500.00000000');
    });

    it('reports no excluded value when the flagged assets have no price', () => {
      const portfolio = buildPortfolio(withSpam([FAKE_USDC]));

      expect(portfolio.suspectAssetCount).toBe(1);
      expect(portfolio.suspectValueUsd).toBeNull();
    });

    it('flags claim-bait naming', () => {
      const portfolio = buildPortfolio(withSpam([BAIT]));
      expect(portfolio.assets.find((asset) => asset.symbol === 'VISIT')).toMatchObject({
        suspect: true,
        suspectReason: 'bait-name',
      });
    });

    it('warns with a reason summary, in the singular and the plural', () => {
      const one = buildPortfolio(withSpam([FAKE_USDC]));
      expect(one.warnings.find((w) => w.code === 'assets.suspect')?.message).toBe(
        '1 asset looks like spam (with a copied symbol) and is excluded from the total. ' +
          'Review it below.',
      );

      const two = buildPortfolio(withSpam([FAKE_USDC, BAIT]));
      expect(two.warnings.find((w) => w.code === 'assets.suspect')?.message).toBe(
        '2 assets look like spam (1 with a copied symbol, 1 with claim-bait naming) and are ' +
          'excluded from the total. Review them below.',
      );
    });

    it('raises no warning and no counts when nothing is suspect', () => {
      const portfolio = buildPortfolio(buildInput());

      expect(portfolio.suspectAssetCount).toBe(0);
      expect(portfolio.suspectValueUsd).toBeNull();
      expect(portfolio.warnings.map((w) => w.code)).not.toContain('assets.suspect');
      expect(portfolio.assets.every((asset) => !asset.suspect)).toBe(true);
    });

    it('never flags the native asset', () => {
      const portfolio = buildPortfolio(
        buildInput({
          balances: [{ ...nativeBalance, name: 'Claim your airdrop at eth.com' }],
        }),
      );

      expect(portfolio.assets[0]?.suspect).toBe(false);
      expect(portfolio.totalValueUsd).toBe('4000.00000000');
    });

    it('never flags a listed token, however it is named', () => {
      // The keyless provider only ever reports listed tokens, so its assets are
      // suspicion-free by construction — and real listed tokens are called
      // "ether.fi Staked ETH" and "Venus Reward".
      const portfolio = buildPortfolio(
        buildInput({
          balances: [
            { ...usdcBalance, name: 'Venus Reward' },
            { ...wethBalance, name: 'ether.fi Staked ETH' },
          ],
        }),
      );

      expect(portfolio.assets.every((asset) => !asset.suspect)).toBe(true);
      expect(portfolio.suspectAssetCount).toBe(0);
    });

    it('excludes flagged assets from the largest position', () => {
      const summary = summarizePortfolio(
        buildPortfolio(withSpam([FAKE_USDC], [[FAKE_ADDRESS, '1']])),
      );

      expect(summary.largestAsset?.symbol).toBe('ETH');
      expect(summary.suspectAssetCount).toBe(1);
      expect(summary.suspectValueUsd).toBe('1000000.00000000');
    });

    it('excludes flagged assets from the cross-checkable count', () => {
      // The denominator the summary quotes for the price cross-check. A spoofed
      // asset is priced but outside the total, so a second opinion on it would buy
      // nothing; counting it would understate the coverage of a check that had in
      // fact covered everything that matters.
      const summary = summarizePortfolio(
        buildPortfolio(withSpam([FAKE_USDC], [[FAKE_ADDRESS, '1']])),
      );

      expect(summary.pricedAssetCount).toBe(3);
      expect(summary.countedPricedAssetCount).toBe(2);
    });

    it('produces a payload that survives the wire schema', () => {
      const portfolio = buildPortfolio(withSpam([FAKE_USDC], [[FAKE_ADDRESS, '1']]));
      expect(portfolioSchema.parse(portfolio)).toEqual(portfolio);
    });
  });
});

describe('assessPriceQuality', () => {
  const now = Date.parse('2026-07-30T12:00:00.000Z');

  it('rates a fresh, confident quote as ok', () => {
    expect(assessPriceQuality(quote('1'), { now, confidenceMin: 0.7, maxAgeSeconds: 3600 })).toBe(
      'ok',
    );
  });

  it('rates low confidence ahead of staleness, since it is the stronger caveat', () => {
    expect(
      assessPriceQuality(quote('1', { confidence: 0.1, updatedAt: '2020-01-01T00:00:00.000Z' }), {
        now,
        confidenceMin: 0.7,
        maxAgeSeconds: 3600,
      }),
    ).toBe('low-confidence');
  });

  it('treats a missing confidence score as acceptable rather than suspect', () => {
    expect(
      assessPriceQuality(quote('1', { confidence: null }), {
        now,
        confidenceMin: 0.7,
        maxAgeSeconds: 3600,
      }),
    ).toBe('ok');
  });

  it('treats an unparseable timestamp as unknown age, not as fresh', () => {
    expect(
      assessPriceQuality(quote('1', { updatedAt: 'not-a-date' }), {
        now,
        confidenceMin: 0.7,
        maxAgeSeconds: 3600,
      }),
    ).toBe('unknown-age');
  });
});

describe('sortAssets', () => {
  const assets = [
    { symbol: 'AAA', name: 'Alpha', valueUsd: '10' },
    { symbol: 'CCC', name: 'Gamma', valueUsd: '30' },
    { symbol: 'BBB', name: 'Beta', valueUsd: null },
  ];

  it('sorts by value descending', () => {
    expect(sortAssets(assets, 'value', 'desc').map((a) => a.symbol)).toEqual(['CCC', 'AAA', 'BBB']);
  });

  it('sorts by value ascending but still keeps unpriced assets last', () => {
    expect(sortAssets(assets, 'value', 'asc').map((a) => a.symbol)).toEqual(['AAA', 'CCC', 'BBB']);
  });

  it('sorts by name ascending', () => {
    expect(sortAssets(assets, 'name', 'asc').map((a) => a.name)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
  });

  it('sorts by name descending', () => {
    expect(sortAssets(assets, 'name', 'desc').map((a) => a.name)).toEqual([
      'Gamma',
      'Beta',
      'Alpha',
    ]);
  });

  it('breaks value ties by symbol so ordering is deterministic', () => {
    const tied = [
      { symbol: 'ZZZ', name: 'Zeta', valueUsd: '5' },
      { symbol: 'AAA', name: 'Alpha', valueUsd: '5' },
    ];
    expect(sortAssets(tied, 'value', 'desc').map((a) => a.symbol)).toEqual(['AAA', 'ZZZ']);
  });

  it('does not mutate its input', () => {
    const input = [...assets];
    sortAssets(input, 'value', 'desc');
    expect(input.map((a) => a.symbol)).toEqual(['AAA', 'CCC', 'BBB']);
  });

  it('compares large values as decimals, not as floats', () => {
    const huge = [
      { symbol: 'LOW', name: 'Low', valueUsd: '9007199254740992' },
      { symbol: 'HIGH', name: 'High', valueUsd: '9007199254740993' },
    ];
    expect(sortAssets(huge, 'value', 'desc').map((a) => a.symbol)).toEqual(['HIGH', 'LOW']);
  });
});

describe('summarizePortfolio', () => {
  it('reports the largest position with its share', () => {
    const summary = summarizePortfolio(buildPortfolio(buildInput()));
    expect(summary.largestAsset).toMatchObject({ symbol: 'ETH', valueUsd: '4000.00000000' });
    expect(summary.largestAsset?.sharePct).toBe('72.7273');
  });

  it('reports no largest position when nothing could be priced', () => {
    const summary = summarizePortfolio(buildPortfolio(buildInput({ quotes: new Map() })));
    expect(summary.largestAsset).toBeNull();
    expect(summary.totalValueUsd).toBeNull();
  });

  it('counts assets whose price carries a caveat', () => {
    const summary = summarizePortfolio(
      buildPortfolio(
        buildInput({
          quotes: new Map([
            [
              priceRefKey({ chainId: 1, contractAddress: null }),
              quote('2000', { confidence: 0.1 }),
            ],
            [priceRefKey({ chainId: 1, contractAddress: USDC }), quote('1')],
          ]),
        }),
      ),
    );
    expect(summary.flaggedPriceCount).toBe(1);
  });

  it('counts nothing as cross-checkable when nothing has a price', () => {
    const summary = summarizePortfolio(buildPortfolio(buildInput({ quotes: new Map() })));
    expect(summary.countedPricedAssetCount).toBe(0);
  });
});
