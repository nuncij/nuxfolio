# M4 — History: the first feature that needs a store

Draft 2026-08-10, revised the same day after review round 14. **Implemented the same
day**: store, daily job, `/api/snapshot`, `/api/history`, the chart, and the host-side
timer. **Deployed and verified 2026-08-11** — every exit criterion in §8 now carries the
measurement that closed it.

---

## 1. The gap this closes

Every load is a live read. The page says what a wallet is worth now and cannot say what it
was worth yesterday. ADR-002 named that as the trigger for introducing a store — **not
before something genuinely needs one**. Something now does.

## 2. Measured before designing

**The box**, read over the tailnet on 2026-08-10: 3,819 MB RAM with **2,755 MB
available**, **no swap**, 38 GB disk with 22 GB free, 2 cores. Already resident: ~1,064 MB,
of which a 475 MB `node` belongs to another project and 154 MB is Nuxfolio.

**No swap is the constraint.** If the box exceeds 3.8 GB the OOM killer picks a victim and
need not pick the newcomer.

**A snapshot is almost entirely its asset list.** For a 362-asset wallet the single-chain
response is 195 KB, of which the `assets` array is **99 %**. Everything a chart needs —
total, counts, coverage, timestamp — is about 2 KB. A 4-asset wallet is 6 KB in total.

> The first draft said "98 %" and quoted a 210 KB payload in prose against 195 KB in its
> own table. Both were wrong, from one hurried sample. Round 8 recorded that the most
> dangerous sentence in a plan is the confident quantitative one; this is the fourth time
> that has been demonstrated on my own writing.

**The server has no watchlist.** Saved wallets live in `localStorage` by **ADR-023**. There
is no list for a cron to iterate. (The first draft credited this to ADR-009, which is
about not disclosing to third-party image hosts — wrong ADR, right constraint.)

## 3. Four decisions, each choosing the smaller thing

### SQLite, not Postgres

One writer, ~200-byte rows, one process, one host. Postgres brings a daemon, a memory
floor, a connection pool and a second service to operate — on a box with no swap. ADR-002
named Postgres before the box was known and before the row was measured.

**If the deployment ever becomes two instances this must be revisited**, along with the
shared cache and rate limiter ADR-007 already defers. It is one host today.

### The database file lives outside the app directory

`scripts/deploy.sh` runs `rsync --delete` into the app directory. A database there would
be **deleted on the next deploy**. It goes in its own directory with its own systemd write
permission.

### Decimal values are stored as TEXT

SQLite's numeric affinity converts decimal text to IEEE-754 and keeps ~16 significant
digits. ADR-003 has kept every value away from a float for five milestones; a column type
would undo it silently. Totals are summed by the existing `Decimal` path at read time.

### The watchlist is a fixed list in configuration

Not a "track this wallet" button. The owner's own addresses, in a config file, the same
shape as `aaveMarkets.ts`.

This is the decision that makes the rest small. A user-facing track action would need
authentication, a cardinality cap, abuse controls, an untrack path, deletion
authorisation and a rule for who may erase whose history — on a private, tailnet-only
site with one user. A config list has none of those questions, because a stranger cannot
add a row.

It also bounds the cron exactly: the work is whatever the list says, and the list is
short.

## 4. The shape

```sql
CREATE TABLE portfolio_snapshot (
  address          TEXT    NOT NULL,   -- lowercase, validated before it gets here
  chain_id         INTEGER NOT NULL,
  snapshot_day     TEXT    NOT NULL,   -- UTC date, 'YYYY-MM-DD'
  captured_at      TEXT    NOT NULL,   -- UTC instant, ISO 8601
  total_value_usd  TEXT,               -- decimal string; null is "nothing priced", never 0
  asset_count      INTEGER NOT NULL,
  priced_count     INTEGER NOT NULL,
  coverage         TEXT    NOT NULL,
  PRIMARY KEY (address, snapshot_day, chain_id)
);
```

**Keyed on the UTC day, not the instant.** A retry, a redeploy mid-run or a second visit
the same day writes the same row rather than a duplicate. This is what makes the job safe
to re-run, which matters more than it sounds: it is the difference between a cron that can
fail and one that must not.

**One run writes all five chains or none.** A chain that could not be read must never be
recorded as a smaller total — the round-12 trap, with a permanent record this time. Both
tables are written in one transaction.

**No payload column.** 99 % of it is an asset list the chart never reads, and on this disk
a daily blob for even a handful of wallets is measured in gigabytes a year while the narrow
row is measured in megabytes.

