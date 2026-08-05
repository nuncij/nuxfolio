# M3-2 — Multi-wallet bundles

Executable specification. Parent: `DEV_PLAN.md` Milestone 3, item M3-2.
**Status: delivered 2026-08-04.** Decision recorded as ADR-024.

Keyless, no storage, no new provider, no schema, no new endpoint.
`/bundle/0xA,0xB,0xC` totals several addresses the way the existing view totals
several networks.

Revised after independent review (`REVIEW_LOG.md` round 8, verdict REVISE, 8
blockers). The first draft's central cost claim was **factually wrong about this
codebase** and is corrected in place rather than quietly deleted.

## Problem

Anyone with more than one wallet — a hot one and a cold one, a personal and a shared
address — has to open each separately and add the figures up by hand. The
aggregation layer that turns five networks into one honest total generalises to this
second axis, and putting it in the URL makes it shareable without storing anything.

## What the first draft got wrong about cost

The draft claimed that requesting each network separately for ten addresses would
cost "50 rate-limit tokens against a limit of 30, so the last four wallets would
fail". **That is false by default.** `RateLimiter` gives an unidentified client
`maxRequests * 10` (`rateLimit.ts`), and with `TRUST_PROXY_HEADERS=false` — the
default, and deliberately so (ADR-008) — every caller resolves to the shared unknown
bucket. The real default allowance is **300 per minute**, and 50 requests would sail
through. The 30-per-client limit only applies behind a proxy an operator has
explicitly trusted.

Correcting that changes the reasoning but not much of the conclusion, and it exposes
the constraint that actually matters:

**Cold upstream work is 50 per-chain loads either way.** Both paths call
`getPortfolio(address, chain)` and share the same per-chain cache, so the endpoint
choice does not reduce provider load at all. What differs is **concurrency shape**:

| Approach                   | Browser requests | Concurrent chain loads                                        |
| -------------------------- | ---------------- | ------------------------------------------------------------- |
| Per-chain, as today's view | 50               | up to 50 — the browser fans out and nothing bounds the server |
| `?chainId=all` per address | 10               | up to 10 × `CHAIN_SCAN_CONCURRENCY` (3) = **30**              |

So the aggregate endpoint is chosen for fewer round trips and a _bounded_ server
fan-out — not because the limiter would otherwise refuse. And 30 simultaneous chain
loads from one link is still a burst worth preventing, because
`CHAIN_SCAN_CONCURRENCY` is per **request** and nothing today is per **bundle**.

**Hence a bundle-level member concurrency of 2** (`BUNDLE_MEMBER_CONCURRENCY`),
giving at most 6 concurrent chain loads. Members still render as they land, so the
page fills progressively; it simply does not open ten wallets' worth of upstream work
at once. The test for this counts concurrent chain loads, not browser requests —
counting requests is what made the first draft's reasoning look sound.

## Scope: one row per wallet position, not merged rows

The draft merged the same token across wallets into one summed row. Review found
that carried most of the risk in the feature, and it is cut for the same reason
M3-1's cached total was.

Two independent problems, either of which is disqualifying:

**A merged row cannot carry the price state of its parts.** `priceUsd`,
`priceQuality`, `priceCheck`, `priceChange24h` and `priceChange7d` are singular per
asset, and the table renders exactly one of each. If wallet A's USDC quote is stale
and disputed while wallet B's was never cross-checked, one row either hides that
uncertainty or attributes it to the whole balance. It would also break the summary's
"N of M prices were checked" — the exact sentence round 5 found lying.

**Summing quantities is not a money operation.** The draft said "not a new arithmetic
path". False: `sumMoney` rounds to 8 decimal places, while a token quantity may carry
up to 36 and the exact value lives in `rawQuantity` as base units. Two balances of
`0.000000004` would not reliably survive as `0.000000008`. Summing quantities
correctly means adding `bigint` base units after proving the decimals match — a
genuinely new path, and one this release does not need.

