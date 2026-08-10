# M4 — History: the first feature that needs a store

Draft for review, 2026-08-10. Written before any schema, per the process that caught a
blocker at plan stage in rounds 6, 7, 8 and 12 — and twice caught a plan claim that was
factually wrong about this codebase.

---

## 1. The gap this closes

Every load is a live read. The page can say what a wallet is worth now and cannot say
what it was worth yesterday. "How has it changed?" is the last question in the original
brief that the product cannot answer at all, and ADR-002 named it as the trigger for
introducing a store: **not before something genuinely needs one**.

Something now does.

## 2. Measured before designing

Four things checked against the real box and the real payloads, because every decision
below depends on them.

**The target.** Read over the tailnet on 2026-08-10:

|                  |                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| RAM              | 3,819 MB total, **2,755 MB available**                                                            |
| Swap             | **none**                                                                                          |
| Disk             | 38 GB, 22 GB free                                                                                 |
| CPU              | 2 cores                                                                                           |
| Already resident | ~1,063 MB — a 475 MB `node` (another project), Nuxfolio's 154 MB `next-server`, Caddy, tailscaled |

**No swap is the constraint that matters.** There is headroom for a modest Postgres, but
no cushion: if it and the neighbours exceed 3.8 GB, the OOM killer chooses a victim, and
it may not choose Postgres. Any configuration has to be sized deliberately rather than
left at defaults.

**A snapshot is almost entirely its asset list.** Measured against the live API:

| Wallet     | Raw    | Gzipped |
| ---------- | ------ | ------- |
| 4 assets   | 6 KB   | 1 KB    |
| 362 assets | 195 KB | 30 KB   |

Of a 210 KB payload, **208 KB is the `assets` array — 98 %**. Every field the chart needs
— `totalValueUsd`, `assetCount`, `fetchedAt`, the coverage flags — comes to **2 KB**.

**The server does not know which wallets anyone cares about.** M4-2 says "a daily cron for
watchlisted addresses". There is no such list: saved wallets live in `localStorage` and
`useSavedWallets.ts` says so explicitly, because ADR-009 kept the server from learning who
is looking at what. The cron as written cannot be built without first deciding to collect
something this project has deliberately not collected.

## 3. The headline: store the summary, not the payload

M4-2 proposes persisting `(address, chainId, totalValueUsd, assetCount, fetchedAt,
payload)` on **each uncached load**. Two halves of that are wrong for this box.

**The payload.** At 30 KB gzipped for a large wallet, a daily snapshot per chain is
55 MB per wallet per year — 5.5 GB for a hundred wallets, against 22 GB free that
Postgres, its WAL and everything else already share. And 98 % of those bytes are an asset
list the chart never reads.

**"Each uncached load" is unbounded.** The API is public. Anyone can request any address
on any chain, and every request that misses the cache would write a row. That is not a
snapshot policy, it is an invitation.

**Decision: one narrow row per snapshot, ~200 bytes of columns, no payload blob.** At that
size, a daily snapshot for a hundred wallets across five chains is **36 MB a year**, and
the retention question becomes a preference rather than a constraint. If a future feature
needs the composition of a past portfolio, that is a second table with its own decision,
not a column added now on the chance it is wanted.

## 4. The privacy decision this milestone forces

A snapshot table is **a record of which addresses have been looked at, and when**. Nothing
in this product currently keeps one. ADR-009 kept a browser from telling a third party
that someone is viewing a portfolio; a snapshot table lets the server tell _itself_.

That is not an argument against the feature. It is an argument that the trigger must be
chosen rather than defaulted to "every load", and the options differ in kind:

| Trigger                        | What the server ends up knowing           |
| ------------------------------ | ----------------------------------------- |
| Every uncached load            | Every address anyone ever viewed, forever |
| An explicit opt-in per address | Only addresses somebody asked to track    |
| A fixed list in configuration  | Only the owner's own wallets              |

