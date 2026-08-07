import { describe, expect, it } from 'vitest';

import { RAY, rayMulDebt, rayMulSupply, rayToDecimalString } from './rayMath';

/**
 * Captured from Ethereum mainnet on 2026-08-07 for the borrower `0xf635aaee…7054`
 * on Aave v3 Core, together with what the aToken and variable-debt token reported
 * from their own `balanceOf` at the same moment.
 *
 * These are the only assertions here that prove anything: everything else pins
 * behaviour, but these two say the arithmetic agrees with the protocol.
 */
const LIVE = {
  // WETH supply
  wethScaledSupply: 8_496_366_850_973_757_592n,
  wethNormalizedIncome: 1_069_080_262_391_984_523_210_524_747n,
  wethStoredIndex: 1_069_080_197_185_975_387_552_920_517n,
  wethActualBalance: 9_083_298_102_417_584_030n,
  // USDC variable debt
  usdcScaledDebt: 540_434_395n,
  usdcNormalizedDebt: 1_243_154_843_239_071_624_484_283_260n,
  usdcActualDebt: 671_843_636n,
};

describe('rayMulSupply', () => {
  it('reproduces a real aToken balance to the wei', () => {
    expect(rayMulSupply(LIVE.wethScaledSupply, LIVE.wethNormalizedIncome)).toBe(
      LIVE.wethActualBalance,
    );
  });

  it('rounds down, because rounding a holding up promises more than exists', () => {
    // Measured: half-up gives 9083298102417584031, one wei above what the aToken
    // reports. Aave's TokenMath floors an aToken balance, and matching it is the
    // difference between reconciling with Aave and nearly reconciling.
    const halfUp =
      (LIVE.wethScaledSupply * LIVE.wethNormalizedIncome + RAY / 2n) / RAY;
    expect(halfUp).toBe(LIVE.wethActualBalance + 1n);
    expect(rayMulSupply(LIVE.wethScaledSupply, LIVE.wethNormalizedIncome)).toBe(
      LIVE.wethActualBalance,
    );
  });
});

describe('rayMulDebt', () => {
  it('reproduces a real variable-debt balance to the unit', () => {
    expect(rayMulDebt(LIVE.usdcScaledDebt, LIVE.usdcNormalizedDebt)).toBe(LIVE.usdcActualDebt);
  });

  it('rounds up, because a debt rounded down is a debt understated', () => {
    // Measured: flooring gives 671843635, one unit below what the debt token
    // reports. The two sides round in opposite directions on purpose — neither
    // figure is allowed to flatter the reader.
    const floored = (LIVE.usdcScaledDebt * LIVE.usdcNormalizedDebt) / RAY;
    expect(floored).toBe(LIVE.usdcActualDebt - 1n);
    expect(rayMulDebt(LIVE.usdcScaledDebt, LIVE.usdcNormalizedDebt)).toBe(LIVE.usdcActualDebt);
  });

  it('leaves zero debt at zero rather than rounding it up to one', () => {
    // Without the guard, ceil turns "no debt" into one base unit of debt, which
    // would put a phantom borrow on every wallet that has none.
    expect(rayMulDebt(0n, LIVE.usdcNormalizedDebt)).toBe(0n);
  });
});

describe('the stored index is not the one to use', () => {
  it('understates a supply, always in the protocol's favour', () => {
    // `Pool.getReserveData` reports the index as of the last time the reserve was
    // touched; the aToken accrues to now. Review round 13 caught the earlier version
    // of this file using the stored one after "verifying" it against a reserve that
    // happened to have been updated minutes before.
    const withStored = rayMulSupply(LIVE.wethScaledSupply, LIVE.wethStoredIndex);

    expect(withStored).toBeLessThan(LIVE.wethActualBalance);
    expect(LIVE.wethActualBalance - withStored).toBe(554_014_174_504n);
  });
});

describe('shared behaviour', () => {
  it('leaves a balance untouched at an index of exactly one', () => {
    expect(rayMulSupply(12_345n, RAY)).toBe(12_345n);
    expect(rayMulDebt(12_345n, RAY)).toBe(12_345n);
  });

  it('returns zero for no balance, whatever the index', () => {
    expect(rayMulSupply(0n, LIVE.wethNormalizedIncome)).toBe(0n);
    expect(rayMulDebt(0n, LIVE.usdcNormalizedDebt)).toBe(0n);
  });

  it('survives a balance far past what a float could hold', () => {
    const huge = 10n ** 30n;
    const result = rayMulSupply(huge, LIVE.wethNormalizedIncome);

    expect(result).toBe(1_069_080_262_391_984_523_210_524_747_000n);
    expect(result > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('refuses a negative input rather than producing a plausible wrong number', () => {
    expect(() => rayMulSupply(-1n, RAY)).toThrow(RangeError);
    expect(() => rayMulDebt(1n, -RAY)).toThrow(RangeError);
  });
});

describe('rayToDecimalString', () => {
  it('renders an index without losing digits to a float', () => {
    expect(rayToDecimalString(LIVE.wethNormalizedIncome)).toBe('1.069080262391984523210524747');
  });

  it('drops trailing zeros but keeps the whole part', () => {
    expect(rayToDecimalString(RAY)).toBe('1');
    expect(rayToDecimalString(RAY + RAY / 2n)).toBe('1.5');
  });

  it('handles a value below one, and zero', () => {
    expect(rayToDecimalString(RAY / 4n)).toBe('0.25');
    expect(rayToDecimalString(0n)).toBe('0');
  });
});
