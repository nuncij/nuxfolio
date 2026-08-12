# Manual entries — the balances no chain can confirm

Draft 2026-08-12, revised the same day after review round 16. This is the "Manual
entries" item from milestone 6 (`DEV_PLAN.md`), unblocked by M4's store. Written before
any code, per the process that has caught a blocker at plan stage in rounds 6, 7, 8 and
14 — and did again here: the first draft priced entries through "the existing DefiLlama
passthrough path", which turned out to accept only chain+address refs. The path this
plan now names had to be designed, not assumed.

---

## 1. The gap this closes

Nuxfolio reads what public chains say a wallet holds. It cannot see a Binance balance, a
Kraken balance, or a cold-storage wallet the owner prefers never to type into a browser.
For this owner those are real money, so today the headline number is not their net worth
and cannot become it by reading chains harder.

The feature is one table of **user-asserted rows**: "Binance: 0.5 BTC". Nuxfolio prices
them with the same market data it already uses, and never pretends it verified the
quantity — that is the whole design constraint, stated in the roadmap since day one:
_entries are user-asserted and must be visually distinct from chain-verified data_.

## 2. The shape

### One table, in the store M4 built

```sql
CREATE TABLE manual_entry (
  id          INTEGER PRIMARY KEY,
  label       TEXT NOT NULL,     -- where it is: "Binance", "Ledger in the drawer"
  symbol      TEXT NOT NULL,     -- what a person calls it: "BTC"
  price_ref   TEXT,              -- DefiLlama ref, e.g. 'coingecko:bitcoin'; null = unpriceable
  quantity    TEXT NOT NULL,     -- decimal string, ADR-003 as everywhere
  updated_at  TEXT NOT NULL      -- ISO instant; the UI shows this, see §4
) STRICT;
```

Same SQLite file as the snapshots, same rules: decimals as `TEXT`, no floats anywhere.
No soft deletes, no audit trail — one owner editing their own numbers.

### Priced by reference, not by trust

An entry carries a `price_ref` — `coingecko:<id>`, the namespace DefiLlama's endpoint
already answers keylessly (measured live 2026-08-12: `coingecko:bitcoin`,
`coingecko:polygon-ecosystem-token` and friends all return price + timestamp +
confidence).

