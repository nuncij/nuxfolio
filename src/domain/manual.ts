import { z } from 'zod';

import type { PriceQuote } from '@/providers/types';
import type { ManualEntry } from '@/server/snapshotStore';

import { isDecimalString, isPositive, multiplyToMoney, sumMoney } from './money';
import { assessPriceQuality } from './normalize';
import type { PriceQuality } from './portfolio';

/**
 * The shape a manual entry's price reference must have. Only DefiLlama's
 * CoinGecko passthrough namespace — the same one natives are priced through —
 * because it is the one namespace with an identity that is not a chain
 * address. Defined here rather than in the provider, because the browser form
 * validates against it too and must not drag a server module into the bundle.
 */
export const MANUAL_PRICE_REF_PATTERN = /^coingecko:[a-z0-9][a-z0-9-]*$/;

/**
 * Manual entries: balances the owner asserted, valued at market prices.
 *
 * The split this module enforces is the feature's whole honesty story: the
 * quantity is the owner's claim and is never verified; the price comes from the
 * same provider as every other price and carries the same quality flags. The
 * two are multiplied, never blended — a row is "your 0.5 BTC at the market's
 * $60,000", not "your $30,000".
 */

/** What a saved entry looks like once priced. */
export type ValuedManualEntry = ManualEntry & {
  readonly priceUsd: string | null;
  readonly valueUsd: string | null;
  readonly priceQuality: PriceQuality | null;
  readonly priceUpdatedAt: string | null;
};

export type ValuedManualEntries = {
  readonly entries: readonly ValuedManualEntry[];
  /** Sum of the priced rows; null when nothing could be priced. Null is not zero. */
  readonly totalValueUsd: string | null;
  readonly pricedCount: number;
};

/**
 * What a write must look like. Rejected loudly rather than coerced: a manual
 * entry is the one number Nuxfolio cannot cross-check, so the least it can do
 * is refuse one that is not even well-formed (round 16).
 */
export const manualEntryInputSchema = z.object({
  id: z.number().int().positive().nullable().default(null),
  label: z.string().trim().min(1).max(80),
  symbol: z.string().trim().min(1).max(20),
  priceRef: z
    .string()
    .trim()
    .regex(MANUAL_PRICE_REF_PATTERN, 'expected coingecko:<id>')
    .max(80)
    .nullable()
    .default(null),
  quantity: z
    .string()
    .trim()
    // One refinement, not two chained: zod runs every refinement even after one
    // fails, and isPositive throws on a string that is not a decimal at all.
    .refine(
      (value) => isDecimalString(value) && isPositive(value),
      'expected a positive plain decimal string',
    ),
});

export type ManualEntryInput = z.infer<typeof manualEntryInputSchema>;

export function valueManualEntries(
  entries: readonly ManualEntry[],
  quotes: ReadonlyMap<string, PriceQuote>,
  options: { now: number; confidenceMin: number; maxAgeSeconds: number },
): ValuedManualEntries {
  const valued = entries.map((entry): ValuedManualEntry => {
    const quote = entry.priceRef === null ? undefined : quotes.get(entry.priceRef.toLowerCase());
    if (quote === undefined) {
      return { ...entry, priceUsd: null, valueUsd: null, priceQuality: null, priceUpdatedAt: null };
    }
    return {
      ...entry,
      priceUsd: quote.priceUsd,
      valueUsd: multiplyToMoney(entry.quantity, quote.priceUsd),
      priceQuality: assessPriceQuality(quote, options),
      priceUpdatedAt: quote.updatedAt,
    };
  });

  const pricedValues = valued
    .map((entry) => entry.valueUsd)
    .filter((value): value is string => value !== null);

  return {
    entries: valued,
    totalValueUsd: pricedValues.length === 0 ? null : sumMoney(pricedValues),
    pricedCount: pricedValues.length,
  };
}