**Proposed: explicit opt-in, address-scoped.** A "track this wallet" action writes the
address to the snapshot table's own watchlist and starts the daily job for it. No opt-in,
no row. This also solves §2's cron problem without inventing a server-side account
system, and it keeps the honest answer available on the page: _history begins when you
ask for it_, which is a sentence a user can act on.

## 5. The shape

```sql
-- Addresses somebody asked to track. The whole watchlist, and the only place the
-- server learns an address is interesting.
CREATE TABLE tracked_wallet (
  address     TEXT PRIMARY KEY,          -- lowercase, validated before it gets here
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per address per chain per snapshot. Deliberately narrow.
CREATE TABLE portfolio_snapshot (
  address           TEXT        NOT NULL,
  chain_id          INTEGER     NOT NULL,
  captured_at       TIMESTAMPTZ NOT NULL,
  total_value_usd   NUMERIC,               -- null is "nothing could be priced", never 0
  asset_count       INTEGER     NOT NULL,
  priced_count      INTEGER     NOT NULL,
  coverage          TEXT        NOT NULL,  -- the same enum the wire carries
  PRIMARY KEY (address, chain_id, captured_at)
);
```

**`NUMERIC`, not `double precision`.** ADR-003 has kept every value away from a float for
five milestones; a column type would undo it silently. **`total_value_usd` is nullable**
for the same reason the wire field is: nothing priced is not zero.

**`coverage` travels with the number**, so a chart can mark the points taken while an
indexer was missing rather than drawing them as if they were comparable.

## 6. The chart, and the line that is not a measurement

M4-3 wants two series, and the second one is the dangerous one.

- **Snapshots** — exact, and sparse. What was actually recorded.
- **Reconstruction** — today's holdings valued at historical prices. Dense, and **wrong
  for every day the balances differed from today's**. A wallet that sold everything last
  week reconstructs as though it still holds it.

The plan calls the caveat non-negotiable and it is right. The two must be distinguishable
without reading a legend: different line style, different colour, and a sentence that
says what the second one is. This is the honest-uncertainty pattern applied to time, and
it is the same rule as `priceQuality` and `priceCheck` — **a figure that is estimated says
so next to itself**.

**Open question: is the reconstruction worth building at all in v1?** It is the larger
half of M4-3, it is the half that can mislead, and a chart of real snapshots that starts
empty and fills in is honest from the first day. Recommended: **ship snapshots alone**,
and treat the reconstruction as its own decision once there is a real chart to compare it
against.

## 7. What is still uncertain

1. **Can Postgres live on this box at all?** 2,755 MB available today, no swap, a 475 MB
   neighbour that may grow. Needs a sized configuration — `shared_buffers`, `work_mem`,
   `max_connections` — and a measurement under load, not a default install.
2. **Or should the store be SQLite?** One writer, tiny rows, no network, no daemon, no
   memory floor. ADR-002 named Postgres, but it named it before the box was known and
   before the row was measured at 200 bytes. This deserves an explicit comparison rather
   than an inherited answer.
3. **Backups.** A store that holds the only copy of something needs one, and the box has
   22 GB and no backup story in the infra docs.
4. **Migrations.** The first schema change with data in it is the first genuinely
   irreversible operation this project has ever performed.
5. **What a snapshot means when a chain failed.** A partial read must not be recorded as
   a smaller total — the same trap as `sumPortfolioTotals` in round 12, now with a
   permanent record.

## 8. Exit criteria

- A chart on a tracked wallet's page, built from real snapshots, with an empty state that
  says history starts when tracking does.
- A snapshot taken while one chain was unreadable is either not written or marked, never
  recorded as a smaller total.
- Storage growth measured against a real month, not projected from one day.
- The store survives a redeploy, and a documented restore has been performed once.
- `totalValueUsd` remains byte-identical for every existing test: this milestone adds a
  record, it does not touch what the number means.
