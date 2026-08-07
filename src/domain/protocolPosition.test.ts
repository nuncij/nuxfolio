import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import { RAY, rayMulDebt, rayMulSupply } from './rayMath';

import { isOpen, toProtocolPosition, type RawPosition } from './protocolPosition';

/**
 * The borrower `0xF635aaEE…7054` on Aave v3 Core, captured whole at Ethereum block
 * 25703367 — every figure below comes from a single `aggregate3`, so the totals and the
 * per-reserve parts describe the same instant. That matters: read across two blocks the
 * debt accrues between them and the reconciliation below drifts by a few base units,
 * which is how the first version of this measurement nearly concluded the wrong thing.
 */
const BLOCK = {
  reserves: [
    {
      asset: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      symbol: 'WETH',
      decimals: 18,
      scaledSupply: 8_496_366_850_973_757_592n,
      scaledDebt: 0n,
      income: 1_069_082_747_211_127_648_702_419_695n,
      debtIndex: 1_104_334_524_298_255_935_047_226_681n,
      price: 192_969_208_343n,
      collateral: true,
    },
    {
      asset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      decimals: 6,
      scaledSupply: 0n,
      scaledDebt: 540_434_395n,
      income: 1_181_136_107_173_964_482_978_286_741n,
      debtIndex: 1_243_162_740_365_591_651_132_069_410n,
      price: 99_982_000n,
      collateral: false,
    },
    {
      asset: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      symbol: 'USDT',
      decimals: 6,
      scaledSupply: 0n,
      scaledDebt: 2_644_193_989n,
      income: 1_171_317_854_126_816_627_178_927_790n,
      debtIndex: 1_238_926_827_659_346_756_598_509_142n,
      price: 99_906_836n,
      collateral: false,
    },
    {
      asset: '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3',
      symbol: 'USDe',
      decimals: 18,
      scaledSupply: 0n,
      scaledDebt: 3_620_326_576_167_421_215_544n,
      income: 1_071_184_114_679_211_776_631_957_069n,
      debtIndex: 1_139_032_791_728_811_735_729_108_169n,
      price: 99_906_836n,
      collateral: false,
    },
  ],
  /** What `getUserAccountData` reported at that same block, at 1e8. */
  totalCollateralUsd: '17528.0091792',
  totalDebtUsd: '8064.46673481',
} as const;

type Fixture = (typeof BLOCK.reserves)[number];

function raw(reserve: Fixture): RawPosition {
  return {
    asset: reserve.asset,
    symbol: reserve.symbol,
    decimals: reserve.decimals,
    supplied: rayMulSupply(reserve.scaledSupply, reserve.income),
    borrowed: rayMulDebt(reserve.scaledDebt, reserve.debtIndex),
    usedAsCollateral: reserve.collateral,
    priceBase: reserve.price,
  };
}

function sum(values: readonly (string | null)[]): string {
  return values
    .filter((value): value is string => value !== null)
    .reduce((total, value) => new Decimal(total).plus(value).toFixed(), '0');
}

describe('the rows add up to the market totals', () => {
  const positions = BLOCK.reserves.map((reserve) => toProtocolPosition(raw(reserve)));

  it('reproduces the collateral total to the base unit', () => {
    // This is the whole claim of pricing rows through the market's own oracle. Priced
    // any other way the two figures would differ by a fraction of a percent that no
    // one reading the page could attribute to rounding rather than to a bug.
    const collateral = sum(
      positions.map((position) => (position.usedAsCollateral ? position.suppliedValueUsd : null)),
    );

    expect(collateral).toBe(BLOCK.totalCollateralUsd);
  });

  it('reproduces the debt total to the base unit', () => {
    expect(sum(positions.map((position) => position.borrowedValueUsd))).toBe(BLOCK.totalDebtUsd);
  });

  it('falls three base units short if the debt value is floored instead of ceiled', () => {
    // Measured, not assumed: one unit per borrowed row. Aave rounds a debt up when it
    // scales the balance *and* again when it values it, and matching only the first
    // step leaves a gap that looks like nothing and is a broken invariant.
    const floored = BLOCK.reserves.reduce((total, reserve) => {
      const borrowed = rayMulDebt(reserve.scaledDebt, reserve.debtIndex);
      return total + (borrowed * reserve.price) / 10n ** BigInt(reserve.decimals);
    }, 0n);

    expect(new Decimal(floored.toString()).dividedBy(1e8).toFixed()).toBe('8064.46673478');
  });
});

