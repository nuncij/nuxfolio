# Milestone 3 — first three items

**Status: all three delivered 2026-08-03.** Decisions recorded as ADR-020 (change),
ADR-021 (euro) and ADR-022 (insights). Parent: `DEV_PLAN.md` Milestone 3.

Executable specification for **M3-4** (24 h / 7 d change), **M3-5** (EUR display)
and **M3-3** (insights panel).

All three are keyless. Nothing here needs a new credential, a database, a paid
tier, or an owner decision.

Revised after independent review (`REVIEW_LOG.md` round 6, verdict REVISE, 8
blockers). Where a decision changed, the original reasoning is kept next to it —
several of the blockers were this project's own past mistakes recurring in a new
feature, and that is worth being able to see.

## Measured facts

Probed live on 2026-08-03, not taken from documentation:

| Source                                         | Result                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `coins.llama.fi/prices/historical/{ts}/{refs}` | Batched, same shape as the current-price endpoint: `price`, `confidence`, `timestamp` |
| `coins.llama.fi/percentage/{refs}?period=24h`  | Works, and `7d` too — but returns only a float, no timestamp, no confidence           |
| ECB `eurofxref-daily.xml`                      | Keyless, no registration. `time='2026-07-31'`, `USD rate='1.1485'`                    |

Three consequences that shape the design:

**The returned historical point is not the requested instant.** DefiLlama answers
with the nearest price it has, and its own `timestamp` says when that was. A point
30 hours old labelled "24 h" is a false claim, so the actual `asOf` is retained and
a point further than a stated tolerance from the target is discarded rather than
relabelled.

**`/percentage` is rejected — for one reason, not three.** The original plan gave
three: bare float, hidden prices, cannot suppress on a stale quote. Review pointed
out that only one survives. "Bare float" is no different from the current-price
path, which also parses JSON numbers; and a stale current quote can be suppressed
with `priceQuality` regardless of which endpoint supplied the change. The decisive
objection is that `/percentage` returns **no timestamp and no confidence**, so
there is no way to know whether the figure rests on a usable observation. That is
the whole reason, and it is enough.

**The ECB rate is not "today's rate".** It publishes on TARGET business days only,
so on a Monday the newest file is Friday's — up to **three days old**, more over a
holiday. A EUR figure is a conversion of an estimate at a dated rate: two layers of
approximation, and the UI must say so rather than implying a live FX quote.

## Order of work, and why

Built **in sequence, not in parallel** — the milestone-2 lesson about shared
surfaces. Order corrected on review:

1. **M3-4 first.** It carries the hardest contract: a new provider method, a
   four-state model per period, and deadline behaviour. Establishing that first
   means the other two build on a settled shape.
2. **M3-5 second.** Supplies the display context that M3-3's panel needs.
3. **M3-3 last.** Consumes finalised facts.

The original plan put M3-5 first, arguing that M3-3 and M3-4 would otherwise need
retrofitting for currency. Review noted the dependency was overstated in the other
direction — none of the listed insights cites a change figure — and that M3-4's
contract is the one worth settling earliest. Correct.

| Surface                     | M3-4                          | M3-5                                | M3-3                      |
| --------------------------- | ----------------------------- | ----------------------------------- | ------------------------- |
| `domain/portfolio.ts`       | **owns** — adds `priceChange` | adds response-level `fxRate`        | — (derived, no new field) |
| `providers/types.ts`        | **owns** — historical lookup  | adds `RateProvider`                 | —                         |
| `providers/prices/*`        | **owns** — DefiLlama history  | —                                   | —                         |
| `providers/rates/*`         | —                             | **owns** — new ECB adapter          | —                         |
| `server/portfolioService`   | **owns** — history selection  | fetches the rate under the deadline | —                         |
| `lib/format.ts`             | small-change rendering        | **owns** — currency-aware money     | —                         |
| `lib/displayContext.ts`     | —                             | **owns** — new file                 | —                         |
| `components/AssetTable`     | **owns** — one new column     | formatting only                     | —                         |
| `components/ChainBreakdown` | —                             | **owns** — formatting               | —                         |
| `components/PortfolioView`  | —                             | adds the currency toggle            | **owns** — adds the panel |
| `domain/insights.ts`        | —                             | —                                   | **owns** — new file       |