> **The cost, accepted explicitly:** the composition of a past portfolio is gone. If a
> later feature wants "which asset moved?", its history starts the day that feature ships,
> not today. Worth it — the alternative is paying for it now, forever, on a 22 GB disk, on
> the chance it is wanted.

## 5. The chart

**Real snapshots only in v1.** Sparse, and every point means what the chart says.

The roadmap's second line — today's holdings valued at historical prices — answers a
different question ("what would today's holdings have been worth then?") and is wrong for
every day the balances differed. It is the larger half of M4-3 and the half that can
mislead. It gets its own decision once there is a real chart to compare it against.

The empty state says history starts when tracking does, and every deploy starts one
snapshot run — joining the list means changing the environment, which means deploying —
so a tracked wallet has its first row the day it joins, not at the next 04:17.

## 6. What this deliberately does not do

Named so the omissions are choices rather than oversights:

- **No track button, no accounts, no deletion workflow.** §3 explains why; they return the
  day the site is public, together.
- **No retention policy beyond "keep it".** At megabytes a year, a cut-off would be
  machinery that never fires. Revisit if the list grows.
- **No metric versioning, no run/completeness table.** All-or-nothing runs make the second
  unnecessary; the first is worth having only once a stored number has changed meaning.
- **No off-box backup in v1** — but the file is small enough that one is cheap, and a
  restore should be performed once before this is called done. _Both exist as of
  2026-08-11: the restore was performed (§8), and the snapshot service now writes a
  dated copy after every reading (`scripts/snapshot-backup.sh`, newest 14 kept on the
  box) which the workstation pulls off-box daily and on every deploy
  (`scripts/backup-pull.sh` — pulls never delete, so the deep history accumulates
  where the box's disk cannot take it)._

## 7. What is still uncertain

1. **What the daily job actually costs.** Even a short list is a full provider fan-out per
   chain: ~33 balance RPC calls per wallet on the keyless path, ~38 more for Aave's seven
   markets, plus prices and FX. Codex's estimate for a hundred wallets exceeded ADR-019's
   CoinGecko quota by itself. **The job should skip the enrichments the snapshot does not
   store** — cross-check, price history, FX — and that needs measuring before it is
   scheduled, not after. _Resolved: the lean load skips all three and was measured at
   2,800 ms against the page's 9,359 ms for the benchmark wallet._
2. **Peak memory, not one reading.** 2,755 MB available was a single sample. SQLite makes
   this far less pressing than Postgres would have, but the neighbour is 475 MB and may
   grow.
3. **Which total is the history.** `totalValueUsd` is a priced subtotal, and M5 added
   `netOfAaveDebtUsd` beside it. Storing the first without naming it is how a chart quietly
   becomes "net worth". Decide before the first row is written. _Resolved: both are
   stored, because a history is the one thing that cannot be backfilled — recording only
   one would start the other's history on the day somebody wanted it._

## 8. Exit criteria — all verified 2026-08-11

- A chart for a configured wallet, from real snapshots, with an honest empty state.
  _Verified: the tracked wallet's chart renders from the production row; an untracked
  address gets `{"points":[]}`, identical to a wallet with no history._
- Re-running the job the same day changes no row and adds none.
  _Verified in production: three runs on 2026-08-11 (one manual, two deploy kicks) left
  exactly five rows for the day._
- A run where one chain fails writes nothing for that day, and the page says why.
  _Verified by unit test; the chart draws such a day as a break in the line._
- The database survives a deploy — verified by deploying, not by assuming.
  _Verified: same inode (410907) and identical rows before and after a second deploy._
- A restore from backup performed once.
  _Performed: WAL checkpoint, copy to `~/nuxfolio/backup/`, live file deleted, API
  answered `{"points":[]}` (the app survives losing the store), backup copied into
  place, API response matched the pre-drill response byte for byte._
- `totalValueUsd` stays byte-identical for every existing test: this milestone records a
  number, it does not change one. _The suite passed unchanged throughout._

What deploying then found that the review had not: the timer unit's quoted `-K -` curl
config reached sh with its escaped quotes eaten — systemd interprets C-style escapes
inside quoted `ExecStart` arguments — so the header matched nothing and the first kick
failed 404. And the round-15 "Node 24 floor" refused the box's working Node 22.23.2, so
the preflight now probes `node:sqlite` itself instead of trusting a version table. Both
fixes exist because the criterion said _verified by deploying_.