describe('toProtocolPosition', () => {
  const [weth, usdc] = BLOCK.reserves;

  it('renders the supplied amount as the aToken reports it', () => {
    expect(toProtocolPosition(raw(weth!)).supplied).toBe('9.083319214352582347');
  });

  it('renders a borrowed amount at the token’s own decimals, not at 18', () => {
    // The underlying may not be on any bundled list, so decimals are read from the
    // token itself. Assuming 18 here would report a $671 debt as 0.00000000067.
    expect(toProtocolPosition(raw(usdc!)).borrowed).toBe('671.847904');
  });

  it('carries the symbol the token reports, and keeps null as null', () => {
    expect(toProtocolPosition(raw(weth!)).symbol).toBe('WETH');
    expect(toProtocolPosition({ ...raw(weth!), symbol: null }).symbol).toBeNull();
  });

  it('reports no price as null rather than as zero', () => {
    // A collateral position the oracle cannot price is not a worthless one, and the
    // difference is $17,528.
    const position = toProtocolPosition({ ...raw(weth!), priceBase: null });

    expect(position.suppliedValueUsd).toBeNull();
    expect(position.borrowedValueUsd).toBeNull();
    expect(position.supplied).toBe('9.083319214352582347');
  });

  it('leaves an unborrowed asset at zero rather than rounding its value up', () => {
    // The ceiling applies to a debt, not to the absence of one. Without the guard
    // every supplied-only row would carry a phantom cent of debt.
    const position = toProtocolPosition(raw(weth!));

    expect(position.borrowed).toBe('0');
    expect(position.borrowedValueUsd).toBe('0');
  });

  it('keeps every digit of an amount past 20 significant figures', () => {
    // Review round 13, and a test that used to pass vacuously: the old assertion used
    // an exact power of ten, which survives rounding. `Decimal.dividedBy` defaults to
    // 20 significant digits, so this amount came back as 123.4567890123456789 — two
    // base units short, silently.
    const position = toProtocolPosition({
      ...raw(weth!),
      supplied: 123_456_789_012_345_678_901n,
    });

    expect(position.supplied).toBe('123.456789012345678901');
  });

  it('survives an amount far past what a float could hold', () => {
    const position = toProtocolPosition({ ...raw(weth!), supplied: 10n ** 30n });

    expect(position.supplied).toBe('1000000000000');
    expect(position.suppliedValueUsd).toBe('1929692083430000');
  });
});

describe('isOpen', () => {
  it('is false for a reserve the wallet neither supplied to nor borrowed from', () => {
    const position = toProtocolPosition({ ...raw(BLOCK.reserves[0]!), supplied: 0n, borrowed: 0n });

    expect(isOpen(position)).toBe(false);
  });

  it('is true for a supply with the collateral switch off', () => {
    // The position the market totals cannot see. Dropping it here would hide the one
    // row that explains why a headline reads zero while the wallet holds something.
    const position = toProtocolPosition({ ...raw(BLOCK.reserves[0]!), usedAsCollateral: false });

    expect(isOpen(position)).toBe(true);
  });

  it('is true for a debt with nothing supplied in that asset', () => {
    expect(isOpen(toProtocolPosition(raw(BLOCK.reserves[1]!)))).toBe(true);
  });
});

describe('RAY', () => {
  it('is the unit the indices above are quoted in', () => {
    expect(RAY).toBe(10n ** 27n);
  });
});
