import { describe, expect, it } from 'vitest';

import {
  failedProtocolAccount,
  hasPosition,
  summarizeAccounts,
  toHealthFactor,
  toProtocolAccount,
  type ProtocolAccount,
} from './protocolAccount';

const MARKET = { chainId: 1, marketId: '1:core', marketName: 'Aave v3 Core' };
const READ = { ...MARKET, positionsStatus: 'ok', rewardsStatus: 'ok' } as const;

/** `uint256` max — what Aave returns as the health factor when there is no debt. */
const NO_DEBT = (2n ** 256n - 1n).toString();

function account(overrides: Partial<ProtocolAccount> = {}): ProtocolAccount {
  return {
    chainId: 1,
    protocol: 'aave-v3',
    marketId: '1:core',
    marketName: 'Aave v3 Core',
    status: 'ok',
    collateralValueUsd: '0',
    borrowedValueUsd: '0',
    healthFactor: null,
    positions: [],
    positionsStatus: 'ok',
    rewards: [],
    rewardsStatus: 'ok',
    ...overrides,
  };
}

describe('toProtocolAccount', () => {
  it('scales the base figures by 8 decimals, as Aave reports them', () => {
    const result = toProtocolAccount({
      ...READ,
      // $100,000.00 collateral, $40,000.00 debt, in USD at 1e8.
      raw: {
        totalCollateralBase: '10000000000000',
        totalDebtBase: '4000000000000',
        healthFactor: '1040000000000000000',
      },
    });

    expect(result.collateralValueUsd).toBe('100000');
    expect(result.borrowedValueUsd).toBe('40000');
    expect(result.status).toBe('ok');
  });

  it('scales the health factor by 18 decimals, not 27', () => {
    // The plan said ray (1e27) and review round 12 caught it: at 1e27 a real 1.04
    // renders as 0.00000000104. This is the test that pins the error.
    const result = toProtocolAccount({
      ...READ,
      raw: {
        totalCollateralBase: '1',
        totalDebtBase: '1',
        healthFactor: '1040000000000000000',
      },
    });

    expect(result.healthFactor).toBe('1.04');
  });

  it('keeps full precision on a figure that would lose digits as a float', () => {
    const result = toProtocolAccount({
      ...READ,
      raw: {
        totalCollateralBase: '123456789012345678',
        totalDebtBase: '0',
        healthFactor: NO_DEBT,
      },
    });

    // 1234567890.12345678 — the last digits survive only because this never
    // passes through Number (ADR-003).
    expect(result.collateralValueUsd).toBe('1234567890.12345678');
  });
});

describe('toHealthFactor', () => {
  it('reports no debt as null rather than a number', () => {
    // Divided naively this is 1.157e+59, which would render as a health factor.
    expect(toHealthFactor(NO_DEBT)).toBeNull();
  });

  it('matches the sentinel exactly rather than by magnitude', () => {
    // One less than uint256 max is not the sentinel. A "very large means none"
    // threshold would silently reclassify a real value; this is a different claim.
    const almost = (2n ** 256n - 2n).toString();

    expect(toHealthFactor(almost)).not.toBeNull();
  });

  it('reads a value close to liquidation without rounding it away', () => {
    expect(toHealthFactor('1004999999999999999')).toBe('1.004999999999999999');
  });

  it('reads a value below 1, which is the eligible-for-liquidation case', () => {
    expect(toHealthFactor('980000000000000000')).toBe('0.98');
  });
});

describe('failedProtocolAccount', () => {
  it('reports absence, never zero', () => {
    // The distinction the whole type exists for: a read that did not answer says
    // nothing about the wallet, and must not render as "no debt".
    const result = failedProtocolAccount({
      ...MARKET,
      positionsStatus: 'failed',
      rewardsStatus: 'failed',
    });

    expect(result.status).toBe('failed');
    expect(result.borrowedValueUsd).toBeNull();
    expect(result.collateralValueUsd).toBeNull();
    expect(result.healthFactor).toBeNull();
  });
});

