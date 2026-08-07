# Nuxfolio — Development Plan

Status: checkpoint after milestone 2, and the plan forward.
Written 2026-07-30, last revised 2026-07-31. Companion documents:
`IMPLEMENTATION_PLAN.md` (what was built and why), `M2_PLAN.md` (milestone 2's
per-item specifications), `M2-2_PLAN.md` (the price cross-check, as specified and
as delivered), `DECISIONS.md` (ADR-001…026), `PROVIDERS.md`, `REVIEW_LOG.md`
(twelve independent review rounds).

---

## Part 1 — Checkpoint: where the project stands

### Shipped and verified

Eighteen commits, each verified before landing:

| Commit              | Content                                                        |
| ------------------- | -------------------------------------------------------------- |
| `4711488`           | Milestone 1: read-only Ethereum portfolio vertical slice       |
| `9a9be7b`           | Milestone 1.1: token-coverage fix + four more EVM networks     |
| `725a061`…`703d04e` | Milestone 2: see the status table below                        |
| `bf3d629`           | Light and dark themes with a system-first toggle (ADR-016/17)  |
| `79053b7`…`06a930a` | Contrast guard in CI; CI action majors past Node 20            |
| `b467fc8`           | M2-7: deploy as a standalone bundle behind Tailscale (ADR-018) |
| `21a20e2`           | M2-2: price cross-check against CoinGecko (ADR-019)            |
| `239e9f0`           | M3-3/M3-4/M3-5: insights, price change, euro (ADR-020/021/022) |
| `a6f053d`           | M3-1 planned and reviewed; cached totals cut                   |
| _this change_       | M3-1: saved wallets, browser-local (ADR-023)                   |

**Milestone 2 status** (implemented by three parallel Opus agents against
`M2_PLAN.md`, merged and verified by the driver; review round 4 in
`REVIEW_LOG.md`):

| Item                                 | State                                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| M2-1 spam suspicion + dust folding   | ✅ done                                                                                                       |
| M2-3 progressive all-networks view   | ✅ done                                                                                                       |
| M2-4 ENS resolution                  | ✅ done (offchain/CCIP names excluded — SSRF, see round 4 F-01)                                               |
| M2-5(a) token-list freshness warning | ✅ done                                                                                                       |
| M2-6 CI workflow file                | ✅ written, activates on first push                                                                           |
| M2-8 E2E smoke suite                 | ✅ done, 20 scenarios, against a production build (ADR-017)                                                   |
| M2-2 price cross-check               | ✅ done (ADR-019, `M2-2_PLAN.md`)                                                                             |
| M2-5(b) list regeneration cron       | ✅ done — weekly refresh; the drift verdict decides whether it lands on main or opens a PR (ADR-006 addendum) |
| M2-7 deployment                      | ✅ **live** on the owner's VPS, tailnet-only (ADR-018)                                                        |

**Milestone 2 is complete — 9 of 9 items shipped.** M2-5(b) was the last, and was
blocked on having a Git remote at all; it landed on 2026-08-04, once the repo was on
GitHub.

**Also shipped after milestone 2** (not part of `M2_PLAN.md`):

| Item                                                           | State             |
| -------------------------------------------------------------- | ----------------- |
| Light and dark themes, system-first three-way toggle           | ✅ done (ADR-016) |
| Palette contrast guard — parses `globals.css`, asserts WCAG AA | ✅ done           |
| E2E against a production build instead of `next dev`           | ✅ done (ADR-017) |

Totals now: **884 unit tests across 42 files + 31 E2E scenarios**, `pnpm verify`
green. 26 ADRs, 12 independent review rounds.

**Working today, with no API key and no configuration:**

- Enter any public EVM address → portfolio across **Ethereum, Base, Arbitrum
  One, OP Mainnet and BNB Smart Chain**, or any single network.
- 12,346 bundled tokens checked via Multicall3 (500 calls/batch, 4 in flight);
  a full five-chain scan takes ~2 s cold, ~0 s cached (60 s TTL).
- Prices from DefiLlama with per-quote confidence and staleness flags
  (`ok` / `low-confidence` / `stale` / `unknown-age`) — flagged quotes are kept
  and labelled, never silently dropped.
