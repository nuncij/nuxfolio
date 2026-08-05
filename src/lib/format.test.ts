import { describe, expect, it } from 'vitest';

import { formatPercent, formatQuantity, formatRelativeTime, formatUsd } from './format';

describe('formatUsd', () => {
  it('formats an ordinary amount', () => {
    expect(formatUsd('1234.5')).toBe('$1,234.50');
  });

  it('renders a missing value as a dash, never as $0.00', () => {
    expect(formatUsd(null)).toBe('—');
  });

  it('keeps significant digits for a sub-cent amount instead of showing $0.00', () => {
    // A real holding worth a fraction of a cent must not read as worthless.
    expect(formatUsd('0.000004321')).toBe('$0.000004321');
  });

  it('formats exact zero as zero', () => {
    expect(formatUsd('0')).toBe('$0.00');
  });

  it('formats a large amount with separators', () => {
    expect(formatUsd('98765432.1')).toBe('$98,765,432.10');
  });

  it('formats a negative amount with the sign outside the currency symbol', () => {
    expect(formatUsd('-12.5')).toBe('-$12.50');
  });

  it('rounds half up at the cent', () => {
    expect(formatUsd('1.005')).toBe('$1.01');
  });

  it('renders an amount beyond float precision without losing a digit', () => {
    // Number('9007199254740993') is 9007199254740992 — one dollar short.
    expect(formatUsd('9007199254740993')).toBe('$9,007,199,254,740,993.00');
  });

  it('renders a garbage value as a dash rather than NaN', () => {
    expect(formatUsd('not-a-number')).toBe('—');
  });
});

describe('formatPercent', () => {
  it('formats a share to two decimal places', () => {
    expect(formatPercent('72.7273')).toBe('72.73%');
  });

  it('renders a missing share as a dash rather than 0%', () => {
    expect(formatPercent(null)).toBe('—');
  });

  it('formats a hundred percent', () => {
    expect(formatPercent('100.0000')).toBe('100.00%');
  });
});

describe('formatQuantity', () => {
  it('formats a whole token amount without decimal noise', () => {
    expect(formatQuantity('1500')).toBe('1,500');
  });

  it('keeps four decimals for amounts above one', () => {
    expect(formatQuantity('1.23456789')).toBe('1.2346');
  });

  it('keeps significant digits for fractional amounts', () => {
    expect(formatQuantity('0.00012345678')).toBe('0.000123457');
  });

  it('shows one wei of an 18-decimal token rather than rounding it to zero', () => {
    // A fixed fraction-digit cap through `number` renders this as "0".
    expect(formatQuantity('0.000000000000000001')).toBe('0.000000000000000001');
  });

  it('renders a quantity beyond float precision without losing a digit', () => {
    expect(formatQuantity('9007199254740993')).toBe('9,007,199,254,740,993');
  });

  it('groups a very large holding', () => {
    expect(formatQuantity('1000000000000')).toBe('1,000,000,000,000');
  });

  it('formats zero plainly', () => {
    expect(formatQuantity('0')).toBe('0');
  });

  it('returns the input unchanged when it is not a decimal string', () => {
    expect(formatQuantity('not-a-number')).toBe('not-a-number');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-07-30T12:00:00.000Z');

  it.each([
    ['2026-07-30T11:59:58.000Z', 'just now'],
    ['2026-07-30T11:59:30.000Z', '30s ago'],
    ['2026-07-30T11:55:00.000Z', '5m ago'],
    ['2026-07-30T09:00:00.000Z', '3h ago'],
    ['2026-07-28T12:00:00.000Z', '2d ago'],
  ])('formats %s as %s', (timestamp, expected) => {
    expect(formatRelativeTime(timestamp, now)).toBe(expected);
  });

  it('says unknown for an unparseable timestamp', () => {
    expect(formatRelativeTime('never', now)).toBe('unknown');
  });
});
