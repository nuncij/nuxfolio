import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import { openSnapshotStore, utcDay, type Snapshot } from './snapshotStore';

/**
 * A real SQLite in memory, not a stand-in for one. The behaviour worth testing here is
 * SQLite's — its type affinity and its conflict handling are where this milestone's two
 * data-destroying findings lived.
 */

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    address: '0xF635aaEE995E61102Dd237Fd3AE66EEAf7EA7054',
    chainId: 1,
    capturedAt: '2026-08-10T09:00:00.000Z',
    totalValueUsd: '17604.90314556',
    netOfAaveDebtUsd: '9523.39497980',
    assetCount: 4,
    pricedCount: 4,
    coverage: 'token-list',
    ...overrides,
  };
}

const store = () => openSnapshotStore(':memory:');

describe('the decimal discipline survives the database', () => {
  it('returns a value with every digit it was given', () => {
    // ADR-003 has kept every value away from a float for five milestones. A column type
    // is the one place that could undo it without anyone noticing.
    const db = store();
    db.record([snapshot({ totalValueUsd: '17604.90314556123456789' })]);

    expect(db.history(snapshot().address)[0]?.totalValueUsd).toBe('17604.90314556123456789');
  });

  it('demonstrates what a NUMERIC column would have done instead', () => {
    // Measured, and the reason the column is TEXT: SQLite's numeric affinity converts
    // decimal text to IEEE-754 and keeps about sixteen significant digits. The value
    // below comes back as a `real`, silently.
    const raw = new DatabaseSync(':memory:');
    raw.exec('CREATE TABLE affinity (v NUMERIC)');
    raw.prepare('INSERT INTO affinity VALUES (?)').run('17604.90314556123456789');

    const row = raw.prepare('SELECT v, typeof(v) AS kind FROM affinity').get();

    expect(row?.kind).toBe('real');
    expect(String(row?.v)).not.toBe('17604.90314556123456789');
    raw.close();
  });

  it('keeps null as null, because nothing priced is not zero', () => {
    const db = store();
    db.record([snapshot({ totalValueUsd: null, netOfAaveDebtUsd: null })]);

    const [row] = db.history(snapshot().address);
    expect(row?.totalValueUsd).toBeNull();
    expect(row?.netOfAaveDebtUsd).toBeNull();
  });
});

describe('a day is the identity, so the job can be re-run', () => {
  it('writes one row when the same day is recorded twice', () => {
    // A retry, a redeploy mid-run, or the job simply running again. Keyed on an instant
    // this would have been two rows and a chart with two points for one day.
    const db = store();
    db.record([snapshot({ capturedAt: '2026-08-10T09:00:00.000Z', totalValueUsd: '100' })]);
    db.record([snapshot({ capturedAt: '2026-08-10T21:30:00.000Z', totalValueUsd: '250' })]);

    const rows = db.history(snapshot().address);
    expect(rows).toHaveLength(1);
    // The later reading wins: it is the more recent truth about that day.
    expect(rows[0]?.totalValueUsd).toBe('250');
    expect(rows[0]?.capturedAt).toBe('2026-08-10T21:30:00.000Z');
  });

  it('keeps separate days apart', () => {
    const db = store();
    db.record([snapshot({ capturedAt: '2026-08-10T09:00:00.000Z' })]);
    db.record([snapshot({ capturedAt: '2026-08-11T09:00:00.000Z' })]);

    expect(db.history(snapshot().address)).toHaveLength(2);
  });

  it('keeps chains apart within a day', () => {
    const db = store();
    db.record([snapshot({ chainId: 1 }), snapshot({ chainId: 8453 })]);

    expect(db.history(snapshot().address).map((row) => row.chainId)).toEqual([1, 8453]);
  });

  it('treats one wallet typed two ways as one wallet', () => {
    const db = store();
    db.record([snapshot({ address: snapshot().address.toUpperCase().replace('0X', '0x') })]);
    db.record([snapshot({ address: snapshot().address.toLowerCase() })]);

    expect(db.history(snapshot().address)).toHaveLength(1);
  });
});

