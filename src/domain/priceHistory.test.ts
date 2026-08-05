import { describe, expect, it } from 'vitest';

import type { PriceCheck } from './portfolio';
import {
  computePriceChange,
  isBelowDisplayPrecision,
  isUsableCurrentQuote,
  notRequested,
  PERIOD_SECONDS,
} from './priceHistory';

/** A target instant with a matching observation, so tolerance never interferes. */
const TARGET = Math.floor(Date.parse('2026-08-02T12:00:00.000Z') / 1000);
const AT_TARGET = new Date(TARGET * 1000).toISOString();

function current(overrides: Partial<Parameters<typeof isUsableCurrentQuote>[0]> = {}) {
  return { priceUsd: '100', priceQuality: 'ok' as const, priceCheck: null, ...overrides };
}

function change(
  overrides: Partial<Parameters<typeof computePriceChange>[0]> = {},
): ReturnType<typeof computePriceChange> {
  return computePriceChange({
    current: current(),
    thenUsd: '80',
    thenAsOf: AT_TARGET,
    targetUnixSeconds: TARGET,
    period: '24h',
    ...overrides,
  });
}

describe('computePriceChange', () => {
  it('computes a signed rise', () => {
    // 100 against 80 is +25%.
    expect(change()).toEqual({
      status: 'ok',
      pct: '25.0000',
      thenUsd: '80',
      asOf: AT_TARGET,
    });
  });

  it('computes a signed fall', () => {
    expect(change({ thenUsd: '125' }).pct).toBe('-20.0000');
  });

  it('reports a genuinely unchanged price as zero, not as missing', () => {
    // Zero is a real answer. It must not be confused with "no data".
    const result = change({ thenUsd: '100' });
    expect(result.status).toBe('ok');
    expect(result.pct).toBe('0.0000');
  });

  it('never renders a negative zero, which would read as a fall', () => {
    // A hair below the current price rounds to zero; the sign must not survive.
    const result = change({ thenUsd: '100.0000000001' });
    expect(result.pct).not.toContain('-');
  });

  it('divides by the historical price, not the current one', () => {
    // The classic direction error: 50 -> 100 is +100%, not +50%.
    expect(change({ current: current({ priceUsd: '100' }), thenUsd: '50' }).pct).toBe('100.0000');
  });

  it('preserves a change small enough to sit on the display boundary', () => {
    // One dollar on a million is 0.0001% — the smallest figure four decimal
    // places can express. It must survive as a non-zero value and be recognised
    // as below what the screen can render, rather than collapsing to "0.00%".
    const result = change({ current: current({ priceUsd: '1000001' }), thenUsd: '1000000' });
    expect(result.status).toBe('ok');
    expect(result.pct).toBe('0.0001');
    expect(isBelowDisplayPrecision(result.pct as string)).toBe(true);
  });

  it('compares prices too large for a double without collapsing them', () => {
    // 2^53+1 is not representable as a float; doubling it must still read as
    // +100% rather than as a rounding artefact.
    const result = change({
      current: current({ priceUsd: '18014398509481986' }),
      thenUsd: '9007199254740993',
    });
    expect(result.status).toBe('ok');
    expect(result.pct).toBe('100.0000');
  });

  it('reports no-quote when the source had no price', () => {
    expect(change({ thenUsd: null })).toEqual({
      status: 'no-quote',
      pct: null,
      thenUsd: null,
      asOf: AT_TARGET,
    });
  });

  it('keeps the historical price visible even when it refuses to compare', () => {
    // "It was $80, but we will not turn that into a percentage" beats withholding
    // both numbers.
    const result = change({ current: current({ priceQuality: 'stale' }) });
    expect(result.status).toBe('unusable');
    expect(result.thenUsd).toBe('80');
    expect(result.pct).toBeNull();
  });

  it.each(['stale', 'low-confidence', 'unknown-age'] as const)(
    'refuses to compare against a %s current price',
    (priceQuality) => {
      expect(change({ current: current({ priceQuality }) }).status).toBe('unusable');
    },
  );

  it('refuses to compare when the second source disputes the current price', () => {
    // ADR-019 prefers neither price. A precise percentage from one of them would
    // quietly resolve the dispute in the primary's favour.
    const disputed: PriceCheck = {
      status: 'disputed',
      source: 'coingecko',
      priceUsd: '140',
      deltaPct: '40.0000',
    };
    expect(change({ current: current({ priceCheck: disputed }) }).status).toBe('unusable');
  });

  it('still compares when the second source agreed', () => {
    const agreed: PriceCheck = {
      status: 'agreed',
      source: 'coingecko',
      priceUsd: '100.5',
      deltaPct: '0.5000',
    };
    expect(change({ current: current({ priceCheck: agreed }) }).status).toBe('ok');
  });

  it.each(['0', '-5'])('refuses to divide by a historical price of %o', (thenUsd) => {
    const result = change({ thenUsd });
    expect(result.status).toBe('unusable');
    expect(result.pct).toBeNull();
  });

  it('refuses an observation too far from the instant requested', () => {
    // DefiLlama answers with the nearest price it holds. Seven hours out is not a
    // 24-hour change, and relabelling it would be a false claim.
    const sevenHoursLate = new Date((TARGET + 7 * 3600) * 1000).toISOString();
    expect(change({ thenAsOf: sevenHoursLate }).status).toBe('unusable');
  });

  it('accepts an observation inside the tolerance', () => {
    const fiveHoursLate = new Date((TARGET + 5 * 3600) * 1000).toISOString();
    expect(change({ thenAsOf: fiveHoursLate }).status).toBe('ok');
  });

  it('allows a wider drift over seven days than over one', () => {
    // Coverage thins out further back, and being 12 h out matters less across a
    // week than across a day.
    const twelveHoursOut = new Date((TARGET + 12 * 3600) * 1000).toISOString();
    expect(change({ thenAsOf: twelveHoursOut, period: '24h' }).status).toBe('unusable');
    expect(change({ thenAsOf: twelveHoursOut, period: '7d' }).status).toBe('ok');
  });

  it('refuses an observation the source would not date', () => {
    // A missing timestamp is not evidence of a good one.
    expect(change({ thenAsOf: null }).status).toBe('unusable');
  });

  it('refuses an unparseable timestamp rather than treating it as on-target', () => {
    expect(change({ thenAsOf: 'last Tuesday' }).status).toBe('unusable');
  });

  it('refuses when the current price is missing or non-positive', () => {
    expect(change({ current: current({ priceUsd: null }) }).status).toBe('unusable');
    expect(change({ current: current({ priceUsd: '0' }) }).status).toBe('unusable');
  });
});