**So: one row per wallet position, with a Wallet column beside the existing Network
column.** This is not merely safer, it shows _more_ — which wallet holds what, rather
than a combined figure the reader must decompose. The combined total is in the
summary, where it belongs. Merged rows can return later on top of a member-observation
model that can hold disagreeing prices.

## Design

### The URL

`/bundle/0xA,0xB,0xC` — comma-separated, validated on the server before anything
renders, as `/portfolio/[address]` already does.

Parsing produces one structured result rather than a filtered list, because every
input that did not make it is something the page has to be able to say:

```ts
type BundleRequest = {
  /** Accepted, canonicalised, de-duplicated, in the order given. */
  readonly addresses: readonly WalletAddress[];
  /** Inputs that were not valid addresses, with why. Named, never silently dropped. */
  readonly rejected: readonly { readonly input: string; readonly reason: string }[];
  /** Duplicates removed, so "3 wallets" never means "the same wallet twice". */
  readonly duplicateCount: number;
  /** Accepted addresses beyond the cap. Stated when it bites. */
  readonly omittedCount: number;
};
```

Order of operations, fixed because it changes the outcome: **bound the raw input
first** (2 kB, 32 segments), then validate each, then de-duplicate by lowercased
address, then apply the cap of 10 to what survives. Capping before validation would
let twelve junk segments crowd out two real ones.

De-duplication is a money-correctness rule, not tidiness: `/bundle/0xA,0xA` totalling
one wallet twice would overstate by 100% and look entirely plausible.

**A single valid address does not redirect away.** The draft redirected to
`/portfolio/<the one>`, which would have erased the "we rejected this input" notice
the honesty rules demand — the page cannot say what it dropped if it is no longer the
page. A one-member bundle renders as a bundle, with a link to the ordinary view.
Redirect only when there is nothing at all to report.

**ENS names are rejected**, with a message pointing at the address route. One name is
an `eth_call` on the page-render path, outside the API limiter; that is already the
single hard prerequisite before going public, and a bundle URL would let a stranger
choose the multiplier. Review confirmed the mitigation — a pre-render limiter, one
shared deadline, bounded resolution concurrency — is real but out of scope here.

**`robots: noindex, nofollow`**, matching the wallet route. A bundle URL discloses an
_association_ between addresses, which is more sensitive than either alone, and the
raw list must not appear in a title or description.

### The shape

Computed in the browser from member results, so **there is no wire schema and no new
endpoint** — the draft specified a `bundlePortfolioSchema` for data that never
crosses a boundary.

One canonical source of truth, with everything else derived:

```ts
type BundleMemberState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly aggregate: AggregatePortfolio }
  | { readonly status: 'failed'; readonly message: string };

type BundleState = {
  readonly request: BundleRequest;
  /** Keyed by address, in request order. The only stored facts. */
  readonly members: ReadonlyMap<string, BundleMemberState>;
};
```

Totals, counts, failures and warnings are **selectors over that map**, never stored
alongside it. The draft carried `failure` on each member _and_ a `failedAddresses`
list _and_ eight scalar counts — three representations of the same facts, any two of
which can drift apart. A shared totals reducer is extracted so the chain axis and the
address axis compute their subtotals through one implementation.

### Counting, which is where a bundle would most easily lie

Four numbers, and they are not interchangeable:

| Count      | Meaning                                              |
| ---------- | ---------------------------------------------------- |
| `total`    | members the URL asked for and were accepted          |
| `settled`  | members whose request has finished, succeeded or not |
| `readable` | members that returned a portfolio                    |
| `failed`   | members that could not be read at all                |

The summary says **"1 of 3 wallets readable"**, not "2 of 3 settled". The draft would
have said the second, which counts a failed wallet as covered — the round 6 F-07
defect on a new axis.

### States with no defined behaviour in the draft

- **A member is empty while others are pending.** A bundle-level "No assets found"
  would speak for wallets not yet read. No emptiness conclusion until every member
  has settled.
- **Every member failed.** `totalValueUsd` is null, and the existing summary renders a
  null total as "No prices available" — which would be a claim about prices when in
  fact nothing was read. All-failed renders as named load failures instead.
