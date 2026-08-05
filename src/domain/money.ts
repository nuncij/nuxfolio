import Decimal from 'decimal.js';
import { formatUnits, parseUnits } from 'viem';

/**
 * Decimal arithmetic for token quantities and fiat values.
 *
 * Nothing in Nuxfolio performs financial arithmetic with `number`. Base units
 * are `bigint`, everything derived is a decimal string, and the maths in
 * between runs through this module. See docs/DECISIONS.md, ADR-003.
 */

/**
 * A private Decimal constructor so Nuxfolio's precision settings cannot leak
 * into — or be changed by — any other consumer of decimal.js.
 *
 * `precision: 50` comfortably covers an 18-decimal balance multiplied by a
 * price. The exponent bounds are pushed out so `toString()` never returns
 * scientific notation, which would be unparseable downstream.
 */
export const Money = Decimal.clone({
  precision: 50,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 60,
});

export type MoneyValue = InstanceType<typeof Money>;

/** Decimal places retained on USD amounts — well below one cent. */
export const MONEY_DECIMAL_PLACES = 8;

/** Decimal places retained on percentages. */
export const PERCENT_DECIMAL_PLACES = 4;

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

export class DecimalParseError extends Error {
  constructor(value: string) {
    super(`Not a plain decimal string: ${JSON.stringify(value)}`);
    this.name = 'DecimalParseError';
  }
}

/**
 * Parses a plain decimal string. Rejects scientific notation, `Infinity`,
 * `NaN`, hex and empty input, all of which `new Decimal()` would happily
 * accept and which no trustworthy provider should ever emit.
 */
export function parseDecimal(value: string): MoneyValue {
  if (!DECIMAL_STRING.test(value)) {
    throw new DecimalParseError(value);
  }
  return new Money(value);
}

export function isDecimalString(value: string): boolean {
  return DECIMAL_STRING.test(value);
}

/**
 * Exact base units -> human decimal string. Pure string/bigint work, so an
 * 18-decimal balance far beyond `Number.MAX_SAFE_INTEGER` survives intact.
 */
export function formatBaseUnits(raw: bigint, decimals: number): string {
  assertDecimals(decimals);
  return formatUnits(raw, decimals);
}

/** Human decimal string -> exact base units. Truncates excess precision. */
export function toBaseUnits(value: string, decimals: number): bigint {
  assertDecimals(decimals);
  return parseUnits(parseDecimal(value).toFixed(decimals, Money.ROUND_DOWN), decimals);
}

/** `quantity * unitPrice`, rounded to {@link MONEY_DECIMAL_PLACES}. */
export function multiplyToMoney(quantity: string, unitPrice: string): string {
  return parseDecimal(quantity).mul(parseDecimal(unitPrice)).toFixed(MONEY_DECIMAL_PLACES);
}

/** Exact sum of decimal strings, rounded to {@link MONEY_DECIMAL_PLACES}. */
export function sumMoney(values: readonly string[]): string {
  return values
    .reduce<MoneyValue>((acc, value) => acc.plus(parseDecimal(value)), new Money(0))
    .toFixed(MONEY_DECIMAL_PLACES);
}

/**
 * `value / total * 100`, rounded to {@link PERCENT_DECIMAL_PLACES}.
 * Returns null when the total is zero or negative — a share of nothing is not
 * 0 %, it is undefined, and rendering it as 0 % would be a claim we cannot make.
 */
export function percentageOf(value: string, total: string): string | null {
  const totalDecimal = parseDecimal(total);
  if (totalDecimal.lte(0)) {
    return null;
  }
  return parseDecimal(value).div(totalDecimal).mul(100).toFixed(PERCENT_DECIMAL_PLACES);
}

/** Ordering helper: -1, 0 or 1. Never uses `<` on decimal strings. */
export function compareDecimal(a: string, b: string): number {
  return parseDecimal(a).cmp(parseDecimal(b));
}

export function isZero(value: string): boolean {
  return parseDecimal(value).isZero();
}

export function isPositive(value: string): boolean {
  return parseDecimal(value).gt(0);
}

/**
 * Converts a provider-supplied `number` price into a decimal string once, at
 * the boundary. JSON has no decimal type, so a `number` price is unavoidable
 * on the wire; this is the only place a float is tolerated, and it never
 * participates in arithmetic afterwards.
 */
export function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new DecimalParseError(String(value));
  }
  return new Money(value).toFixed();
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError(`Unsupported token decimals: ${decimals}`);
  }
}
