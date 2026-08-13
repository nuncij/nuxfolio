import { describe, expect, it } from 'vitest';

import type { PriceQuote } from '@/providers/types';
import type { ManualEntry } from '@/server/snapshotStore';

import { manualEntryInputSchema, valueManualEntries } from './manual';

const NOW = Date.parse('2026-08-13T09:00:00.000Z');
const OPTIONS = { now: NOW, confidenceMin: 0.7, maxAgeSeconds: 3_600 };

function entry(overrides: Partial<ManualEntry> = {}): ManualEntry {
  return {
    id: 1,
    label: 'Binance',
    symbol: 'BTC',
    priceRef: 'coingecko:bitcoin',
    quantity: '0.5',
    updatedAt: '2026-08-13T08:00:00.000Z',
    ...overrides,
  };
}

function quote(overrides: Partial<PriceQuote> = {}): PriceQuote {
  return {
    priceUsd: '60000',
    updatedAt: '2026-08-13T08:59:00.000Z',
    confidence: 0.99,
    ...overrides,
  };
}

describe('valueManualEntries', () => {
  it('multiplies the asserted quantity by the market price', () => {
    const valued = valueManualEntries(
      [entry()],
      new Map([['coingecko:bitcoin', quote()]]),
      OPTIONS,
    );

    expect(valued.entries[0]).toMatchObject({ valueUsd: '30000.00000000', priceQuality: 'ok' });
    expect(valued.totalValueUsd).toBe('30000.00000000');
    expect(valued.pricedCount).toBe(1);
  });

  it('renders a missing ref as unpriced, never as zero', () => {
    const valued = valueManualEntries([entry({ priceRef: null })], new Map(), OPTIONS);

    expect(valued.entries[0]).toMatchObject({ valueUsd: null, priceUsd: null });
    expect(valued.totalValueUsd).toBeNull();
    expect(valued.pricedCount).toBe(0);
  });

  it('sums only what was priced, and flags a stale quote like everywhere else', () => {
    const valued = valueManualEntries(
      [entry(), entry({ id: 2, label: 'Kraken', priceRef: 'coingecko:nonsense' })],
      new Map([['coingecko:bitcoin', quote({ updatedAt: '2026-08-13T06:00:00.000Z' })]]),
      OPTIONS,
    );

    expect(valued.entries[0]?.priceQuality).toBe('stale');
    expect(valued.entries[1]?.valueUsd).toBeNull();
    expect(valued.totalValueUsd).toBe('30000.00000000');
  });

  it('matches refs case-insensitively, because vendors echo casing freely', () => {
    const valued = valueManualEntries(
      [entry({ priceRef: 'coingecko:bitcoin' })],
      new Map([['coingecko:bitcoin', quote()]]),
      OPTIONS,
    );
    expect(valued.pricedCount).toBe(1);
  });
});

describe('manualEntryInputSchema', () => {
  const valid = { label: 'Binance', symbol: 'BTC', quantity: '0.5', priceRef: 'coingecko:bitcoin' };

  it('accepts a well-formed entry and defaults the id to null', () => {
    const parsed = manualEntryInputSchema.parse(valid);
    expect(parsed.id).toBeNull();
    expect(parsed.priceRef).toBe('coingecko:bitcoin');
  });

  it.each([
    ['a negative quantity', { ...valid, quantity: '-1' }],
    ['a zero quantity', { ...valid, quantity: '0' }],
    ['a float-ish quantity', { ...valid, quantity: '1e18' }],
    ['an empty label', { ...valid, label: ' ' }],
    ['a ref outside the namespace', { ...valid, priceRef: 'ethereum:0xdead' }],
    ['a ref with uppercase', { ...valid, priceRef: 'coingecko:Bitcoin' }],
  ])('refuses %s', (_name, input) => {
    expect(manualEntryInputSchema.safeParse(input).success).toBe(false);
  });

  it('accepts a null ref: an unpriceable entry is honest, not invalid', () => {
    expect(manualEntryInputSchema.parse({ ...valid, priceRef: null }).priceRef).toBeNull();
  });
});