describe('a run is all chains or none', () => {
  it('writes nothing when one chain in the batch is unusable', () => {
    // The round-12 trap with a permanent record: a chain that could not be read must
    // never be stored as a smaller total. The whole batch rolls back.
    const db = store();

    expect(() =>
      db.record([
        snapshot({ chainId: 1 }),
        // `coverage` is NOT NULL, and STRICT tables refuse the wrong type outright.
        snapshot({ chainId: 8453, coverage: null as unknown as string }),
      ]),
    ).toThrow();

    expect(db.history(snapshot().address)).toEqual([]);
  });

  it('leaves an earlier good day intact when a later run fails', () => {
    const db = store();
    db.record([snapshot({ capturedAt: '2026-08-09T09:00:00.000Z' })]);

    expect(() =>
      db.record([
        snapshot({ capturedAt: '2026-08-10T09:00:00.000Z' }),
        snapshot({
          capturedAt: '2026-08-10T09:00:00.000Z',
          chainId: 8453,
          coverage: null as unknown as string,
        }),
      ]),
    ).toThrow();

    const rows = db.history(snapshot().address);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capturedAt).toBe('2026-08-09T09:00:00.000Z');
  });

  it('does nothing at all for an empty run', () => {
    const db = store();
    db.record([]);

    expect(db.history(snapshot().address)).toEqual([]);
  });
});

describe('utcDay', () => {
  it('buckets by UTC rather than by whatever zone the box is in', () => {
    // A schedule in a daylight-saving zone gives a 23-hour day and a 25-hour day each
    // year. UTC gives neither, and the bucket is what the primary key is made of.
    expect(utcDay('2026-08-10T23:59:59.999Z')).toBe('2026-08-10');
    expect(utcDay('2026-08-11T00:00:00.000Z')).toBe('2026-08-11');
  });

  it('refuses something that is not an instant rather than storing a wrong day', () => {
    expect(() => utcDay('yesterday')).toThrow(RangeError);
    expect(() => utcDay('')).toThrow(RangeError);
  });
});

describe('history', () => {
  it('comes back oldest first, so a chart can draw it without sorting', () => {
    const db = store();
    db.record([snapshot({ capturedAt: '2026-08-11T09:00:00.000Z' })]);
    db.record([snapshot({ capturedAt: '2026-08-09T09:00:00.000Z' })]);
    db.record([snapshot({ capturedAt: '2026-08-10T09:00:00.000Z' })]);

    expect(db.history(snapshot().address).map((row) => row.capturedAt.slice(0, 10))).toEqual([
      '2026-08-09',
      '2026-08-10',
      '2026-08-11',
    ]);
  });

  it('is empty for a wallet with no history, which is not an error', () => {
    expect(store().history('0x0000000000000000000000000000000000000001')).toEqual([]);
  });
});

describe('manual entries', () => {
  const entry = {
    id: null,
    label: 'Binance',
    symbol: 'BTC',
    priceRef: 'coingecko:bitcoin',
    quantity: '0.5',
    updatedAt: '2026-08-13T09:00:00.000Z',
  };

  it('inserts, lists, updates and deletes', () => {
    const db = store();

    const id = db.upsertManualEntry(entry);
    expect(id).not.toBeNull();
    expect(db.listManualEntries()).toHaveLength(1);
    expect(db.listManualEntries()[0]).toMatchObject({ label: 'Binance', quantity: '0.5' });

    const updated = db.upsertManualEntry({ ...entry, id, quantity: '0.75' });
    expect(updated).toBe(id);
    expect(db.listManualEntries()[0]?.quantity).toBe('0.75');

    expect(db.deleteManualEntry(id!)).toBe(true);
    expect(db.listManualEntries()).toEqual([]);
  });

  it('refuses to update an id that does not exist, rather than quietly inserting', () => {
    const db = store();
    expect(db.upsertManualEntry({ ...entry, id: 999 })).toBeNull();
    expect(db.listManualEntries()).toEqual([]);
  });

  it('keeps the quantity byte-identical, never a float', () => {
    const db = store();
    const precise = '0.123456789012345678901234567890';
    db.upsertManualEntry({ ...entry, quantity: precise });
    expect(db.listManualEntries()[0]?.quantity).toBe(precise);
  });

  it('deletes exactly one day for one identity', () => {
    const db = store();
    db.record([snapshot({ capturedAt: '2026-08-12T09:00:00.000Z' })]);
    db.record([
      { ...snapshot({ capturedAt: '2026-08-12T09:00:00.000Z' }), address: 'manual', chainId: 0 },
    ]);

    db.deleteDay('manual', '2026-08-12', 0);

    expect(db.history('manual')).toEqual([]);
    expect(db.history(snapshot().address)).toHaveLength(1);
  });
});
