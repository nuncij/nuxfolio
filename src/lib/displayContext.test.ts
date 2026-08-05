import { describe, expect, it } from 'vitest';

import type { FxQuote } from '@/domain/portfolio';

import {
  canShowEur,
  conversionNote,
  currencySymbol,
  toDisplayCurrency,
  USD_DISPLAY,
  type DisplayContext,
} from './displayContext';

const RATE: FxQuote = { base: 'EUR', quote: 'USD', rate: '1.25', asOf: '2026-07-31' };

const EUR: DisplayContext = { currency: 'EUR', fxRate: RATE };

describe('toDisplayCurrency', () => {
  it('divides by the rate, because the ECB quotes the euro as the base', () => {
    // 1 EUR = 1.25 USD, so $100 is €80. Multiplying would give €125 — a 56%
    // overstatement of every figure on the page, consistent enough to look
    // plausible, which is what makes the direction worth a test of its own.
    expect(toDisplayCurrency('100', EUR)).toBe('80.00000000');
  });

  it('leaves the value untouched in USD', () => {
    expect(toDisplayCurrency('100', USD_DISPLAY)).toBe('100');
  });

  it('leaves the value untouched when EUR is asked for without a rate', () => {
    // Cannot convert, so it does not pretend to. The caller decides what to show.
    expect(toDisplayCurrency('100', { currency: 'EUR', fxRate: null })).toBe('100');
  });

  it('passes null through rather than inventing a zero', () => {
    expect(toDisplayCurrency(null, EUR)).toBeNull();
  });

  it('converts exactly, beyond what a float would hold', () => {
    // A rate of 1 makes the arithmetic an identity, so any drift is visible.
    const identity: DisplayContext = {
      currency: 'EUR',
      fxRate: { ...RATE, rate: '1' },
    };
    expect(toDisplayCurrency('9007199254740993', identity)).toBe('9007199254740993.00000000');
  });

  it('refuses a non-positive rate rather than dividing by it', () => {
    for (const rate of ['0', '-1.25']) {
      expect(toDisplayCurrency('100', { currency: 'EUR', fxRate: { ...RATE, rate } })).toBeNull();
    }
  });

  it('keeps money precision so the formatter rounds only once', () => {
    // $10 at 1.25 is exactly €8; a value that does not divide evenly must not be
    // rounded to cents here, or a later rounding would compound.
    expect(toDisplayCurrency('10', { currency: 'EUR', fxRate: { ...RATE, rate: '3' } })).toBe(
      '3.33333333',
    );
  });
});

describe('canShowEur', () => {
  it('is false without a rate, so the toggle is absent rather than broken', () => {
    expect(canShowEur(null)).toBe(false);
    expect(canShowEur(RATE)).toBe(true);
  });
});

describe('currencySymbol', () => {
  it('names both currencies', () => {
    expect(currencySymbol('EUR')).toBe('€');
    expect(currencySymbol('USD')).toBe('$');
  });
});

describe('conversionNote', () => {
  it('names the rate and the date the source stamped on it', () => {
    const note = conversionNote(EUR);
    expect(note).toContain('2026-07-31');
    expect(note).toContain('1 EUR = 1.25 USD');
    // The rate's publishing schedule is part of the disclosure: a figure converted
    // at Friday's rate on a Monday is not wrong, but the reader is entitled to know.
    expect(note).toContain('business days');
  });

  it('says nothing in USD, because there is nothing to disclose', () => {
    expect(conversionNote(USD_DISPLAY)).toBeNull();
  });

  it('says nothing when EUR was asked for but no rate exists', () => {
    expect(conversionNote({ currency: 'EUR', fxRate: null })).toBeNull();
  });
});
