# Milestone 2 — Execution Plan

Status: executable specification. Parent: `DEV_PLAN.md` Part 2, Milestone 2.
Each item below is written to be implemented independently, in order, by an
implementation agent, with review and verification by the driving engineer
after every item.

## Ground rules for every item

1. Follow the conventions already in the codebase: strict decimal handling
   (no value through `number` — see ADR-003 and `src/lib/format.ts`), zod
   validation at every external boundary, warnings for every visible gap,
   vendor concepts stay inside adapters, comments explain constraints rather
   than narrating code.
2. `pnpm verify` (format:check → lint → typecheck → test → build) must pass.
   New behaviour ships with tests in the same style as the existing suite —
   network-free, injected fakes, colocated `*.test.ts`.
3. **Do not commit.** The driving engineer reviews the diff, runs live
   verification, and commits.
4. Do not implement items other than the one assigned. Do not refactor
   unrelated code.
5. Documentation updates belong to the item: README and `.env.example` where
   user-visible, a drafted ADR where a decision is expensive to reverse
   (the driver reviews ADR wording before commit).

## Scope decisions for this milestone

- **In scope now:** M2-1, M2-3, M2-4, M2-5(a), M2-6(file only), M2-8.
- **Gated on owner decisions** (`DEV_PLAN.md` Part 4): M2-2 (needs CoinGecko
  key), M2-5(b) (CI cron needs a remote), M2-7 (deploy target). These are
  specified here only far enough to not paint ourselves into a corner.

---

## M2-1 — Spam and dust handling

**Problem.** Two distinct failure modes of a broad token list:

- _Dust_: dozens of sub-dollar rows bury the holdings that matter.
- _Spam_: airdropped scam tokens. When one carries a price, it inflates the
  total — the only remaining way Nuxfolio can **overstate** a portfolio.

These get different treatment because their honesty risk differs: dust is a
presentation problem; spam is a correctness problem.

### (a) Suspect detection — server side, affects the total

New domain module `src/domain/suspect.ts`, called from `buildPortfolio`.

An asset is **suspect** when either deterministic heuristic fires:

1. **Symbol spoofing.** Its contract address is _not_ on the bundled token
   list for its chain, but its symbol (case-insensitive, trimmed) collides
   with the symbol of a listed token. By construction this can only trigger
   for indexer-discovered (Alchemy) assets — the keyless path only ever sees
   listed tokens. The native asset is never suspect.
2. **Bait naming.** Its name or symbol matches URL/claim-bait patterns:
   contains `http`, `www.`, a TLD-like `.com|.io|.net|.org|.xyz|.fi`, or the
   words `claim`, `airdrop`, `voucher`, `reward` (case-insensitive, word-ish
   boundaries; keep the pattern list as a reviewable constant).

Explicitly **not** a heuristic: low confidence or staleness of the price.
Those remain flag-and-keep per ADR-005 — an uncertain price on a real holding
must stay in the total. Suspicion here means _the asset itself is probably not
the user's_, which is a different claim, and both rules are deterministic
enough to defend.

**Semantics:**

- `PortfolioAsset` gains `suspect: boolean` and
  `suspectReason: 'symbol-spoof' | 'bait-name' | null` (zod schema + types +
  client validation updated).
- Suspect assets are **excluded from `totalValueUsd` and from share
  computation**; shares of primary assets are computed against the
  suspect-free subtotal.
- `Portfolio` gains `suspectAssetCount: number` and
  `suspectValueUsd: string | null` (sum of the excluded values, null when none
  priced), so nothing is hidden without an accounting of what was hidden.
- Warning `assets.suspect` when count > 0: "N assets look like spam
  (reason summary) and are excluded from the total. Review them below."
- The aggregate view sums and reports these per chain exactly like the other
  counts.

**UI:** suspect assets never sit in the main table. They render in a separate
collapsed section below it — "N flagged as likely spam · $X excluded" — which
expands to normal rows each tagged with its reason. No toggle persistence
needed; collapsed is the default every load.

**ADR-014 (draft for driver review):** spam exclusion vs ADR-005
flag-and-keep — why deterministic identity suspicion excludes from the total
while price uncertainty does not.

