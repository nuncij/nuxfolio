# M2-2 — Price cross-check

**Status: delivered 2026-07-31.** Parent: `DEV_PLAN.md` Milestone 2, item M2-2.
The decision is recorded as ADR-019; this file is kept as the spec that was built
against, including the one place a live run proved it wrong (see
[Where this spec was wrong](#where-this-spec-was-wrong)).

## Problem

Every price in Nuxfolio comes from one source. ADR-005 records the consequence
plainly: _"a single price source with no cross-check"_. A wrong quote is
therefore trusted, and the product's whole premise is that it does not quietly
assert things it cannot support.

The `priceQuality` flags handle _declared_ uncertainty — a provider telling us a
quote is old or low-confidence. They cannot detect a quote that is confidently
wrong. Only a second opinion can.

## Measured facts

Probed live on 2026-07-31, not assumed:

| Fact                                       | Value                                                              |
| ------------------------------------------ | ------------------------------------------------------------------ |
| Contract addresses per call, keyless       | 1 (`error_code 10012`)                                             |
| Contract addresses per call, with Demo key | 175 verified working                                               |
| Failure mode above that                    | `HTTP 414`, **HTML body, not JSON** — nginx URI limit, ~8 KB       |
| Demo quota                                 | 100 calls/min, 10,000 calls/month                                  |
| Attribution                                | **Required**: "Powered by CoinGecko API" + link, ≥10 pt            |
| Auth                                       | `x-cg-demo-api-key` header (confirmed; 401 + `10002` when invalid) |

Two consequences for the design. Chunk at **100 addresses**, not near the
ceiling — the real limit is a web-server config that could change, and a 414
arrives as unparseable HTML rather than an error we could branch on. And the
quota is finite, so cross-checking cannot be indiscriminate.

## Design

### Not a second `PriceProvider` in the registry

The existing `PriceProvider` interface answers "what is this worth". Selecting
CoinGecko _instead of_ DefiLlama would lose the confidence scores and timestamps
that the honesty flags depend on. So CoinGecko is added as a **verifier layered
over** the primary lookup, not an alternative to it:

```ts
interface PriceVerifier {
  readonly id: string;
  /** Second opinions for the refs worth checking. Absent = no opinion offered. */
  verify(input: {
    chain: ChainConfig;
    refs: readonly PriceRef[];
    context: ProviderContext;
  }): Promise<PriceLookup>;
}
```

Deliberately the same return shape as `PriceProvider`, so the comparison is
between like and like and a future third source needs no new type.

_As shipped_, `verify` returns a `PriceVerification` — that same shape plus
`attemptedRefKeys`, the set of refs a request was actually made for. The spec had
no way to distinguish "asked, no answer" from "never asked", and review found that
gap; see [Where this spec was wrong](#where-this-spec-was-wrong).

### Which assets get checked

Not all of them. A disagreement on a $3 dust holding changes no decision; one on
a $36,000 position changes the headline figure. So the verifier is asked only
about assets whose value is **material to the total**:

- assets are sorted by value descending;
- the ones making up the first `PRICE_CROSSCHECK_COVERAGE` (default `0.95`) of
  the priced subtotal are selected;
- capped at `PRICE_CROSSCHECK_MAX_ASSETS` (default `25`) per chain.

On the benchmark wallet that is 3–4 assets per chain, so a full five-network load
costs ~5 calls instead of ~10, and the monthly quota supports thousands of loads.

Measured after delivery: **7 of 55 assets** checked across five networks, in **8
requests** per full load (three token batches plus four native calls — one per
chain holding a native balance). At 10,000 calls/month that is roughly 1,250 full
loads.

The unchecked assets are **not** claimed to be verified. `priceCheck` is `null`
for them, which the UI must render as "not cross-checked", never as "agreed".
Because the table marks only disagreements, the summary states the scope
explicitly — "2 of 6 prices were checked against a second source" — with suspect
assets excluded from the denominator, since they are outside the total and never
worth a call.

### Comparing

Relative difference against the primary, in `Decimal` — never floats:

```
delta = |primary − second| / primary
```

- `delta ≤ PRICE_DISPUTE_TOLERANCE` (default `0.02`) → `agreed`
- `delta > tolerance` → `disputed`
- second source has no quote → `unverified`
- second source unavailable entirely → `null` for every asset, plus one warning

_As shipped_, one more case that this list is missing: a ref the verifier never
actually requested → `null`, not `unverified`. Being asked and declining is not the
same as never being asked.

**Neither source wins a dispute.** The primary price stays in the total and the
asset is flagged, with both figures available for the UI to show. Picking a
winner would be inventing a confidence we do not have — the same reasoning as
ADR-005's flag-and-keep, applied to disagreement instead of staleness.

### New fields

`PortfolioAsset` gains:

```ts
priceCheck: {
  status: 'agreed' | 'disputed' | 'unverified';
  source: string;              // verifier id, e.g. 'coingecko'
  priceUsd: string | null;     // the second opinion, decimal string
  deltaPct: string | null;     // relative difference, decimal string
} | null;                      // null = not cross-checked
```

`Portfolio` gains `disputedAssetCount: number` and `checkedAssetCount: number`.
Warning `prices.disputed` when any dispute exists, naming the count and the
largest disagreement. Aggregate sums both counts across chains.

A disputed price does **not** move the asset out of the total, unlike a suspect
asset (ADR-014) — the doubt is about the number, not about whether the holding is
the user's.

### Failure behaviour

The verifier is enrichment on top of enrichment. Every failure degrades:

- unavailable, rate-limited, timed out → warning `prices.crosscheck_unavailable`,
  all `priceCheck` null, portfolio otherwise unchanged;
- no key configured → the verifier is simply absent, no warning (this is the
  default state and not a fault);
- 414 or any unparseable body → treated as unavailable, logged with the chunk
  size so the cause is diagnosable.

It shares the request deadline, so a slow verifier cannot extend a page load.

### Attribution

Non-negotiable, and a licence term rather than a nicety. When any asset carries a
`priceCheck` from CoinGecko, the footer shows
**"Powered by CoinGecko API"** linked to `https://www.coingecko.com/en/api`, at
the body font size (≥10 pt as required). Rendered from the data, so it cannot
appear when unused or be forgotten when used.

## Configuration

| Variable                      | Default | Meaning                               |
| ----------------------------- | ------- | ------------------------------------- |
| `COINGECKO_API_KEY`           | —       | Demo key. Absent ⇒ no cross-checking. |
| `PRICE_DISPUTE_TOLERANCE`     | `0.02`  | Relative difference before a dispute  |
| `PRICE_CROSSCHECK_COVERAGE`   | `0.95`  | Share of subtotal to cover            |
| `PRICE_CROSSCHECK_MAX_ASSETS` | `25`    | Per-chain ceiling on refs             |

## Shared surfaces — owned deliberately

The M2 lesson was that parallel work collides on shared surfaces. This item is
one change, but it still touches files others will:

| Surface                     | Rule                                                               |
| --------------------------- | ------------------------------------------------------------------ |
| `domain/portfolio.ts`       | Additive fields only; every fixture updated in the same change     |
| `domain/normalize.ts`       | `buildPortfolio` gains one optional input; suspect logic untouched |
| `components/AssetTable.tsx` | Reuses the existing quality-marker pattern; no new column          |
| `lib/format.ts`             | No change — `formatPercent` already handles the delta              |

## Tests

| Area        | Cases                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Selection   | covers 95 % by value; respects the cap; skips unpriced; empty portfolio; single asset                                                                             |
| Comparison  | inside/outside tolerance; boundary exactly at tolerance; zero and negative primary; huge values beyond float precision                                            |
| Adapter     | batching at 100; maps contract→ref case-insensitively; missing quote ⇒ `unverified`; 414 HTML ⇒ unavailable; 401 ⇒ misconfigured; header used, key never in a URL |
| Degradation | verifier throws ⇒ warning, portfolio intact; no key ⇒ silently absent                                                                                             |
| Aggregate   | counts sum across chains; a chain without checks does not corrupt totals                                                                                          |
| Attribution | credit rendered when and only when a check is present                                                                                                             |

Two rows moved home during delivery. The **Attribution** cases could not live in
the unit suite: the project has no DOM testing library and no component unit
tests by design (ADR-017 puts wiring in Playwright). Both halves are now E2E
tests — one asserting the CoinGecko credit and its `href` are present when a
check is, one asserting they are absent when no check ran while DefiLlama is
still credited. The same E2E fixture covers the disputed marker and that the
total does not move.

## Where this spec was wrong

Recorded rather than quietly fixed, because the way it was found is the point.

**Native assets were out of scope, and should not have been.** The reasoning was
that natives need a different endpoint — `/simple/price` by coin id rather than by
contract address — and that this costs a second slice of quota for one asset per
chain. The live run against the benchmark wallet showed:

```
ETH   Base            unverified  primary=1882.490634  second=none
ETH   Arbitrum One    unverified  primary=1882.490634  second=none
ETH   OP Mainnet      unverified  primary=1882.490634  second=none
BNB   BNB Smart Chain unverified  primary= 593.760737  second=none
```

On three of five networks the native asset _is_ effectively the whole holding. The
"one asset per chain" the spec was economising on was the single most material
price on those chains, permanently unverifiable — which defeats the purpose of
cross-checking. Natives are now checked via `NATIVE_COIN_ID_BY_CHAIN_ID`; the four
rows above all return `agreed`, within 0.03 %.

Two more things the spec had not anticipated, both found the same way:

- The **denominator** for "N prices checked" cannot be `pricedAssetCount`, which
  includes suspect assets. Those are outside the total and never worth a call, so
  counting them would understate the coverage of a check that had in fact covered
  everything material.
- `AssetTable` justified marking only disagreements by pointing at a summary that
  "states how many prices were actually checked". No such line existed. Added.

**And the spec's three states were four.** It defined `agreed`, `disputed`,
`unverified` and `null`, but treated "the second source had no quote" and "the
second source was never asked" as the same thing. They are not: the first is an
opinion declined, the second is no opinion sought. Conflating them let a deadline
that cut a batch short report those assets as checked, inflated the coverage the
summary quotes, and would have credited CoinGecko for data it never returned.
Verifiers now report `attemptedRefKeys`. Independent review found this (round 5,
F-03), along with a summary that said "and agreed" whenever nothing was _disputed_
— including when every checked price came back unconfirmed (F-01) — and a
selection that ranked raw balances, so a spoofed token with a fabricated price
would have spent the whole quota (F-02).

Six of the seven adopted findings are in this class: not crashes, but sentences the
UI could print that were not true, in states no test had constructed. Full
dispositions, including four rejections with reasons, in `REVIEW_LOG.md` round 5.

The pattern, for the fourth time in this project: **turning a stated property into
executed arithmetic finds defects that reading the prose does not.** The corollary
this item added: a _specification_ is prose too, and so is a code comment — both
can assert a property the code does not have, and neither fails.

## Acceptance — met

| Criterion                                          | Result                                                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| `pnpm verify` green                                | 587 unit tests, 28 files; lint, types, production build clean               |
| E2E green                                          | 11 tests, including three new cross-check cases                             |
| Live run, real statuses, total unchanged           | 7 checked / 0 disputed on the benchmark wallet; the total was unaffected    |
| Key never in a log line or URL                     | Header-only auth, fixed log label; two unit tests hold it                   |
| Attribution visible                                | "Powered by CoinGecko API" rendered from payload data; E2E both ways        |
| Measured call count confirming the quota maths     | 8 requests per five-network load ⇒ ~1,250 loads/month within the Demo quota |
| A disputed price stays in the total and is flagged | Covered by the E2E fixture: $5,400 total with one 40 % dispute marked       |