`server/portfolioService.ts` is listed deliberately: it was missing from the first
draft's table, and it is where the previous milestone's worst selection bug lived.

---

## M3-4 — 24 h / 7 d price change

### The state model

Four states per period, not two. This is round 5's lesson applied before the
mistake rather than after it:

```ts
type ChangeStatus =
  | 'ok'             // a usable observation, and pct is set
  | 'not-requested'  // never asked — deadline, or the asset was not selected
  | 'no-quote'       // asked, and the source had no price
  | 'unusable';      // a price came back but cannot honestly be compared

priceChange: {
  pct: string | null;        // signed decimal string; null unless status is 'ok'
  status: ChangeStatus;
  thenUsd: string | null;    // the historical price, so the UI can show it
  asOf: string | null;       // when that price actually is, per the source
} | null;                    // null = this asset was never in scope at all
```

`not-requested` versus `no-quote` is the distinction round 5 found missing
(F-03), and it cannot be expressed unless the provider says which refs it
actually issued a request for. So the historical lookup returns
`attemptedRefKeys`, exactly as `PriceVerifier` does.

### Provider contract

```ts
fetchHistoricalPrices?(input: {
  chain: ChainConfig;
  refs: readonly PriceRef[];
  atUnixSeconds: number;
  context: ProviderContext;
}): Promise<PriceLookup & { attemptedRefKeys: ReadonlySet<string> }>;
```

Optional, so a price provider that has no history is still a valid provider.

### Which assets, and how many requests

Selected from the **built portfolio**, after spam detection and after the
per-chain cap — reusing the provisional-build pattern `crossCheckPrices` already
uses. Fetching against raw balances would spend requests on assets excluded from
the total, which is precisely the round 5 F-02 defect.

Further filtered to assets whose current quote is `priceQuality === 'ok'`: a
change figure is going to be suppressed for the others anyway, so requesting it
would be pure waste.

The first draft claimed "two extra batched calls per chain". That is false above
60 refs. With `MAX_ASSETS_PER_PORTFOLIO` at 400 the worst case is
`2 × ceil(400/60) = 14` per chain, **70 across five networks**. Bounded by
`PRICE_HISTORY_MAX_ASSETS` (default 50 per chain, ordered by value) so the real
worst case is `2 × ceil(50/60) = 2` per chain, 10 per load — and stated in
`PROVIDERS.md` rather than left to be discovered.

### Honesty rules

- **No figure when the current quote is not `ok`.** Comparing a stale quote to a
  historical one yields a number that looks precise and means nothing.
- **No figure when the current price is `disputed`.** A price can be fresh and
  confident and still contradicted by the second source (ADR-019 keeps both and
  prefers neither). Deriving a precise percentage from the disputed primary asserts
  more than is known. Review caught this; the first draft checked only
  `priceQuality`.
- **A returned point too far from the target is `unusable`, not relabelled.**
  Tolerance: ±6 h for the 24 h figure, ±24 h for the 7 d figure.
- **Historical age is measured against the target, not against `now`.**
  `assessPriceQuality` compares to `now` and would call every legitimate 7-day-old
  observation stale; it must not be reused here unchanged.
- Non-positive or missing historical price ⇒ `no-quote`, never a division.
- The column renders `—` for any status but `ok`. **Never `0.00%`**: zero is a real
  value meaning unchanged, and `formatPercent` rounds to two places, so a genuine
  0.004% would otherwise print as `0.00%` — asserting the opposite of the data.
  Small non-zero changes render `<0.01%` / `>-0.01%`, and negative zero is
  normalised.
- Failure degrades: no history ⇒ every status `not-requested`, one warning,
  portfolio otherwise identical.

### Tests

Sign and magnitude against hand-computed values; stale current price suppresses;
disputed current price suppresses; a point outside tolerance is `unusable`;
missing historical ⇒ `no-quote` not zero; non-positive historical ⇒ no division;
deadline expiry ⇒ `not-requested` and no warning claiming otherwise; a real
0.004% renders `<0.01%` and not `0.00%`; values beyond float precision; one failed
batch leaves the rest intact.

---

## M3-5 — Display currency (EUR alongside USD)

### Design