- **With an optional free CoinGecko Demo key**, the prices that matter to the
  total are checked against a second source. A disagreement beyond 2 % is marked
  and both figures shown; neither source wins, and the primary price stays in the
  total (ADR-019). The summary states how many prices were checked, so an
  unmarked row is never mistaken for a confirmed one.
- All arithmetic in `bigint`/`Decimal`; no value ever passes through a float,
  including display formatting.
- Light or dark, following the OS by default, with an explicit three-way choice
  that survives a reload and is applied before first paint. Every text pair in
  both themes meets WCAG AA, enforced by a test that reads the real stylesheet.
- Per-network value breakdown; a failed network renders "Unavailable" instead
  of vanishing from the total; cross-chain shares computed against the
  cross-chain total.
- Optional `ALCHEMY_API_KEY` switches balance discovery to a full indexer
  automatically (capability-based selection, no mode switch).
- Bounded everything: request deadline, per-chain asset cap, batch and chain
  concurrency, cache size, rate-limit windows. Structured logs with mandatory
  redaction of credentials and wallet addresses.

**Accuracy benchmark** (keyless, a real five-network wallet holding ≈ $107k,
2026-07-30): Nuxfolio and DeBank agreed to **within 0.01 %**, with every
per-network subtotal matching. The wallet is a private one and is not named here;
the agreement, not the balance, is the claim.

**Price cross-check, live** (same wallet, 2026-07-31, with a CoinGecko Demo key):
7 of 55 assets checked — the ones carrying 95 % of each network's value — and all
7 agreed, the widest gap 0.50 % on syrupUSDC. Total unaffected. 8 requests for a
full five-network load.

**Quality state:** 884 tests across 42 files plus 31 end-to-end scenarios;
format, lint, type check and production build all pass (`pnpm verify`; E2E runs
separately as `pnpm test:e2e`). Seven rounds of independent Codex review, 62 findings
in total: 58 adopted at least in part, six rejected with a recorded reason, plus
one wholesale "simpler approach" recommendation rejected — and one that changed the
scope of a feature rather than its design (`REVIEW_LOG.md` round 7).

**Repository and deployment:** on GitHub as `nuncij/nuxfolio`, CI green on every
push (`pnpm verify` plus a separate E2E job), and running on the owner's VPS at
a private subdomain behind Caddy — **tailnet-only, no public surface**, by
three independent layers (CGNAT DNS record, Caddy bound to that address, `ufw`
admitting only the tailnet). See ADR-018 and its 2026-08-03 addendum; the domain's
own infrastructure is documented in a separate private repository, whose
go-public checklist names Nuxfolio as a deliberate exception.

### The two lessons worth carrying forward

1. **The token list is the product, in keyless mode.** Milestone 1
   under-reported a real wallet by $71k not because of missing architecture but
   because a swap-routing list (Uniswap) answers a different question than a
   portfolio list (CoinGecko). Coverage gaps hide in data choices, not just in
   code (ADR-012).
2. **"DeFi positions" is two different problems.** Receipt tokens (wstETH,
   syrupUSDC, stkAAVE…) are plain ERC-20s — already covered. What is genuinely
   missing is _protocol accounting_: debt, health factors, LP composition,
   unclaimed rewards. The remaining gap on the benchmark wallet is ≈ $0.35 of
   unclaimed Convex/Curve rewards. Phase-3 effort should be sized against that
   distinction, not against DeBank's page layout.

### Known gaps, honestly stated