**Tests (minimum):** spoof fires only for off-list address + colliding symbol;
native asset never suspect; keyless assets never suspect (all on-list); bait
patterns hit and near-misses don't (e.g. symbol "COMbat" must not fire on
`.com` — anchor the TLD pattern sensibly); totals and shares exclude suspect
values; `suspectValueUsd` sums correctly; aggregate propagation; zod round-trip.

### (b) Dust folding — client side, presentation only

- In the asset table, rows with `valueUsd !== null` and value < **$1**
  (constant `SMALL_BALANCE_THRESHOLD_USD` in `src/lib/`, documented) collapse
  into one expander row at the bottom: "N small balances · $X.XX total —
  show". Expanded state is component state, default collapsed.
- Unpriced assets stay in the main table (they carry their own flags and
  cannot distort the total).
- The summary "Assets" card keeps the full count; nothing changes server-side.
- Sorting applies within each group independently.

**Tests:** grouping derivation is a pure function
(`src/domain/` or `src/lib/`) with unit tests: threshold boundary ($1.00
exactly stays primary; $0.99 folds), all-dust portfolio, empty dust set.

**Acceptance:** a wallet airdropped a fake "USDC" (off-list, priced) shows the
correct total with the fake excluded and visibly accounted for; a wallet with
40 sub-dollar tokens shows a short table plus one expander row; `pnpm verify`
green; live smoke on the benchmark wallet shows an unchanged total
(it holds no suspect assets) with dust folded.

---

## M2-3 — Progressive (streamed) aggregate view

**Problem.** The all-networks view waits for the slowest chain (~2 s cold)
before rendering anything.

**Design.** Move aggregate _assembly_ client-side; keep the server aggregate
endpoint untouched for API users.

- `PortfolioView` in aggregate mode fires one request per chain concurrently
  through the existing single-chain endpoint (`?chainId=<id>`), reusing the
  server cache exactly as-is.
- Results render as they arrive: the chain-breakdown card fills in
  per network; summary figures recompute from the chains loaded so far and are
  labelled "loading… (k of n networks)" until all have settled. The existing
  domain functions (`buildAggregatePortfolio`, `withCrossChainShares`,
  `summarizeAggregate`) do the math — they are client-safe already; do not
  duplicate their logic.
- A chain whose request fails becomes a `failedChains` entry with the same
  safe message mapping used server-side (reuse the error-code → sentence map;
  extract it if needed rather than copying it).
- Note in the code why this costs 5 rate-limit tokens per view instead of 1,
  and leave the server-side `?chainId=all` path as the single-request
  alternative.

**Tests:** progressive assembly as a pure reducer — given results arriving in
any order (including failures), the intermediate and final
`AggregatePortfolio` states are correct and order-independent. Client fetch
fan-out gets a test with stubbed fetch resolving out of order.

**Acceptance:** on a cold load, Ethereum's card appears without waiting for
BNB Chain; a blocked chain shows "Unavailable" while others complete; final
totals byte-identical to the server aggregate for the same inputs.

---

## M2-4 — ENS resolution

**Problem.** `vitalik.eth` is rejected with "not supported yet".

**Design.**

- Server-side resolution only (no third-party call from the browser,
  consistent with the privacy posture). Resolve via viem's ENS actions
  (universal resolver `eth_call`s) over the **Ethereum** RPC endpoints already
  configured — through the existing HTTP/RPC layer if practical, otherwise a
  narrowly-scoped viem client used only for ENS, with the same
  timeout/deadline discipline.
- `/portfolio/vitalik.eth` (server component): names matching a conservative
  ENS pattern (`*.eth` only, for now) are resolved, then **redirect** to the
  canonical `/portfolio/0x…?ens=vitalik.eth`. URLs stay canonical; the header
  shows "vitalik.eth · 0xd8dA…6045". The `ens` query param is display-only
  and must be re-validated against the pattern before rendering (no reverse
  verification claim — label it "entered as").
- The address form accepts `.eth` input and routes to the same path; on
  resolution failure the page renders the existing invalid-address UX with an
  ENS-specific message ("could not be resolved").
- `parseWalletAddress` stays pure and ENS-free; resolution is a separate
  server concern (`src/server/ens.ts`), with its own `ProviderError` mapping
  and a short TTL cache entry (reuse `TtlCache`).

