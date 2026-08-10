import 'server-only';

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where a portfolio's history is kept.
 *
 * **SQLite, through Node's own `node:sqlite`.** One writer, one host, roughly 200-byte
 * rows. Postgres on a 3.8 GB box with no swap would want a load test, a connection pool
 * and a memory budget before it could be called safe; ADR-002 named it before the box was
 * measured. The built-in module means this milestone adds no dependency at all.
 *
 * **Decimal values are `TEXT`.** SQLite's numeric affinity converts decimal text to
 * IEEE-754 — measured, not assumed: `'17604.90314556'` in a `NUMERIC` column comes back as
 * a `real`. ADR-003 has kept every value in this product away from a float for five
 * milestones, and a column type would have undone it silently (review round 14, F-2).
 *
 * **A day is the identity, not an instant.** `(address, snapshot_day, chain_id)` means a
 * retry, a redeploy mid-run, or a second visit the same day writes the same row rather
 * than a duplicate. That is what makes the job safe to re-run, which is the difference
 * between a scheduled task that may fail and one that must not.
 *
 * **A run is all chains or none.** A chain that could not be read must never be recorded
 * as a smaller total — the round-12 trap, and this time the record is permanent.
 */

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS portfolio_snapshot (
    address               TEXT    NOT NULL,
    chain_id              INTEGER NOT NULL,
    snapshot_day          TEXT    NOT NULL,
    captured_at           TEXT    NOT NULL,
    total_value_usd       TEXT,
    net_of_aave_debt_usd  TEXT,
    asset_count           INTEGER NOT NULL,
    priced_count          INTEGER NOT NULL,
    coverage              TEXT    NOT NULL,
    PRIMARY KEY (address, snapshot_day, chain_id)
  ) STRICT;
`;

/** One chain's figures at one moment. Decimal strings, exactly as the wire carries them. */
export type Snapshot = {
  readonly address: string;
  readonly chainId: number;
  readonly capturedAt: string;
  /** The priced subtotal. Null is "nothing could be priced", never 0. */
  readonly totalValueUsd: string | null;
  /**
   * Stored beside the subtotal rather than instead of it.
   *
   * They answer different questions — one is what the wallet holds, the other is that
   * minus what it owes Aave (ADR-029) — and a history is the one thing that cannot be
   * backfilled. Recording only one now would start the other's history on the day
   * somebody wanted it.
   */
  readonly netOfAaveDebtUsd: string | null;
  readonly assetCount: number;
  readonly pricedCount: number;
  readonly coverage: string;
};

export type SnapshotStore = {
  /** Writes one day's rows for one wallet, atomically. */
  record: (snapshots: readonly Snapshot[]) => void;
  /** Every snapshot for one address, oldest first. */
  history: (address: string) => readonly Snapshot[];
  close: () => void;
};

/**
 * Opens the store, creating the file and its directory if needed.
 *
 * `:memory:` is passed straight through, which is how the tests get a real SQLite rather
 * than a stand-in for one — the behaviour worth testing here is SQLite's.
 */
export function openSnapshotStore(directory: string): SnapshotStore {
  const path = directory === ':memory:' ? ':memory:' : join(directory, 'snapshots.db');

  if (path !== ':memory:') {
    mkdirSync(directory, { recursive: true });
  }

  const db = new DatabaseSync(path);
  // Readers do not block the writer, which matters because the page reads while the
  // daily job writes.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const insert = db.prepare(`
    INSERT INTO portfolio_snapshot (
      address, chain_id, snapshot_day, captured_at,
      total_value_usd, net_of_aave_debt_usd, asset_count, priced_count, coverage
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (address, snapshot_day, chain_id) DO UPDATE SET
      captured_at          = excluded.captured_at,
      total_value_usd      = excluded.total_value_usd,
      net_of_aave_debt_usd = excluded.net_of_aave_debt_usd,
      asset_count          = excluded.asset_count,
      priced_count         = excluded.priced_count,
      coverage             = excluded.coverage
  `);

  const select = db.prepare(`
    SELECT address, chain_id, snapshot_day, captured_at,
           total_value_usd, net_of_aave_debt_usd, asset_count, priced_count, coverage
    FROM portfolio_snapshot
    WHERE address = ?
    ORDER BY snapshot_day ASC, chain_id ASC
  `);

  return {
    record(snapshots) {
      if (snapshots.length === 0) {
        return;
      }

      // One transaction for the whole run. A crash between chains leaves the day absent
      // rather than half-written, so a re-run finds nothing to reconcile.
      db.exec('BEGIN');
      try {
        for (const snapshot of snapshots) {
          insert.run(
            snapshot.address.toLowerCase(),
            snapshot.chainId,
            utcDay(snapshot.capturedAt),
            snapshot.capturedAt,
            snapshot.totalValueUsd,
            snapshot.netOfAaveDebtUsd,
            snapshot.assetCount,
            snapshot.pricedCount,
            snapshot.coverage,
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    history(address) {
      return select.all(address.toLowerCase()).map((row): Snapshot => ({
        address: String(row.address),
        chainId: Number(row.chain_id),
        capturedAt: String(row.captured_at),
        totalValueUsd: row.total_value_usd === null ? null : String(row.total_value_usd),
        netOfAaveDebtUsd:
          row.net_of_aave_debt_usd === null ? null : String(row.net_of_aave_debt_usd),
        assetCount: Number(row.asset_count),
        pricedCount: Number(row.priced_count),
        coverage: String(row.coverage),
      }));
    },

    close() {
      db.close();
    },
  };
}

/**
 * The UTC calendar day an instant belongs to.
 *
 * UTC rather than local time, and stored rather than derived at read time: a schedule in
 * a zone with daylight saving would otherwise produce a 23-hour day and a 25-hour one
 * each year, and two rows or none would land in the same bucket.
 */
export function utcDay(isoInstant: string): string {
  const day = isoInstant.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new RangeError(`not an ISO 8601 instant: ${isoInstant}`);
  }
  return day;
}