| Gap                                                                             | Where documented                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| ~~Junk tokens inflating a total~~                                               | ✅ addressed by M2-1 (identity heuristics + accounting)                        |
| On-list junk airdrops still count toward the total (the list is the whitelist)  | accepted, ADR-014                                                              |
| Spoof detection covers a curated subset of Unicode confusables, not all of them | accepted, ADR-014 addendum — narrowed 2026-08-04, not closed                   |
| ~~The weekly list refresh reaches `main`, not the running app~~                 | ✅ ADR-018 addendum — the target pulls each build from CI on a 15-minute timer |
| Offchain/CCIP-resolved ENS names return not-found                               | round 4 F-01 — needs a hardened gateway fetch                                  |
| ~~ENS lookups happen on the page-render path, outside the API rate limiter~~    | ✅ rate limited on the render path, 2026-08-05 (ADR-025)                       |
| ~~Single price source, no cross-check~~                                         | ✅ M2-2 / ADR-019 — verifier, needs the free Demo key                          |
| Cross-check covers 95 % of value, not every asset (quota)                       | accepted, ADR-019 — unchecked is reported, not implied                         |
| In-process cache and rate limiter — per-instance semantics                      | ADR-007                                                                        |
| ~~Aggregate waits for the slowest chain~~                                       | ✅ M2-3                                                                        |
| ~~ENS names rejected~~                                                          | ✅ M2-4                                                                        |
| ~~Token lists age invisibly~~                                                   | ✅ M2-5(a) warns, M2-5(b) refreshes weekly behind a drift guard                |
| ~~No remote, no deployment (CI file exists, inactive)~~                         | ✅ M2-6/7 — on GitHub, live on the owner's VPS (ADR-018)                       |
| ~~Protocol accounting: debt and liquidation risk not read~~                     | ✅ M5-1, 2026-08-07 — Aave v3 borrower state (ADR-026)                         |
| Per-token protocol detail, other protocols, LP composition, unclaimed rewards   | M5-2 — `M5_PLAN.md` §5 explains why v1 stopped at account level                |
| Collateral is inconsistently visible in the asset total (53 v3 receipts listed) | ADR-026 — why no net-of-debt figure exists; resolved by M5-2                   |
| ~~Alchemy path never exercised live~~                                           | ✅ measured live 2026-08-03 and removed again — see Part 5                     |

---

## Part 2 — Roadmap

Principles carried over from the kickoff: read-only before transactional,
accurate before feature-rich, explain uncertainty instead of hiding it, keep
providers replaceable, prefer maintainable over flashy. Two additions earned in
milestone 1: **measure before choosing** (every provider/limit decision above
was probed live first) and **a partial answer must say what part is missing**.

Effort scale: S ≤ ½ day · M ≈ 1–2 days · L ≈ 3–5 days · XL = a milestone of its
own. Estimates assume the current codebase conventions (tests + docs included).

### Milestone 2 — Trustworthy and on the internet

Goal: the app is deployed, kept honest under adversarial data, and cheap to
maintain. Nothing here needs a database.

**Status: complete.** The table below is kept as originally written
— including where delivery diverged from it, which is worth being able to see. The
status table in Part 1 is authoritative for what exists. Two divergences worth
naming: M2-2 became a `PriceVerifier` layered over `PriceProvider` rather than an
adapter "behind the existing interface" (ADR-019 explains why the wording here
would have lost the confidence and staleness data), and M2-7 went to the owner's
VPS behind Tailscale rather than to Vercel (ADR-018).

| #    | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Effort | Notes                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------- |
| M2-1 | **Spam/dust handling.** A broad token list surfaces airdropped junk; when junk has a price it inflates the total — the inverse of the wstETH bug and worse, because it overstates. Two layers: (a) a "hide small balances" toggle (default on, threshold ~$1, always showing the hidden count so nothing vanishes silently); (b) heuristics for _suspect_ assets — token not on the list but priced, absurd unit price × huge balance, symbol spoofing a major (e.g. fake "USDC") — rendered as a flagged, excluded-by-default section, mirroring the existing priceQuality pattern. | M      | Highest priority: it is the one remaining way Nuxfolio can _overstate_. |
| M2-2 | **Second price source as cross-check.** Add a CoinGecko adapter (needs free Demo key) behind the existing `PriceProvider` interface; when two sources disagree beyond a tolerance, flag the quote (`disputed`) rather than picking a winner. Also serves as fallback when DefiLlama is down.                                                                                                                                                                                                                                                                                         | M      | Proves the price abstraction the way Alchemy proved the balance one.    |
| M2-3 | **Stream the aggregate view.** Render each network's card as its result arrives instead of waiting ~2 s for the slowest. Either per-chain client fetches with the existing single-chain endpoint, or a streamed response. Per-chain client fetches are simpler and reuse the cache as-is.                                                                                                                                                                                                                                                                                            | M      | Pure UX; the data layer already supports it.                            |
| M2-4 | **ENS resolution.** `vitalik.eth` → resolve via mainnet RPC (one `eth_call`), show the name next to the address, keep the address canonical in URLs. Reverse lookup optional later.                                                                                                                                                                                                                                                                                                                                                                                                  | S      | The rejection message already anticipates this.                         |
| M2-5 | **Token-list freshness.** `generatedAt` is already recorded: warn in the UI when lists are older than ~60 days, and add a CI job (once CI exists) that regenerates monthly and opens a PR.                                                                                                                                                                                                                                                                                                                                                                                           | S      | Turns list-aging from silent decay into visible maintenance.            |
| M2-6 | **CI pipeline.** Push to a remote (GitHub), GitHub Actions running `pnpm verify` on every push/PR. Tests are already network-free, so CI needs no secrets.                                                                                                                                                                                                                                                                                                                                                                                                                           | S      | Prerequisite for everything collaborative.                              |
| M2-7 | **Deployment.** Vercel is the natural fit (Next.js, one process, no DB); set `TRUST_PROXY_HEADERS=true` + platform header there, document in PROVIDERS.md. A Dockerfile as the platform-neutral alternative. Public deploy should carry a keyed RPC or Alchemy key — public RPC quotas are not something to promise uptime on.                                                                                                                                                                                                                                                       | S–M    | Needs owner decisions: platform, domain, keys (see Part 4).             |
| M2-8 | **E2E smoke tests.** A small Playwright suite against a production build with mocked provider responses: happy path, invalid address, all-networks view, one-chain-down. Runs in CI. Not a substitute for the unit suite — a regression tripwire for wiring.                                                                                                                                                                                                                                                                                                                         | M      | The one test layer currently missing.                                   |