describe('notRequested', () => {
  it('is distinguishable from an empty answer', () => {
    // The round-5 lesson: never asked and asked-with-no-answer are different
    // claims, and the second overstates how much was checked.
    expect(notRequested().status).toBe('not-requested');
    expect(notRequested().status).not.toBe('no-quote');
  });
});

describe('isUsableCurrentQuote', () => {
  it('decides what is worth requesting, not just what is worth showing', () => {
    // Used before the network call: an asset whose change would be suppressed
    // anyway should not consume a batch slot.
    expect(isUsableCurrentQuote(current())).toBe(true);
    expect(isUsableCurrentQuote(current({ priceQuality: 'stale' }))).toBe(false);
  });
});

describe('isBelowDisplayPrecision', () => {
  it('flags a real change that would round to zero on screen', () => {
    // formatPercent renders this as "0.00%", which asserts the opposite of the
    // data, so the display layer needs to say "<0.01%" instead.
    expect(isBelowDisplayPrecision('0.0040')).toBe(true);
    expect(isBelowDisplayPrecision('-0.0040')).toBe(true);
  });

  it('does not flag an actual zero', () => {
    expect(isBelowDisplayPrecision('0.0000')).toBe(false);
  });

  it('does not flag a change that survives rounding', () => {
    expect(isBelowDisplayPrecision('0.0100')).toBe(false);
    expect(isBelowDisplayPrecision('25.0000')).toBe(false);
  });
});

describe('PERIOD_SECONDS', () => {
  it('names the periods the UI offers', () => {
    expect(PERIOD_SECONDS['24h']).toBe(86_400);
    expect(PERIOD_SECONDS['7d']).toBe(604_800);
  });
});