- **Readable-but-empty versus unreadable.** Different sentences.
- **Refresh.** The displayed total is replaced atomically when the new load settles,
  not collapsed to nothing and rebuilt — the existing view already keeps the previous
  complete result during a refresh.

### Coverage and warnings travel with the total

The draft's `BundlePortfolio` carried no warnings and no coverage state, and its
proposed sentence — "the sum of the priced assets on the networks that could be read"
— would therefore have overstated. A wallet can be _read_ and still have enumerated
only a fixed token list (`coverage: 'token-list'`), or stopped at
`MAX_ASSETS_PER_PORTFOLIO` (`'truncated'`).

So every member warning is preserved and shown, scoped by wallet, and combined
where identical — the aggregate view already does exactly this per chain. The headline
carries its caveats rather than standing alone.

### Freshness is the oldest observation, not the newest arrival

`fetchedAt` is derived from the **oldest `Portfolio.fetchedAt` across every successful
member chain**. Not from bundle assembly time, and not from
`AggregatePortfolio.fetchedAt`: the aggregate endpoint stamps assembly time even when
its chains came from a 59-second-old cache, so a bundle trusting it could print
"updated just now" about data a minute old. `progressiveAggregate.ts` already takes
the oldest leaf for this reason; this follows it.

### The FX rate

A bundle has ten independent responses, so `fxRate` is not automatically shared — one
member may carry a rate while another carries `rates.unavailable`. Taking "the first
non-null" as the aggregate builder does would let EUR figures sit beside a warning
saying figures are USD-only.

Rule: use the rate if **every readable member agrees on `asOf`**; otherwise offer no
EUR conversion and say why. Conflicting rates in one view is a worse outcome than no
conversion.

### Progressive loading

One `?chainId=all` request per member, at most `BUNDLE_MEMBER_CONCURRENCY` (2) in
flight, rendered as each lands. The state machine mirrors `progressiveAggregate.ts`
rather than duplicating it.

**Insights are suppressed until every member has settled**, and then scoped: after a
failure, every sentence says it covers only the readable wallets. Settlement alone is
not enough — a concentration figure computed over two of three wallets is a true
statement about two wallets and a false one about the bundle.

### Reaching a bundle

From the saved-wallets panel, with two or more saved: a **"View together"** action.
It reads the list and never writes it.

It is a **plain anchor**, like every other row there. A `<Link>` would prefetch a URL
containing up to ten saved addresses on panel render — handing the server the entire
saved list before any click, which is precisely what ADR-023 forbids. The existing
zero-request E2E assertion is extended to cover this action.

### Honesty rules, gathered

- The total is the sum of priced subtotals of **readable** wallets, and says what it
  excludes.
- A wallet that could not be read is **named**, never counted as zero.
- An input that was not a valid address is **named**, and no redirect erases that.
- Duplicates are removed before any arithmetic.
- Shares are recomputed against the bundle subtotal, never summed from members.
- Coverage and warnings travel with the figure they qualify.
- Freshness is the oldest observation.
- No cross-cutting insight before every member settles, and none unscoped after a
  failure.
- The cap, the duplicates and the rejects are all stated when they occur.

### Surfaces

| Surface                            | Rule                                                        |
| ---------------------------------- | ----------------------------------------------------------- |
| `domain/bundleRequest.ts`          | **new** — parse, bound, validate, de-duplicate, cap         |
| `domain/bundle.ts`                 | **new** — the state map plus selectors over it              |
| `domain/normalize.ts`              | extracts a shared totals reducer; both axes then use one    |
| `app/bundle/[addresses]/page.tsx`  | **new** — validate, `noindex`, render                       |
| `components/BundleView.tsx`        | **new** — client view, bounded member loading               |
| `components/BundleBreakdown.tsx`   | **new** — per-wallet value list, mirroring `ChainBreakdown` |
| `components/AssetTable.tsx`        | one optional Wallet column; no merging                      |
| `components/SavedWalletsPanel.tsx` | adds "View together" as a plain anchor                      |
| `lib/portfolioClient.ts`           | adds bounded per-member loading; existing paths untouched   |
| `domain/portfolio.ts`              | **no change** — nothing new crosses a wire                  |
| `server/*`, `providers/*`          | **no change** — no new endpoint                             |

