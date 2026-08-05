import { describe, expect, it } from 'vitest';

import {
  compareDecimal,
  DecimalParseError,
  formatBaseUnits,
  isPositive,
  isZero,
  multiplyToMoney,
  numberToDecimalString,
  parseDecimal,
  percentageOf,
  sumMoney,
  toBaseUnits,
} from './money';

describe('formatBaseUnits', () => {
  it('renders one wei without losing digits', () => {
    expect(formatBaseUnits(1n, 18)).toBe('0.000000000000000001');
  });

  it('renders six-decimal tokens', () => {
    expect(formatBaseUnits(123_456_789n, 6)).toBe('123.456789');
  });

  it('handles zero-decimal tokens', () => {
    expect(formatBaseUnits(42n, 0)).toBe('42');
  });

  it('survives balances far beyond Number.MAX_SAFE_INTEGER', () => {
    // 1e30 base units of an 18-decimal token = 1e12 tokens. As a float this
    // would already have lost precision before formatting.
    expect(formatBaseUnits(10n ** 30n, 18)).toBe('1000000000000');
  });

  it('preserves every digit of a balance with 30 significant figures', () => {
    const raw = 123_456_789_012_345_678_901_234_567_890n;
    expect(formatBaseUnits(raw, 18)).toBe('123456789012.34567890123456789');
  });

  it('rejects implausible decimals rather than producing a wrong quantity', () => {
    expect(() => formatBaseUnits(1n, 99)).toThrow(RangeError);
    expect(() => formatBaseUnits(1n, -1)).toThrow(RangeError);
  });
});

describe('toBaseUnits', () => {
  it('round-trips through formatBaseUnits', () => {
    const raw = 987_654_321_000_000_000n;
    expect(toBaseUnits(formatBaseUnits(raw, 18), 18)).toBe(raw);
  });

  it('truncates rather than rounds excess precision, so a balance is never inflated', () => {
    expect(toBaseUnits('1.9999999', 6)).toBe(1_999_999n);
  });
});

describe('multiplyToMoney', () => {
  it('computes a value exactly where floating point would not', () => {
    // 0.1 * 0.2 === 0.020000000000000004 in IEEE-754 double arithmetic.
    expect(multiplyToMoney('0.1', '0.2')).toBe('0.02000000');
    expect(0.1 * 0.2).not.toBe(0.02);
  });

  it('values a large holding of a cheap token without drift', () => {
    expect(multiplyToMoney('1000000000000', '0.00000001')).toBe('10000.00000000');
  });

  it('keeps sub-cent precision', () => {
    expect(multiplyToMoney('3', '0.000000005')).toBe('0.00000002');
  });
});

describe('sumMoney', () => {
  it('sums exactly where floating point would not', () => {
    // 0.1 + 0.2 === 0.30000000000000004 as doubles.
    expect(sumMoney(['0.1', '0.2'])).toBe('0.30000000');
  });

  it('sums an empty list to zero', () => {
    expect(sumMoney([])).toBe('0.00000000');
  });

  it('accumulates a thousand small values without drift', () => {
    expect(sumMoney(Array.from({ length: 1000 }, () => '0.01'))).toBe('10.00000000');
  });
});

describe('percentageOf', () => {
  it('computes a share', () => {
    expect(percentageOf('25', '200')).toBe('12.5000');
  });

  it('returns null for a zero total, because a share of nothing is undefined', () => {
    expect(percentageOf('0', '0')).toBeNull();
  });

  it('returns null for a negative total rather than a nonsensical percentage', () => {
    expect(percentageOf('1', '-5')).toBeNull();
  });

  it('produces shares that add up to 100 for a real split', () => {
    const values = ['1234.56', '789.01', '0.42'];
    const total = sumMoney(values);
    const shares = values.map((value) => percentageOf(value, total));
    const summed = shares.reduce((acc, share) => acc + Number(share), 0);
    // Each share is rounded to four decimal places, so the sum lands within
    // rounding distance of 100 rather than exactly on it.
    expect(summed).toBeCloseTo(100, 3);
  });
});

describe('parseDecimal', () => {
  it.each(['', 'abc', '1e5', 'NaN', 'Infinity', '0x10', '1.2.3', ' 1', '1 '])(
    'rejects %o, which Decimal would otherwise accept or coerce',
    (input) => {
      expect(() => parseDecimal(input)).toThrow(DecimalParseError);
    },
  );

  it.each(['0', '-1', '1.5', '000123', '0.000000000000000001'])('accepts %o', (input) => {
    expect(() => parseDecimal(input)).not.toThrow();
  });
});

describe('compareDecimal', () => {
  it('distinguishes integers that are indistinguishable as doubles', () => {
    // Both round to 9007199254740992 when stored as a float64.
    expect(compareDecimal('9007199254740993', '9007199254740992')).toBe(1);
    expect(Number('9007199254740993') === Number('9007199254740992')).toBe(true);
  });

  it('orders values consistently', () => {
    expect(compareDecimal('1', '2')).toBe(-1);
    expect(compareDecimal('2.50', '2.5')).toBe(0);
  });
});

describe('numberToDecimalString', () => {
  it('converts a provider float once, at the boundary', () => {
    expect(numberToDecimalString(1917.95)).toBe('1917.95');
  });

  it('renders a very small price without scientific notation', () => {
    expect(numberToDecimalString(0.000000123)).toBe('0.000000123');
  });

  it('rejects non-finite input instead of poisoning downstream arithmetic', () => {
    expect(() => numberToDecimalString(Number.NaN)).toThrow(DecimalParseError);
    expect(() => numberToDecimalString(Number.POSITIVE_INFINITY)).toThrow(DecimalParseError);
  });
});

describe('predicates', () => {
  it('recognises zero in its several written forms', () => {
    expect(isZero('0')).toBe(true);
    expect(isZero('0.000')).toBe(true);
    expect(isZero('0.0000000000000000001')).toBe(false);
  });

  it('recognises positive values', () => {
    expect(isPositive('0.0000001')).toBe(true);
    expect(isPositive('0')).toBe(false);
    expect(isPositive('-1')).toBe(false);
  });
});