**Exit criteria:** deployed URL; junk tokens cannot silently inflate a total;
CI green on every commit; a network hiccup mid-scan degrades visibly on the
live site.

### Milestone 3 — Sticky without a database

Goal: the features that make people return, built deliberately _without_
persistence (ADR-002 holds until something genuinely needs a server-side store).

**Status: complete.** M3-3 (insights panel — shipped, then **withdrawn** on
2026-08-06 as unwanted; see ADR-022's addendum), M3-4 (24 h / 7 d change), M3-5
(EUR display) and M3-1 (saved wallets) shipped 2026-08-03, specified in `M3_PLAN.md`
`M3-1_PLAN.md` and `M3-2_PLAN.md`, each reviewed before implementation
(`REVIEW_LOG.md` rounds 6, 7 and 8). M3-6 shipped 2026-08-04.

Two deliberate follow-ons remain out of milestone 3, both cut on review because they
need a model that can hold disagreeing observations: the last-seen total on a saved
wallet, and merged rows in a bundle.

One M3-6 item needed no work: **keyboard navigation in the table already worked** —
every interactive element there is a real `<button>` with `aria-sort`. Rather than
invent work to close the line item, that is now asserted by a test, because an
untested "it already works" is only a claim.

| #    | Item                                                                                                                                                                                                                                                                                                                                                                                                             | Effort | Notes                                                                                                 |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------- |
| M3-1 | **Watchlist, local-first.** Save/label addresses in `localStorage`; landing page lists them with cached last-seen totals. No accounts, no server state, nothing to leak — consistent with the privacy posture. Sync across devices is explicitly deferred (that is the account decision, Part 4).                                                                                                                | M      |                                                                                                       |
| M3-2 | **Multi-wallet bundles.** `/bundle/0xA,0xB,0xC` — aggregate several addresses the same way chains are aggregated (the `AggregatePortfolio` shape generalises; a bundle is a second aggregation axis). Pure computation, shareable as a URL, no storage. Cap the count (~10) to bound fan-out.                                                                                                                    | M–L    | The aggregation layer was built for exactly this kind of reuse.                                       |
| M3-3 | ~~**Rules-based insights panel.**~~ _Built, then withdrawn 2026-08-06 (ADR-022 addendum)._ Concentration ("one asset is 73 % of the portfolio"), stablecoin share, unpriced share, bridged-vs-native exposure — all computable _today_ from data already in `Portfolio`, no AI involved. Ships the "where are the risks" promise of the kickoff years before Phase 5, with the same honesty framing as warnings. | M      | High value/effort ratio; also the natural substrate the later AI layer explains, rather than invents. |
| M3-4 | **24 h / 7 d price change column.** DefiLlama has historical price endpoints (keyless). Adds the one number everyone looks for; flagged quotes get no change figure rather than a fabricated one.                                                                                                                                                                                                                | S–M    |                                                                                                       |
| M3-5 | **Display currency (EUR first).** Convert at render time from a single USD→EUR rate (ECB reference rate, cached daily), clearly labelled as converted. All arithmetic stays USD internally.                                                                                                                                                                                                                      | S–M    | Owner is EU-based; likely wanted early.                                                               |
| M3-6 | **Small UX debt.** Copy-address button, sort state in the URL, per-chain deep links from the breakdown cards, keyboard navigation in the table.                                                                                                                                                                                                                                                                  | S      | Batch of small items.                                                                                 |

**Exit criteria:** a returning user lands on their saved wallets in one click;
a bundle URL can be shared. The third criterion — the insights panel stating the
top three facts about any portfolio — was met and then removed at the owner's
request, which is the more useful thing to record than a tick.

### Milestone 4 — History (persistence enters)

Goal: answer "how has it changed?" — the first features that genuinely need a
store, which is the ADR-002 trigger for introducing one.

| #    | Item                                                                                                                                                                                                                                                                                                                   | Effort | Notes                                                                                                                     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| M4-1 | **Choose and introduce the store.** Postgres + Drizzle (per ADR-002's forward note) if self-hosting; the platform's serverless Postgres if on Vercel. Schema starts with exactly one table family: snapshots.                                                                                                          | M      | Deliberately _after_ M3, so the store serves a proven need.                                                               |
| M4-2 | **Portfolio snapshots.** Persist `(address, chainId, totalValueUsd, assetCount, fetchedAt, payload)` on each uncached load, plus a daily cron for watchlisted addresses. Retention policy from day one.                                                                                                                | M      |                                                                                                                           |
| M4-3 | **Historical value chart.** Two data sources, clearly distinguished in the UI: real snapshots (exact, sparse at first) and a _reconstruction_ — current holdings valued at DefiLlama historical prices (dense, but wrong whenever balances changed; labelled as such). The honest-uncertainty pattern applied to time. | L      | The reconstruction caveat is non-negotiable — see kickoff principle "do not claim a value is exact when it is estimated". |
| M4-4 | **Shared cache / rate-limit store.** Only if deployment scales past one instance (ADR-007). Same interfaces, Redis/Upstash implementation.                                                                                                                                                                             | M      | Explicitly deferred until measured need.                                                                                  |

**Exit criteria:** a chart on every portfolio page whose two line styles are
visually and verbally distinguished; snapshots survive deploys.

### Milestone 5 — DeFi protocol accounting (kickoff Phase 3)

Goal: the part of DeBank parity that is genuinely hard — reading protocols' own
accounting. Scoped tightly by the receipt-token lesson: most "positions" are
already visible; this milestone adds what `balanceOf` cannot see.

| #    | Item                                                                                                                                                                                                                                                                                     | Effort | Notes                                                           |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------- |
| M5-1 | **`PositionProvider` interface design.** Mirrors `PortfolioProvider`: per-protocol adapters returning normalised `Position` objects (supplied, borrowed, rewards, healthFactor), each with its own coverage/warning semantics. Design doc + ADR before any adapter.                      | M      | The interface is the deliverable; adapters are then mechanical. |
| M5-2 | **Aave v3 adapter** (first, because it exercises the full shape: supply + debt + health factor + rewards, and the benchmark wallet uses it). On-chain reads via the existing RPC layer — no new vendor.                                                                                  | L      |                                                                 |
| M5-3 | **Lido, Curve/Convex adapters.** Staking and LP composition + unclaimed rewards. Choose by TVL × what benchmark wallets actually hold.                                                                                                                                                   | L each |                                                                 |
| M5-4 | **Decide on an indexer shortcut.** Zerion/Zapper-style position APIs could cover the long tail in one integration but are paid and re-introduce single-vendor coupling. Evaluate _after_ three first-party adapters exist, so the abstraction is proven before a vendor hides behind it. | —      | Decision point, not a work item.                                |
| M5-5 | **Debt-aware totals.** Net worth = assets − debt, with both shown. The summary card semantics change; needs the same care as the priced-subtotal labelling.                                                                                                                              | M      |                                                                 |

**Exit criteria:** the benchmark wallet shows its Aave and Convex positions
including the ~$0.35 unclaimed rewards; a leveraged wallet shows debt and
health factor; every protocol view states which protocols were _not_ checked.

### Milestone 6 — Beyond EVM (kickoff Phase 4)

Sequenced last among data expansions because each item is a new world, not a
new registry entry: different address formats, providers, and models.

- **More EVM chains first** (Polygon PoS, Avalanche C-Chain, zkSync, Linea…):
  each is one registry entry + `pnpm tokens:generate` — S each, do
  opportunistically whenever asked.
- **Bitcoin**: address-format module (bech32/base58), mempool.space public API,
  UTXO model; no tokens, no Multicall — a parallel, simpler provider. L.
- **Solana**: SPL tokens via public RPC `getTokenAccountsByOwner`; new address
  validation; token list from Jupiter/CoinGecko. L–XL.
- **Manual entries** (CeFi balances, cold storage): needs persistence (M4) and
  a form UX; entries are user-asserted and must be visually distinct from
  chain-verified data — the honesty rule again. M.

### Milestone 7 — AI analysis (kickoff Phase 5)

Deliberately last, and deliberately layered on M3-3's rules-based insights: the
model _explains and prioritises_ computed facts (concentration, stablecoin
share, protocol exposure, scenario deltas) rather than generating claims of its
own. Every generated report cites the numbers it used, carries the same
estimate disclaimers as the rest of the product, and is never presented as
financial advice. Needs an LLM API key (server-side, same redaction rules) and
a cost ceiling per request. Scope properly when M3-3 exists; sizing it today
would be guessing.

---

## Part 3 — Standing engineering practices

Carried forward from how milestones 1 and 1.1 were actually built:

1. `pnpm verify` green before every commit; live smoke test against a real
   wallet for anything touching providers.
2. Measure before choosing: probe endpoints, batch sizes and limits live, and
   record the numbers in the ADR that cites them.
3. Independent review (Codex) at plan and done checkpoints for risky work;
   findings triaged, never auto-adopted; dispositions recorded in
   `REVIEW_LOG.md`.
4. Every coverage limitation must be visible in the response (`coverage`,
   `warnings`) — a gap the user cannot see is a bug even when the code is
   correct.
5. New providers go behind the existing interfaces; vendor concepts stay inside
   adapters (ADR-005 discipline).
6. ADR for anything expensive to reverse; update the ADR when the code moves on
   (the ADR-005 drift found in review round 2 is the cautionary example).

## Part 4 — Decisions needed from the owner

Not blocking current work, but each unlocks or shapes a milestone:

Four of these are now settled; kept in the table with their outcomes so the
reasoning is not lost.

| Decision                            | Affects                     | Outcome / options                                                                                                                                                                      |
| ----------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~Remote hosting for the repo~~     | M2-6                        | ✅ GitHub, `nuncij/nuxfolio` — CI runs `pnpm verify` on every push                                                                                                                     |
| ~~Deployment target + domain~~      | M2-7                        | ✅ owner's VPS, tailnet-only via Tailscale Serve, no public domain (ADR-018)                                                                                                           |
| ~~CoinGecko Demo key (free)~~       | M2-2 cross-check            | ✅ provisioned — 100 calls/min, 10,000/month, attribution required (ADR-019)                                                                                                           |
| ~~Provision an Alchemy key (free)~~ | balance coverage everywhere | ✅ answered **no** — provisioned and measured 2026-08-03: 107 extra tokens worth $0.00 at 117 requests per load. Removed; one line in the VPS env restores it. Full numbers in Part 5. |
| Token logos stance                  | UX vs privacy (ADR-009)     | keep initials (default) / server-side proxy with caching — never direct browser→CDN                                                                                                    |
| Accounts & sync, ever?              | M3-1 scope, privacy posture | local-only until there is a concrete reason                                                                                                                                            |
| Display currency                    | M3-5                        | EUR alongside USD?                                                                                                                                                                     |
| NFTs                                | scope                       | proposed: out of scope until explicitly requested                                                                                                                                      |

## Part 5 — Recommended next step

Milestone 2 is finished, and three of milestone 3's six items shipped on
2026-08-03: the insights panel (since withdrawn), the 24 h / 7 d change column and
the euro display.
All three are keyless.

**Milestones 2 and 3 are both complete**, M2-5(b) having closed the last of milestone
2 on 2026-08-04. What remains before milestone 4 is optional:

**M5-1 shipped on 2026-08-07**: Aave v3 debt, collateral and health factor, across
seven markets on five chains (ADR-026). What remains optional:

- **The two cut follow-ons**, if either is wanted: a saved wallet's last-seen total,
  or merged bundle rows. Both need the same thing — an observation model that can hold
  a stale price from one source beside a fresh one from another — so doing them
  together is cheaper than doing either alone.

**Then milestone 4 (history), which is a step change**: the first feature that
genuinely needs Postgres, on a 3.7 GB box with no swap that already hosts other
projects. Worth planning as carefully as the deployment was.

**The one hard prerequisite is closed** (ADR-025): ENS resolution on the render path
is rate limited with the same identity rules as the API. What still stands between
this deployment and a public one is no longer a bug — it is the set of capacity and
cost decisions in Part 6.

**The upkeep item is done.** M2-5(b) regenerates all five lists every Monday, and the
drift verdict decides what happens next: ordinary churn lands on `main` unattended,
while anything the thresholds cannot judge — a mass removal, a net shrink, a rename
sweep, a decimals change — becomes a pull request for a person. The reason is that an
automated regeneration can be _worse_ than what it replaces: a truncated upstream
response would commit fewer tokens under a fresh `generatedAt`, silencing the 60-day
warning at the moment coverage shrank (ADR-006 addendum).

It shipped monthly-and-always-ask and was changed the same day, because the owner
asked whether monthly was enough and the schedule turned out to rest on arithmetic
nobody had done. Two other errors were caught the same way: rehearsing the flagged
path against real data found the ranking reporting an 80 % coverage loss as "1 token
changed decimals", and review round 9 computed that the guard permitted 268 tokens —
2.2 % of all coverage — to vanish in one run unflagged. That bound is now 25 tokens,
0.20 %, and both figures are recorded in the module.

**The Alchemy question is now answered, and the answer was no.** A key was
provisioned and tested on 2026-08-03: it found 107 additional tokens on the
benchmark wallet worth **$0.00** — 51 flagged as spam, 105 unpriced — while costing
117 requests per page load against ~25 free public RPC calls, and putting a
permanent "truncated coverage" caveat on four of five networks (8 malformed spam
tokens with unresolvable metadata). Removed again. The bundled CoinGecko lists
already cover everything material on this wallet, which measures ADR-012's fix
rather than trusting it. One line in `~/nuxfolio/env` restores it if a holding ever
falls outside the lists.

**Still open, and unchanged in substance:** ENS resolution runs on the page-render
path, outside the API rate limiter. On a tailnet-only deployment this is not a
blocker — only the owner's own devices can reach it (ADR-018) — but it becomes a
hard prerequisite again the moment Funnel or a public domain is switched on. It is
listed in the known-gaps table for that reason.

## Part 6 — Going public: what it would take, honestly

Written 2026-08-05, after the owner asked whether Nuxfolio was ready to be public and
the answer deserved to be a document rather than a chat message. "Public" here means a
URL strangers can open — as opposed to today's posture (tailnet-only, three
independent privacy layers, ADR-018) or the middle option, which costs nothing and
works today: **inviting specific people into the tailnet**, which changes no risk at
all.