**The adapter seam this needs does not exist yet and is the first thing to build**
(round 16's one blocker): today's DefiLlama provider accepts only EVM chain+address
refs and derives `coingecko:` ids internally for natives. v1 adds one small function to
that provider — take a list of raw refs, query `prices/current`, return the same quote
shape every other price gets, run through the existing `assessPriceQuality` so
staleness and confidence flags mean the same thing they mean everywhere else.

Two consequences stated now rather than discovered: the **CoinGecko cross-check does
not cover manual entries in v1** — they render as unchecked (`priceCheck: null`), never
as agreed — and writes validate the quantity through the same decimal parser as
everything else (positive, plain decimal string, rejected otherwise, ADR-003).

The quantity is asserted; the price is not. That split is what keeps this honest: the
one number Nuxfolio cannot check is labelled as the owner's, and the number it can check
comes from where every other price comes from.

### Writes are key-gated; reads are not

`GET /api/manual` answers like the rest of the site — the tailnet can read every page
already. Writes (`POST`/`DELETE`) require `x-manual-key` matching a new
`NUXFOLIO_EDIT_KEY` env var, compared constant-time, 404 when absent or wrong — the
`/api/snapshot` posture exactly, which means all of it (round 16): the key joins the
typed env schema with a minimum length, the secret-redaction list, `.env.example`, and
the write routes get contract tests like the snapshot route's. A separate key rather
than reusing the snapshot one: the timer's key lives in a systemd unit's environment
and rotating one must not break the other.

The page asks for the key once and keeps it in `localStorage` (browser-local preference,
ADR-023's side of the line). Anyone on the tailnet can _see_ the entries; only a browser
the owner unlocked can change them. Accepted residual: the tailnet is the owner's own
devices, and a stolen tailnet device is a bigger problem than this table.

### A page of its own, not a stowaway on wallet pages

Entries render at `/manual`, linked from the landing page. They never appear on
`/portfolio/<address>` — a wallet page answers "what does this address hold", and
folding the owner's exchange balances into whatever address happens to be typed would
be wrong for every address except the owner's own.

The page shows the rows, each row's live valuation, a total for the section, and the
grand total is deferred: combining "your wallets + your entries" properly belongs to the
bundle view and lands only if it stays small (§6).

The page renders inside the same `DisplayProvider` seam as the portfolio pages, with
the ECB rate fetched the same way — the owner's EUR preference works here or the page
is lying about being part of the product (round 16). Values are USD internally, as
everywhere.

## 3. Recorded daily, because history cannot be backfilled

The snapshot job writes one pseudo-row per day for the manual total — address
`manual`, `chain_id 0` — independent of the wallet loop, so an empty tracked list does
not skip it (round 16: the route currently returns early on zero wallets). Cost: one
insert and one priced read a day. Without it, the day somebody wants an "everything I
own" chart is the day its history starts; with it, the chart is already waiting. The
pseudo-address is unreachable through `/api/history` — it fails address validation, and
the store's exact-address select means it cannot leak into any wallet's series
(verified against the code in round 16). v1 records, it does not yet draw.

**The full row shape, fixed now because it cannot be backfilled:** `totalValueUsd` =
sum of priced entries (null when none priced); `netOfAaveDebtUsd` = the same figure,
because a reported balance owes Aave nothing and round 15 already established that a
debt-free total _is_ its net; `assetCount` = number of entries; `pricedCount` = entries
whose ref resolved; `coverage` = `'manual'`.

**Deletion has semantics too:** when the last entry is deleted, the same day's rerun
must remove the pseudo-row, not leave yesterday's total standing — the store gains a
one-day delete for exactly this, and "no entries" writes nothing, matching M4's "an
empty list means the feature is off".

## 4. What the UI must say

- Every entry row carries a visible **"reported by you"** marker and its `updated_at`
  date — "as you reported on 2026-08-12" — because a stale assertion is the one failure
  mode this feature adds.
- The section's framing sentence states the rule: _quantities are yours, prices are the
  market's, and Nuxfolio verified neither the balance nor where it is held._
- Styling is visibly different from chain-verified tables (the existing muted/dashed
  treatment used for suspect rows is the vocabulary to reuse), and manual values never
  mix into any chain-verified subtotal.
- **The product's global honesty copy changes with this feature** (round 16): the
  layout and landing page currently say Nuxfolio "reads public chain data only", which
  stops being the whole truth the day it also stores balances the owner reported.
  One clause — "…plus balances you report yourself, always marked as yours" — keeps
  the sentence true everywhere, not just on `/manual`.

## 5. What this deliberately does not do

- **No fiat rows.** "€2,000 cash" has no price ref and no place in a crypto tracker's
  price pipeline; a stablecoin entry is the workaround if wanted.
- **No per-exchange API integration.** Reading Binance's API is a different feature
  with credentials, quotas and a vendor surface; this is a notebook, not a connector.
- **No multi-user anything.** One key, one owner, tailnet-only — the round-14 lesson.
- **No edit history.** `updated_at` says when; git-style history of one person's own
  assertions is machinery without a customer.

## 6. Open questions, with proposed answers

1. **Does the bundle view learn about entries in v1?** Proposed: no — ship `/manual`
   first, and only add a labelled "including reported balances" line to the bundle page
   if it needs no new state shape. The moment it needs one, it is its own item.
2. **Which refs does the form accept?** Free text, validated for `coingecko:<id>`
   syntax only. The first draft proposed resolving the ref against DefiLlama at save
   time; round 16 argued to cut it — it adds an upstream failure state to every write
   for a typo the next render exposes anyway, as an honestly-unpriced row the owner is
   looking straight at. Cut.
3. **Snapshot pseudo-row when there are no entries?** No row, and a same-day rerun
   deletes a stale one (§3).

## 7. Exit criteria

- An entry created, edited and deleted from `/manual`, surviving a deploy and a
  restore, priced live with the same flags as everything else.
- A wrong or missing edit key gets 404 on every write, verified by contract tests like
  the snapshot route's.
- The manual total appears in the next day's snapshot as the pseudo-row, and re-running
  the day rewrites it.
- A screenshot where a chain-verified table and the manual section are visibly
  different at a glance, without reading any copy.
- `pnpm verify` and the E2E suite green throughout.