USD stays the only currency the system computes in. EUR is a **render-time
conversion** applied at the formatting boundary and nowhere else. No stored value,
no provider response and no arithmetic is ever in EUR.

The first draft specified an adapter and a formatter and nothing in between, which
would have led to either a browser→ECB request (leaking a page load to a third
party, against ADR-009's whole posture) or a server request outside the shared
deadline. Corrected:

- **`RateProvider`** in `providers/types.ts`, returning a vendor-neutral
  `FxQuote { base: 'EUR'; quote: 'USD'; rate: string; asOf: string }`. Decimal
  string, not a number.
- **`providers/rates/ecb.ts`** implements it against `eurofxref-daily.xml`.
  Vendor parsing stays in the adapter. `asOf` is **the date in the file**, never
  the fetch time.
- Fetched **server-side, inside the request deadline**, cached for a day.
- Carried on the response as `fxRate: fxQuoteSchema.nullable()` and validated by
  the browser client like everything else.
- **`lib/displayContext.ts`** carries `{ currency, fxRate }` as one immutable
  object threaded to every money-rendering component — `PortfolioSummary`,
  `AssetTable`, `ChainBreakdown`, `InsightsPanel`. A bare
  `formatMoney(value, currency, rate)` cannot carry the rate's date, and
  `ChainBreakdown` was missing from the first draft's surface list, so EUR totals
  could have sat beside unconverted USD network figures.
- One button, persisted in `localStorage` via the same `useSyncExternalStore`
  pattern as the theme toggle (which exists because the effect-based version
  tripped `react-hooks/set-state-in-effect` — ADR-016).

### Honesty rules

- Conversion is `usd / rate` in `Decimal`. ECB quotes EUR as the base
  (1 EUR = 1.1485 USD), so **dividing is correct and multiplying overstates by
  ~32%**. A test pins the direction against a hand-computed figure.
- One persistent page-level disclosure, not a repetition beside every number:
  _"Shown in EUR, converted from USD at the ECB reference rate of 31 Jul 2026
  (1 EUR = 1.1485 USD)."_ Repeating it per figure adds noise without adding truth.
- If the rate cannot be fetched, EUR is unavailable **and a warning says so** —
  `rates.unavailable`. The first draft silently disabled the toggle, which hides a
  failure the user would otherwise be entitled to see (C4).
- A rate older than a week is labelled aged (`rates.aged`) — a threshold well
  beyond any weekend or TARGET holiday, so it fires on a real staleness problem
  rather than on a Monday.
- Rate of zero, negative, or unparseable ⇒ no rate at all, never a division.

### Tests

Direction of conversion against a hand-computed figure; `asOf` read from the file
and not from the clock; a Friday-dated file on a Monday is fine and not aged; a
three-week-old file is aged; malformed XML degrades to no rate; zero and negative
rate rejected; the disclosure names the same date the quote carries.

---

## M3-3 — Rules-based insights panel

### What it states

Facts computed from data already in `Portfolio`. New file `domain/insights.ts`,
pure functions, no provider and no AI.

The domain returns **structured facts with decimal strings** — never formatted
sentences. `lib/format.ts` already imports from `domain/`, so a domain module that
imported the formatter would invert the dependency and break the layering (C3).
Phrasing lives in `components/InsightsPanel.tsx`, which is also the only place
that knows the display currency.

| Insight               | Example                                                     |
| --------------------- | ----------------------------------------------------------- |
| Concentration         | "3 of 12 priced holdings make up 99% of the subtotal"       |
| Largest position      | "wstETH is 33.9% on its own"                                |
| What the value tracks | "35% designed to track ETH, 33% the US dollar, 32% Bitcoin" |
| Network concentration | "99.4% sits on Ethereum Mainnet"                            |
| Not in the figure     | "5 holdings have no price and are outside every share"      |

### Honest universes

Every numerator **and** denominator is the set of **priced, non-suspect** assets,
and the panel names it as the priced subtotal. The first draft would have said
"3 of 55 assets make up 99% of the value": 55 includes unpriced and suspect rows,
and a single unpriced but valuable holding makes "99% of the portfolio"
unsupportable. `pricedAssetCount` is also the wrong denominator — it includes
priced suspects (`normalize.ts`).

Cross-check state is reported as the four states the summary already distinguishes,
not collapsed into "unconfirmed". Collapsing them is round 5 F-01 verbatim.

### Progressive loading

The all-networks view renders each network as it arrives (ADR-015). A panel that
computed cross-network facts from a partial aggregate would state "100% sits on
Ethereum Mainnet" while four networks were still loading — the same class of defect
as round 4's F-02, where an empty state made a claim about networks it had not
read. So:

- cross-network insights (network concentration especially) are **suppressed until
  every network has settled**;
- after settling, if any network is unavailable, every sentence is scoped to the
  networks that could be read, and the unreadable ones are named.

### Classification, which is the real work

**Never by symbol.** A symbol is attacker-controlled — that is the entire premise
of M2-1's spoof detection. Classifying by symbol would let an airdropped fake
re-enter as a risk statement the very figure it was excluded from.

- Keyed by **`(chainId, lowercased address)`**, never address alone: the same
  address is unrelated contracts on different EVM chains.
- Committed registry with provenance and a review date per entry.
- Anything unrecognised is **`unclassified` and shown as such**, with its share, so
  the buckets are never made to look complete when they are not.
- **"Designed to track", not "tracks".** An address proves which instrument
  something is, not that it is currently holding its peg. A depegged stablecoin is
  still classified, and the panel must not imply otherwise.
- Receipt tokens name the wrapper: _"designed to track the US dollar, held as a
  lending receipt"_ for syrupUSDC, not "is a stablecoin". The protocol risk is real
  and a plain balance does not carry it.

Review recommended deferring this insight entirely as the one piece needing a
curated registry. Kept, because on the benchmark wallet it is the single most
informative line the panel produces — a near-exact thirds split across ETH, USD and
BTC that is invisible when scanning rows. The mitigation is the conservative
registry above plus a visible `unclassified` share, so a thin registry degrades to
an honest "we do not know" instead of a wrong bucket.

### Honesty rules

- **Facts, not advice.** "One asset is 33.9% of the subtotal" ships. "You are
  over-concentrated" does not. Where the line is unclear, state the number and stop.
- A portfolio too small to characterise — one priced holding, or none — shows no
  panel rather than a padded one.
- Percentages through `formatPercent`, never `Number`.

### Tests

Concentration on hand-built portfolios including ties, a single asset, and all-
unpriced; denominators proven to exclude suspects and unpriced; classification by
address with a symbol-spoofing asset proving symbol is ignored; the same address on
two chains classified independently; unclassified share reported; cross-network
insights absent while an aggregate is partial and present once settled; decimal
comparison rather than lexical.

---

## Acceptance

`pnpm verify` green; E2E covering the panel, the change column, the EUR toggle and
the partial-aggregate suppression; a live run against the benchmark wallet showing
the panel's real output and real change figures; the ECB rate's date visible; no
value passing through `number`; and a measured request count per load confirming
the history calls stay well inside keyless free-tier behaviour.

---

## Delivered — what was measured

| Criterion                               | Result                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm verify` green                     | 673 unit tests across 32 files; lint, types, production build clean                                                                         |
| E2E green                               | 15 scenarios, four new: the panel, the change column, EUR conversion, no-rate                                                               |
| Change arithmetic independently checked | Locally-computed 24 h figures match DefiLlama's own `/percentage` to the cent on ETH (−1.56 %), wstETH (−1.68 %) and WBTC (−1.04 %)         |
| Change request cost                     | 2 batched requests per chain, 10 per five-network load, all keyless                                                                         |
| EUR direction                           | $103,465.99 → €90,087.93 by dividing at 1.1485; multiplying would give €118,830.69                                                          |
| Rate date surfaced                      | 2026-07-31 on a 2026-08-03 request — three days old, correctly not called aged                                                              |
| Panel on the benchmark wallet           | 3 of 12 priced holdings are 99 % of the subtotal; 35 % ether / 33 % dollar / 32 % bitcoin, with the dollar share named as a lending receipt |
| No value through `number`               | Enforced by the existing discipline plus a new `<0.01%` path for sub-precision changes                                                      |

The one thing worth noting about the panel's output: on this wallet it makes a
near-exact thirds split visible that no amount of scrolling the table would have
shown, which was the entire argument for building it.