The code-level blocker is fixed. What remains are not bugs; they are capacity and
money decisions, and they are the owner's.

| Concern                                | The specific problem                                                                                                                                                                                                                                                                                                                                          | What resolving it takes                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| ~~ENS on the render path~~             | ✅ Closed 2026-08-05: resolution is rate limited with the API's identity rules, refusals say how long to wait (ADR-025).                                                                                                                                                                                                                                      | Done.                                                                                                                               |
| **The box is shared**                  | 2 vCPU, 3.7 GB, no swap, and it runs other people's services. Public traffic — one busy link — degrades or kills the _neighbours_, not just Nuxfolio. The infra repo's go-public checklist names Nuxfolio as a deliberate exception for a reason.                                                                                                             | Its own VPS (or the owner accepting the risk to the neighbours, which the infra docs currently reject).                             |
| **Free tiers are sized for one owner** | Balances ride public RPC endpoints with no uptime promise; the price cross-check has a 10,000-call/month CoinGecko budget the owner alone barely dents. Public traffic exhausts both in days, after which pages degrade honestly but degrade.                                                                                                                 | Paid keys: a keyed RPC endpoint (or Alchemy) and a paid CoinGecko tier. Collides with the standing no-paid-APIs rule.               |
| **Caller identity must be configured** | Behind Caddy, `TRUST_PROXY_HEADERS=true` + the right `CLIENT_IP_HEADER` are required, or every visitor shares the `unknown` rate-limit bucket — the limiter would be real but useless, one heavy visitor locking out everyone (ADR-008).                                                                                                                      | Two env vars on the box, plus verifying Caddy strips inbound forwarding headers. An hour, but a _correctness_ hour.                 |
| **Identity values are not validated**  | `resolveClientId` accepts any ≤64-character header value as an identity without checking it is an IP (round 11, F-01). Combined with the row above, trusting a header the proxy _forwards_ rather than _overwrites_ lets an attacker rotate values for fresh rate-limit budgets. Harmless today: headers are untrusted and only the owner can reach the page. | Validate and canonicalise the value, and confirm the proxy overwrites rather than appends. Do it **with** the row above, not after. |
| **Denied requests are still renders**  | The rate limiter stops upstream RPC calls, but a refused request still costs a page render and a log line (round 11, F-02). Nothing inside the app can fix this — the render is what receives the request.                                                                                                                                                    | Request-rate and concurrency limits at the edge, in Caddy. Also protects the neighbours, so it pairs with the shared-box row.       |
| **Nobody is watching**                 | No uptime monitoring, no error tracking, no alerting. Tailnet-only, the only user notices immediately; public, the site can be down or rate-limited into uselessness for days silently.                                                                                                                                                                       | An uptime check at minimum. The self-updater's journal is on-box only.                                                              |
| **Offchain ENS names**                 | CCIP-read stays deliberately disabled (SSRF, round 4 F-01), so gasless subdomains and L2-hosted names resolve as not-found. Private, that is a documented limitation; public, it is a support burden.                                                                                                                                                         | A hardened gateway fetch — real design work, sketched in the known-gaps table since milestone 2.                                    |

