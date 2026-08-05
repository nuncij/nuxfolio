import { compareDecimal, isPositive, Money, parseDecimal, PERCENT_DECIMAL_PLACES } from './money';
import type { PortfolioAsset, PriceChange, PriceQuality } from './portfolio';

/**
 * Price change over a period, and the rules for when it may not be stated.
 *
 * A percentage is the most confidently-read number on a portfolio screen: people
 * act on "−12%" without asking what it was computed from. That makes it the field
 * most worth refusing to print. Three rules do the refusing:
 *
 *  - **The current price must be trustworthy.** Comparing a stale quote against a
 *    historical one produces something that looks precise and means nothing.
 *  - **A disputed price is not a basis for arithmetic.** ADR-019 keeps a disputed
 *    price in the total and prefers neither source. Deriving an exact percentage
 *    from it would quietly resolve the dispute in the primary's favour.
 *  - **The observation must actually be from the period claimed.** DefiLlama
 *    answers with the nearest price it holds, which can be hours from the instant
 *    requested. A point 30 hours old labelled "24 h" is simply false.
 */

/** Seconds in the periods this module knows about. */
export const PERIOD_SECONDS = { '24h': 86_400, '7d': 604_800 } as const;

export type ChangePeriod = keyof typeof PERIOD_SECONDS;

/**
 * How far a returned observation may sit from the requested instant.
 *
 * Wider for the longer period: being six hours out matters much more when
 * comparing across a day than across a week, and DefiLlama's coverage thins out
 * the further back you ask.
 */
export const PERIOD_TOLERANCE_SECONDS: Record<ChangePeriod, number> = {
  '24h': 6 * 3_600,
  '7d': 24 * 3_600,
};

/** Below this, a change is real but rounds to zero at display precision. */
export const SMALLEST_SHOWN_PCT = '0.01';

type CurrentQuote = Pick<PortfolioAsset, 'priceUsd' | 'priceQuality' | 'priceCheck'>;

/** A ref that was never asked about. Distinct from one that came back empty. */
export function notRequested(): PriceChange {
  return { status: 'not-requested', pct: null, thenUsd: null, asOf: null };
}

/**
 * Compares a current price against a historical observation.
 *
 * Every rejection path returns a status rather than a null percentage on its own,
 * so a caller cannot accidentally render "no change" where the truth is "no
 * comparable data".
 */
export function computePriceChange(input: {
  current: CurrentQuote;
  /** Null when the source was asked and had nothing. */
  thenUsd: string | null;
  /** The observation's own timestamp, ISO. Null when the source did not say. */
  thenAsOf: string | null;
  /** The instant that was actually requested, unix seconds. */
  targetUnixSeconds: number;
  period: ChangePeriod;
}): PriceChange {
  const { current, thenUsd, thenAsOf, targetUnixSeconds, period } = input;

  if (thenUsd === null) {
    return { status: 'no-quote', pct: null, thenUsd: null, asOf: thenAsOf };
  }

  // Everything below this point has a historical price, so it is reported even
  // when the comparison is refused: "it was $1,860, but we will not turn that
  // into a percentage" is more informative than withholding both.
  const unusable = (): PriceChange => ({
    status: 'unusable',
    pct: null,
    thenUsd,
    asOf: thenAsOf,
  });

  if (!isUsableCurrentQuote(current)) {
    return unusable();
  }
  if (!isPositive(thenUsd)) {
    return unusable();
  }
  if (!isWithinTolerance({ thenAsOf, targetUnixSeconds, period })) {
    return unusable();
  }

  const now = parseDecimal(current.priceUsd as string);
  const then = parseDecimal(thenUsd);

  return {
    status: 'ok',
    // Signed on purpose: the direction is the point.
    pct: normalizeZero(
      now.minus(then).div(then).mul(100).toFixed(PERCENT_DECIMAL_PLACES, Money.ROUND_HALF_UP),
    ),
    thenUsd,
    asOf: thenAsOf,
  };
}

/**
 * Whether the current quote can be one side of a percentage at all.
 *
 * Exported because the caller uses it to decide what to *request*: an asset whose
 * change would be suppressed anyway is not worth spending a batch slot on.
 */
export function isUsableCurrentQuote(current: CurrentQuote): boolean {
  if (current.priceUsd === null || !isPositive(current.priceUsd)) {
    return false;
  }
  // A caveat on the current price is a caveat on any arithmetic over it.
  const quality: PriceQuality | null = current.priceQuality;
  if (quality !== 'ok') {
    return false;
  }
  // Fresh and confident, yet contradicted by the second source. ADR-019 prefers
  // neither price; a percentage computed from one of them would pick a winner.
  return current.priceCheck?.status !== 'disputed';
}

function isWithinTolerance(input: {
  thenAsOf: string | null;
  targetUnixSeconds: number;
  period: ChangePeriod;
}): boolean {
  // No timestamp is not evidence of a good one. The source declined to say when
  // this price is from, so it cannot be labelled as belonging to the period.
  if (input.thenAsOf === null) {
    return false;
  }
  const observed = Date.parse(input.thenAsOf);
  if (!Number.isFinite(observed)) {
    return false;
  }
  const driftSeconds = Math.abs(observed / 1000 - input.targetUnixSeconds);
  return driftSeconds <= PERIOD_TOLERANCE_SECONDS[input.period];
}

/**
 * Turns `-0.0000` into `0.0000`.
 *
 * A tiny negative change rounds to a signed zero, and "-0.00%" reads as a fall
 * that did not happen.
 */
function normalizeZero(pct: string): string {
  return compareDecimal(pct, '0') === 0 ? parseDecimal('0').toFixed(PERCENT_DECIMAL_PLACES) : pct;
}

/**
 * Whether a change is non-zero but rounds to zero at two decimal places.
 *
 * `formatPercent` renders 0.004% as "0.00%", which asserts the opposite of the
 * data — the display layer needs to know to say "<0.01%" instead.
 */
export function isBelowDisplayPrecision(pct: string): boolean {
  return compareDecimal(pct, '0') !== 0 && compareDecimal(absolute(pct), SMALLEST_SHOWN_PCT) < 0;
}

function absolute(value: string): string {
  return parseDecimal(value).abs().toFixed();
}
