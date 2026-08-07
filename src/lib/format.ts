import { isDecimalString, Money, parseDecimal } from '@/domain/money';

/**
 * Display formatting.
 *
 * Every function here takes an exact decimal string and returns a string for
 * humans — **without ever converting through `number`**. That restriction is not
 * pedantry: `Number('9007199254740993')` renders as `9,007,199,254,740,992`, and
 * one wei of an 18-decimal token rendered through `Intl` with a fraction-digit
 * cap comes out as `0`. Both are false statements about someone's holdings, in a
 * product whose whole premise is not making those.
 *
 * Rounding therefore happens in `Decimal`, and thousands separators are applied
 * to the integer part as a `bigint`, which `Intl.NumberFormat` groups exactly.
 */

/** `Intl` formats a `bigint` without precision loss, unlike a `number`. */
const INTEGER_GROUPER = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Decimal places for USD amounts of ordinary size. */
const USD_DECIMAL_PLACES = 2;
/** Significant digits kept for amounts too small to show at two decimals. */
const SUB_CENT_SIGNIFICANT_DIGITS = 4;
/** Decimal places for quantities of one token or more. */
const QUANTITY_DECIMAL_PLACES = 4;
/** Significant digits kept for fractional quantities, so dust stays visible. */
const DUST_SIGNIFICANT_DIGITS = 6;

const PLACEHOLDER = '—';

export function formatUsd(value: string | null): string {
  if (value === null || !isDecimalString(value)) {
    return PLACEHOLDER;
  }

  const amount = parseDecimal(value);
  const magnitude = amount.abs();

  const rendered = magnitude.isZero()
    ? magnitude.toFixed(USD_DECIMAL_PLACES)
    : magnitude.lt(0.01)
      ? // Two decimals would render a real, tiny holding as $0.00.
        trimTrailingZeros(
          magnitude.toSignificantDigits(SUB_CENT_SIGNIFICANT_DIGITS, Money.ROUND_HALF_UP).toFixed(),
        )
      : magnitude.toFixed(USD_DECIMAL_PLACES, Money.ROUND_HALF_UP);

  return `${amount.isNegative() ? '-' : ''}$${group(rendered)}`;
}

export function formatPercent(value: string | null): string {
  if (value === null || !isDecimalString(value)) {
    return PLACEHOLDER;
  }
  const percent = parseDecimal(value);
  return `${percent.isNegative() ? '-' : ''}${group(percent.abs().toFixed(2, Money.ROUND_HALF_UP))}%`;
}

/**
 * A health factor, rounded for reading.
 *
 * The stored value carries all 18 of Aave's decimals, because it is a decimal string
 * like every other number here and truncating at the source would lose information
 * the API should still carry. But `1.786609136659433679` on a page is noise, and
 * Aave's own interface shows two decimals — matching it is what makes the two
 * reconcilable at a glance.
 *
 * Rounded **down**, deliberately. A factor of 1.0999 shown as "1.10" reads as further
 * from the liquidation threshold than it is, and this is the one number on the page
 * where rounding the wrong way flatters a risk. Aave's own interface rounds to
 * nearest, so the last digit can differ from theirs by 0.01 — accepted, because the
 * figures still reconcile and the difference only ever errs toward caution.
 */
export function formatHealthFactor(value: string | null): string {
  if (value === null || !isDecimalString(value)) {
    return PLACEHOLDER;
  }
  return parseDecimal(value).toFixed(2, Money.ROUND_DOWN);
}

/**
 * Token quantities keep more precision than money: for an 18-decimal token a
 * holding can be legitimately tiny, and rounding it to a fixed number of
 * decimals would show `0` for a real balance.
 */
export function formatQuantity(value: string): string {
  if (!isDecimalString(value)) {
    return value;
  }

  const quantity = parseDecimal(value);
  if (quantity.isZero()) {
    return '0';
  }

  const magnitude = quantity.abs();
  const rendered = magnitude.gte(1)
    ? trimTrailingZeros(magnitude.toFixed(QUANTITY_DECIMAL_PLACES, Money.ROUND_HALF_UP))
    : trimTrailingZeros(
        magnitude.toSignificantDigits(DUST_SIGNIFICANT_DIGITS, Money.ROUND_HALF_UP).toFixed(),
      );

  return `${quantity.isNegative() ? '-' : ''}${group(rendered)}`;
}

export function formatRelativeTime(isoTimestamp: string, now: number = Date.now()): string {
  const timestamp = Date.parse(isoTimestamp);
  if (Number.isNaN(timestamp)) {
    return 'unknown';
  }
  const seconds = Math.round((now - timestamp) / 1000);
  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * Adds thousands separators to an unsigned decimal string. The integer part goes
 * through `bigint`, so no digit is lost however large it is; the fraction is
 * carried across untouched.
 */
function group(unsigned: string): string {
  const [integerPart = '0', fraction] = unsigned.split('.');
  const grouped = INTEGER_GROUPER.format(BigInt(integerPart));
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function trimTrailingZeros(value: string): string {
  if (!value.includes('.')) {
    return value;
  }
  return value.replace(/\.?0+$/, '');
}