describe('hasPosition', () => {
  it('is false for a market the wallet has never used', () => {
    expect(hasPosition(account())).toBe(false);
  });

  it('is true for collateral without debt', () => {
    expect(hasPosition(account({ collateralValueUsd: '5000' }))).toBe(true);
  });

  it('is true for a supply the totals cannot see', () => {
    // Collateral off contributes to neither figure, so the breakdown is the only
    // evidence this wallet uses the market at all.
    const position = {
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      symbol: 'WETH',
      supplied: '9.08',
      borrowed: '0',
      usedAsCollateral: false,
      aTokenAddress: '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8',
      suppliedValueUsd: '17528.01',
      borrowedValueUsd: '0',
    };

    expect(hasPosition(account({ positions: [position] }))).toBe(true);
  });

  it('is true for a failed read, because that is not "no position"', () => {
    expect(
      hasPosition(
        failedProtocolAccount({ ...MARKET, positionsStatus: 'failed', rewardsStatus: 'failed' }),
      ),
    ).toBe(true);
  });
});

describe('summarizeAccounts', () => {
  it('sums debt across markets and counts what it checked', () => {
    const summary = summarizeAccounts([
      account({ marketId: '1:core', borrowedValueUsd: '40000', collateralValueUsd: '100000' }),
      account({ marketId: '1:prime', borrowedValueUsd: '2500.50', collateralValueUsd: '9000' }),
    ]);

    expect(summary.borrowedValueUsd).toBe('42500.5');
    expect(summary.collateralValueUsd).toBe('109000');
    expect(summary.marketsChecked).toBe(2);
    expect(summary.marketsFailed).toBe(0);
  });

  it('counts a failed market rather than quietly shrinking the total', () => {
    // `sumPortfolioTotals` drops nulls before summing, which here would turn a
    // failed read into a smaller complete-looking debt figure (round 12, F-06).
    const summary = summarizeAccounts([
      account({ borrowedValueUsd: '40000' }),
      failedProtocolAccount({
        ...MARKET,
        marketId: '1:prime',
        positionsStatus: 'failed',
        rewardsStatus: 'failed',
      }),
    ]);

    expect(summary.borrowedValueUsd).toBe('40000');
    expect(summary.marketsChecked).toBe(1);
    expect(summary.marketsFailed).toBe(1);
  });

  it('returns null debt when every market failed, not zero', () => {
    const summary = summarizeAccounts([
      failedProtocolAccount({ ...MARKET, positionsStatus: 'failed', rewardsStatus: 'failed' }),
      failedProtocolAccount({
        ...MARKET,
        marketId: '1:prime',
        positionsStatus: 'failed',
        rewardsStatus: 'failed',
      }),
    ]);

    expect(summary.borrowedValueUsd).toBeNull();
    expect(summary.marketsChecked).toBe(0);
    expect(summary.marketsFailed).toBe(2);
  });

  it('takes the lowest health factor, because they do not add up', () => {
    // Averaging or summing health factors is meaningless; the number that matters
    // is the market closest to liquidation.
    const summary = summarizeAccounts([
      account({ healthFactor: '2.5' }),
      account({ marketId: '1:prime', healthFactor: '1.04' }),
      account({ marketId: '1:etherfi', healthFactor: '8.9' }),
    ]);

    expect(summary.lowestHealthFactor).toBe('1.04');
  });

  it('ignores markets with no debt when picking the lowest', () => {
    const summary = summarizeAccounts([
      account({ healthFactor: null, collateralValueUsd: '5000' }),
      account({ marketId: '1:prime', healthFactor: '1.2' }),
    ]);

    expect(summary.lowestHealthFactor).toBe('1.2');
  });

  it('compares health factors numerically, not as strings', () => {
    // '10' < '9' lexicographically. A string comparison would report the safest
    // market as the most at risk.
    const summary = summarizeAccounts([
      account({ healthFactor: '10' }),
      account({ marketId: '1:prime', healthFactor: '9' }),
    ]);

    expect(summary.lowestHealthFactor).toBe('9');
  });

  it('has no health factor when nothing is borrowed anywhere', () => {
    expect(summarizeAccounts([account(), account()]).lowestHealthFactor).toBeNull();
  });
});