Order, if this ever happens: paid keys first (they also derisk the tailnet
deployment), then the identity configuration, then a dedicated box, then monitoring.
None of it is wasted if the answer stays "private": every row above except the last
also makes the private deployment sturdier.

### Note on the parallel-agent workflow

Three isolated agents produced correct parts and predictable seams: the merge
cost one conflict and review round 4 found two seams (a URL builder and a
warning-rendering rule, each touched by two agents who could not see each other)
plus one integration gap in a state neither owned. For the next milestone, name
the shared surfaces in the plan and assign each an owner, rather than finding the
overlap at review time.

### A pattern worth repeating

Five of the most valuable findings in this project came from turning a stated
intention into an executable check, and each one immediately found a defect that
had been shipped and unnoticed:

- Measuring provider behaviour instead of trusting documentation found
  CoinGecko's one-address-per-request limit before it was built on (ADR-005).
- Comparing against a real wallet found a $71,000 coverage gap that no test could
  have caught, because the code was correct and the _data_ was wrong (ADR-012).
- Computing contrast ratios instead of judging colours by eye found a caption
  colour that had been below the accessibility floor for a whole milestone
  (ADR-016).
- Running the finished cross-check against a real wallet found that the spec's own
  scoping decision was wrong: skipping native assets to save quota left the single
  most material price on three of five networks permanently unverifiable
  (ADR-019). The plan had reasoned about it correctly and reached the wrong answer,
  because it had no numbers.

- Scanning the bundled lists for characters that would misrender in a pull request
  body found a token named with two leading zero-width spaces — and that led
  straight to the spam filter, where "collides case-insensitively" had been the whole
  comparison for four milestones. A symbol of `USD\u200bC` renders as "USDC", is not
  equal to it, and so was priced into the total with no badge (ADR-014 addendum).

The generalisation: when a requirement is stated as a property — "precise",
"legible", "as complete as DeBank" — the next step is to find the arithmetic that
decides it and run that arithmetic in CI. Prose in an ADR does not fail.

The fourth case adds a corollary: the check is worth running against your own
_plan_, not only against the code. A specification is prose too.

The fifth adds another: a check written for one purpose finds defects somewhere else.
Nothing about the token-list refresh required looking at `suspect.ts`; scanning real
data for one problem simply surfaced the ingredients of a different one. And
measurement then overruled the fix's own first design — a mixed-script rule would have
marked genuine holdings suspect, which only counting the real lists revealed.