### Deliberately not doing

- **No merged rows** (above). **No storage** — a bundle is its URL. **No ENS in the
  URL.** **No per-chain progress within a member** — that view is on the wallet's own
  page. **No named, saved bundles** — separate decision, separate storage shape.

## Tests

| Area        | Cases                                                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| URL parsing | raw input bounded before parsing; duplicates de-duplicated case-insensitively and counted; an invalid input named with a reason; cap applied after validation, not before; ordering preserved; ENS rejected; one valid address renders a bundle rather than redirecting away from its own notice |
| Selectors   | total is the sum of readable members; a failed member excluded and named, never zero; all-failed is not "no prices available"; nothing priced ⇒ null not zero; counts `total`/`settled`/`readable`/`failed` distinguished                                                                        |
| Coverage    | a token-list member's caveat survives into the bundle; a truncated member's does; identical warnings combine, differing ones do not                                                                                                                                                              |
| Freshness   | the oldest member chain's timestamp wins, not assembly time and not the newest arrival                                                                                                                                                                                                           |
| FX          | agreeing rates convert; disagreeing `asOf` offers no EUR and says why; one member unavailable blocks conversion                                                                                                                                                                                  |
| Shares      | of the bundle subtotal; three members never sum to 300 %; `compareDecimal` throughout                                                                                                                                                                                                            |
| Progressive | empty-while-pending states nothing about the bundle; refresh replaces atomically; insights absent until settled and scoped after a failure                                                                                                                                                       |
| Concurrency | a 10-member bundle never exceeds `BUNDLE_MEMBER_CONCURRENCY` members in flight — counted as concurrent loads, not as browser requests, because counting requests is what made the first draft's reasoning look sound                                                                             |
| E2E         | a three-member bundle renders a combined total; a failed member is named; a duplicated address does not double the total; "View together" builds the URL and leaks no address on render; the route is `noindex`                                                                                  |

## Acceptance

`pnpm verify` green; E2E covering a three-member bundle with one failed member; the
concurrency assertion passing; a live run against two real wallets where the bundle
total equals the sum of their individual totals to the cent; insights proven absent
while a member is pending; and the saved-wallets zero-request assertion still passing
with "View together" present.

---

## Delivered

| Criterion                                | Result                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm verify` green                      | 780 unit tests across 37 files; lint, types, production build clean                           |
| E2E green                                | 25 scenarios, five new                                                                        |
| Concurrency bound                        | Asserted as peak simultaneous loads for a ten-wallet bundle, and re-asserted after every wave |
| One request per wallet                   | Confirmed live: two members, two `?chainId=all` requests, not ten                             |
| Bundle total = sum of members            | **Exact.** $685,873.55 + $105,322.93 = $791,196.48, as displayed                              |
| Insights suppressed while partial        | Asserted, and scoped after a failure                                                          |
| All-failed is a load failure             | Asserted: never "no assets found", never "no prices available"                                |
| Saved list not leaked by "View together" | Asserted by hovering the link and counting requests mentioning either address                 |

An earlier live comparison looked like a $4.47 discrepancy against individually-fetched
totals. It was price drift over the two minutes between measurements: the bundle sums
**its own** members exactly, which is the property that matters. Worth recording, because
a four-dollar gap on eight hundred thousand is exactly the size that invites a shrug.

Two defects found while building, both by the tooling rather than by review:

- **Row keys collided.** `assetId` is `chainId:contractAddress`, deliberately the same
  across wallets because it identifies the token and not the holding — so two wallets
  holding USDC would have shared a React key and been reconciled as one row. Keys now
  include the wallet.
- **`react-hooks/set-state-in-effect` rejected the first load function**, which set
  state synchronously when the effect ran. Restructured to hold the accumulator as a
  local of the run and publish only from async callbacks, matching `PortfolioView`.
  That rule has now caught three real problems in this codebase.