**Tests:** name-pattern acceptance/rejection; resolution success, not-found,
and RPC-failure paths with stubbed fetch; cache hit; the page-level routing
logic (pure resolver function). No live ENS call in tests.

**Acceptance:** `vitalik.eth` loads the right portfolio with the name shown;
a nonexistent name gets a clear message; a plain `0x…` path is byte-identical
to before.

---

## M2-5(a) — Token-list freshness warning

**Problem.** Bundled lists age invisibly (`generatedAt` is recorded but
unused).

**Design.** In the keyless balance provider, when a chain's list
`generatedAt` is older than `TOKEN_LIST_MAX_AGE_DAYS` (env, default **60**),
append warning `coverage.token-list-aged`: "The NETWORK token list bundled
with this deployment is N days old; recently listed tokens may be missing.".
One warning per affected chain; the aggregate view's coverage-combining logic
must pass it through unmodified (it only merges `coverage.token-list`).

**Tests:** boundary at exactly the threshold; fresh list emits nothing;
message includes age and network; env default and override.

**Acceptance:** manipulating `generatedAt` in a test fixture produces the
warning end-to-end in the API payload.

_(M2-5(b), the CI cron that regenerates lists monthly, is gated on a remote
existing — see M2-6.)_

---

## M2-6 — CI workflow file (repo has no remote yet)

Write `.github/workflows/ci.yml` now; it activates when the repo is pushed.

- Triggers: push + pull_request on the default branch.
- Steps: checkout → pnpm via corepack (respect `packageManager` field) →
  Node from `.nvmrc` → `pnpm install --frozen-lockfile` → `pnpm verify`.
- No secrets required — the test suite is network-free by construction; state
  that in a comment.
- Add the E2E job from M2-8 as a separate job once both exist.

**Acceptance:** `act`-style local validation is not required; YAML lints and
the workflow mirrors `pnpm verify` exactly.

---

## M2-8 — End-to-end smoke tests

**Problem.** The unit suite cannot catch wiring regressions (route ↔ client ↔
component), currently covered only by manual smoke tests.

**Design.**

- `@playwright/test` as a dev dependency; config `playwright.config.ts` with
  `webServer` starting `pnpm dev` on a spare port; tests in `e2e/`
  (excluded from vitest's include glob — verify no collision).
- **All provider traffic mocked** with `page.route()` interception of
  `/api/portfolio*` — E2E here proves the app's own wiring, not the
  providers (those have the unit suite and live smoke tests). Fixtures reuse
  the canonical payload shapes from `src/test/helpers.ts` where importable,
  or a small `e2e/fixtures.ts`.
- Scenarios (keep to ~6, fast): landing → enter address → portfolio renders;
  all-networks view with one chain failing shows "Unavailable"; invalid
  address shows inline error without navigation; API 429 shows the rate-limit
  error state with retry; empty wallet shows the empty state; mobile viewport
  (390px) has no horizontal overflow.
- New scripts: `test:e2e`; **not** part of `pnpm verify` (keeps verify fast
  and dependency-light) — CI runs it as its own job.

**Acceptance:** `pnpm test:e2e` green locally from a clean checkout after
`pnpm install` + browser download; total runtime under ~60 s.

---

## Gated items — specification stubs

- **M2-2 price cross-check:** second `PriceProvider` (CoinGecko, keyed) run
  alongside DefiLlama for the same refs; disagreement beyond a relative
  tolerance (default 2 %) marks the quote `disputed` (new `priceQuality`
  value, same flag-and-keep semantics). Do not start without the key — the
  live behaviour cannot be verified.
- **M2-7 deploy:** Vercel default; requires `TRUST_PROXY_HEADERS=true` +
  platform IP header, keyed RPC or Alchemy key for quota, and a decision on
  domain. Dockerfile alternative documented, not built, until the owner
  picks.

## Sequencing and verification protocol

Order: **M2-1 → (M2-4 + M2-5a) → M2-3 → (M2-8 + M2-6)** — riskiest first,
wiring tests last so they cover the milestone's own changes.

After each item, the driver: reviews the full diff, runs `pnpm verify`, runs
a live smoke test against the benchmark wallet
(totals must be unchanged except where the item specifies a
change), and commits. Codex performs one independent review of the complete
milestone diff at the end; findings are triaged into `REVIEW_LOG.md` as
before.
