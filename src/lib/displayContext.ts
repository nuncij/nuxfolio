import { Money, parseDecimal } from '@/domain/money';
import type { FxQuote } from '@/domain/portfolio';

/**
 * What currency figures are shown in, and what that costs in certainty.
 *
 * Passed as one object rather than as loose arguments because the rate cannot be
 * separated from its date: a EUR figure is a conversion of an estimate at a rate
 * that is itself up to several days old, and a component that received only the
 * number would have no way to say so. Threading the two together makes the
 * disclosure impossible to omit by accident.
 */

export type DisplayCurrency = 'USD' | 'EUR';

export type DisplayContext = {
  readonly currency: DisplayCurrency;
  /** Null when no rate could be fetched; EUR is then unavailable. */
  readonly fxRate: FxQuote | null;
};

/** USD with no conversion — the default, and what every server render starts as. */
export const USD_DISPLAY: DisplayContext = { currency: 'USD', fxRate: null };

/**
 * Whether EUR can honestly be offered.
 *
 * The toggle is hidden rather than shown-and-broken when there is no rate: a
 * control that cannot do what it says is worse than an absent one.
 */
export function canShowEur(fxRate: FxQuote | null): boolean {
  return fxRate !== null;
}

/**
 * Converts a USD decimal string into the display currency.
 *
 * **Divides.** The ECB quotes the euro as the base — "1 EUR = 1.1485 USD" — so
 * dollars become euros by dividing. Multiplying would overstate every figure on
 * the page by about a third, silently and consistently enough to look plausible.
 *
 * Returns null when the value cannot be converted, so the caller renders its
 * usual placeholder instead of a wrong number.
 */
export function toDisplayCurrency(valueUsd: string | null, context: DisplayContext): string | null {
  if (valueUsd === null) {
    return null;
  }
  if (context.currency === 'USD' || context.fxRate === null) {
    return valueUsd;
  }

  const rate = parseDecimal(context.fxRate.rate);
  if (!rate.gt(0)) {
    return null;
  }
  // Kept at money precision rather than rounded to cents here: the formatter
  // rounds once, at the end, so a conversion does not round twice.
  return parseDecimal(valueUsd).div(rate).toFixed(MONEY_PRECISION, Money.ROUND_HALF_UP);
}

/** Matches the domain's money precision, so a conversion loses nothing extra. */
const MONEY_PRECISION = 8;

/** The symbol a figure in this context carries. */
export function currencySymbol(currency: DisplayCurrency): string {
  return currency === 'EUR' ? '€' : '$';
}

/**
 * One sentence naming the conversion and the rate's own date.
 *
 * Null in USD, because there is nothing to disclose. Shown once per page rather
 * than beside every figure: repeating it adds noise without adding truth.
 */
export function conversionNote(context: DisplayContext): string | null {
  if (context.currency === 'USD' || context.fxRate === null) {
    return null;
  }
  const { rate, asOf } = context.fxRate;
  return `Shown in euro, converted from US dollars at the European Central Bank reference rate of ${asOf} (1 EUR = ${rate} USD). The rate is published on business days, so it can be a few days old.`;
}
