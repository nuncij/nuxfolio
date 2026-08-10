# Independent Review Log

Nuxfolio's plan and implementation were reviewed by OpenAI Codex (GPT-5.6) acting
as an independent second engineer. Codex is advisory: every finding was checked
against the brief, the code and actual test results before being accepted or
rejected. Rejections are recorded with a reason, so a later reader can disagree
with the reasoning rather than guess at it.

---

## Round 1 — plan review (before implementation)

Reviewed `docs/IMPLEMENTATION_PLAN.md` and `docs/DECISIONS.md` against the brief.
Verdict: **CHANGES REQUIRED — 0 blockers, 11 majors, 2 minors.**
Session `019fb2ce-00db-75a3-b41a-560310c26b4e`.

### Accepted in full

| ID   | Finding                                                                                                                 | What was done                                                                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-02 | The Alchemy path was called "complete" with no pagination or bounded work                                               | Added page cap (5), asset cap (`MAX_ASSETS_PER_PORTFOLIO`), metadata concurrency cap (6), shared request deadline, and `coverage: "truncated"` whenever a ceiling is hit. Capped data is never labelled complete.                                                        |
| F-03 | Abuse protection bypassable and its maps unbounded; concurrent misses duplicate upstream work                           | Bounded and pruned both maps; added single-flight coalescing in `TtlCache.getOrLoad`; gave the shared `unknown` bucket its own higher ceiling so one anonymous caller cannot lock out the rest.                                                                          |
| F-04 | Secret and privacy boundaries asserted but not enforced                                                                 | `server-only` on `env.ts`/`chains.ts`; clients get a `PublicChainInfo` projection with no RPC URLs; provider failures map to a fixed error DTO; logger redacts credentials, addresses and long hex runs. Tested with a sentinel secret.                                  |
| F-05 | The price abstraction was vendor-coupled (`priceProviderNamespace`, native `priceId` in `ChainConfig`)                  | `PriceRef` is now `{ chainId, contractAddress }`. DefiLlama's chain namespace and CoinGecko native mapping live inside the adapter. Chain config carries no vendor concept.                                                                                              |
| F-06 | Treating every balance failure as fatal violates the partial-failure requirement                                        | `aggregate3` with `allowFailure: true`; per-batch error handling with warnings; individual reverts and undecodable returns skipped and counted. Only a failed native read is fatal. Six tests cover these paths.                                                         |
| F-07 | Partial valuation had misleading total and percentage semantics, an arbitrary confidence cut-off, and no staleness rule | The total is labelled "priced assets" and the summary states how many of how many were priced. Low-confidence and stale quotes are now **flagged and kept**, not dropped — dropping made the subtotal quietly wrong. Added `priceQuality` and timestamp-based staleness. |
| F-09 | Planning `docs/PROVIDERS.md` does not establish permitted use                                                           | Written, with measured behaviour, reproduction commands, limitations, cost assumptions and replacement steps per provider — and an explicit statement that availability is not permission, marking what an operator must verify before production.                       |
| F-11 | A Slovenian document violated the English-only requirement; the plan referenced a non-existent `PROJECT_KICKOFF.md`     | Kickoff renamed to `PROJECT_KICKOFF.md`; the WSL setup document translated to English.                                                                                                                                                                                   |
| F-13 | Timeout and retry behaviour was too vague to judge                                                                      | Now stated and tested: 8 s per attempt, 3 attempts, 250 ms × 2^n backoff capped at 2 s, retry on 408/429/5xx and transport errors only, `Retry-After` honoured when it fits the budget, one 15 s end-to-end deadline shared by all upstream work.                        |

### Accepted in part

| ID   | Finding                                                                                                                     | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | "The keyless provider can report a materially false total — make an indexer the sole default and defer the token-list path" | **The concern is real; the prescription is not.** The brief requires the app to run from documented commands _and_ forbids coupling to one third-party provider. If Alchemy were the only provider, a fresh clone with no account would show nothing and acceptance criterion 3 could not be met by a reviewer. Resolved by _capability-based selection_: when `ALCHEMY_API_KEY` is present, Alchemy wins automatically; otherwise the RPC scan runs with an explicit coverage warning on every response. Under-reporting is stated in the UI, not hidden.            |
| F-08 | "Required UI behaviour is neither fully specified nor adequately tested"                                                    | Specification accepted: the state machine is now explicit in `src/domain/viewState.ts` (idle, loading, empty, unpriced, ready, error) with retryability derived from the error code, and 14 tests cover it, plus sorting in both directions and summary derivation. **Rejected:** full DOM-rendering tests for each state. That means adding jsdom and a component-testing stack to assert what a pure selector already asserts; the brief's testing list is business logic, not rendering. Desktop and mobile were verified manually instead, at 1280 px and 390 px. |
| F-10 | "The milestone contains substantial unused future and demo machinery"                                                       | **Accepted:** the disabled Base chain entry was cut (a non-selectable network is exactly the placeholder the brief prohibits), and the runtime `fixture` providers were removed — tests inject fakes directly, so no test-only branch survives in production code. **Rejected:** dropping the second balance adapter (see F-01) and replacing Tailwind with hand-written CSS. Tailwind is one dev dependency and a PostCSS plugin; hand-rolling a responsive dark dashboard would add code, not remove it.                                                            |
| F-12 | "Remote token logos introduce an unnecessary privacy and SSRF surface"                                                      | **Accepted for rendering:** no logo is fetched by the browser, so a wallet's holdings are never disclosed to a CDN. Asset initials are rendered instead. `logoUrl` is still populated in the API because the brief's domain model includes it and a future client may want it — see ADR-009.                                                                                                                                                                                                                                                                          |

### Rejected

| ID  | Finding                                                                                                         | Reason                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | "A materially simpler approach: Next.js, plain CSS, one indexed provider, no token list, no provider selection" | Rejected as a package. It fails acceptance criterion 3 without an API key, and it satisfies "do not tightly couple to a single third-party provider" only nominally — one interface with one implementation proves nothing about replaceability. The parts of it that were genuine simplifications (no placeholder chain, no runtime fixtures) were adopted under F-10. |

### Codex findings that changed the design most

F-05, F-06 and F-07 were the three worth the round. The vendor namespace leaking
into `ChainConfig` would have made the price abstraction ceremonial; "balance
failure is fatal" contradicted a requirement the plan itself quoted; and silently
dropping low-confidence quotes would have produced a subtotal that was wrong in a
way no warning explained.

---

## Round 2 — implementation review

Reviewed the complete working tree after all five checks passed.
Verdict: **FIX FIRST — 0 blockers, 3 majors, 3 minors.**
Session `019fb30b-5581-7e32-9472-35f11e166f64`.

All six findings were accepted. Three were real defects that the passing test
suite did not catch, and one of those was enshrined by a test asserting the wrong
behaviour.

| ID   | Severity | Finding                                                                                                                                                                                                                               | What was done                                                                                                                                                                                                                                                                                                                                                     |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | major    | A keyed custom RPC URL leaks its credential into logs and error messages: `redactUrl` keeps the path, where a non-hex key is indistinguishable from a route segment, and only `ALCHEMY_API_KEY` was registered as a scrubbable secret | Endpoints are no longer named in output at all. `fetchJson` takes an opaque `label`; the JSON-RPC client passes `endpoint 1`, `endpoint 2`. Operator-configured `ETHEREUM_RPC_URLS` are additionally registered as scrubbable secrets as a second layer. Regression test asserts a non-hex credential appears in neither the error nor any log line.              |
| F-02 | major    | `formatQuantity` and `formatUsd` converted exact decimal strings through `number`, so `9007199254740993` rendered as `…992` and one wei of an 18-decimal token rendered as `0`                                                        | Both formatters are now exact: rounding happens in `Decimal`, and thousands separators are applied to the integer part as a `bigint`, which `Intl` groups without loss. Sub-cent amounts and dust keep significant digits. Confirmed against live data — a real 0.000000146465 MIR holding now renders as itself instead of `0`. Dead `formatUsdCompact` removed. |
| F-03 | major    | The Alchemy adapter silently skipped entries it could not read while still reporting `coverage: "complete"`, and `alchemy.test.ts` asserted exactly that                                                                              | Unreadable entries are counted, warned about, and force `coverage: "truncated"`; a zero balance is still treated as simply not a holding. The response's `address` is now checked against the requested one. The offending test was split into the two cases it had conflated.                                                                                    |
| F-04 | minor    | Every `invalid-response` blocked endpoint fallback, including a malformed body from the primary endpoint only — so a healthy secondary was never tried                                                                                | The two failure classes are now separated by construction: transport and malformed-body failures fall through to the next endpoint, while a well-formed JSON-RPC `error` is treated as deterministic and not retried elsewhere. Test covers malformed-primary / healthy-secondary.                                                                                |
| F-05 | minor    | A quote with no timestamp was classified `ok` and shown without a caveat, though `PriceQuote` documents null as "age unknown"                                                                                                         | Added `priceQuality: 'unknown-age'`, a row marker, and a warning. An unparseable timestamp maps to it too. The value still counts toward the subtotal; only the freshness claim is withdrawn.                                                                                                                                                                     |
| F-06 | minor    | ADR-005 still said low-confidence quotes are excluded, while the code flags and keeps them                                                                                                                                            | ADR-005 rewritten to state the implemented policy and why the earlier draft was wrong: dropping a quote removes its value from the subtotal, understating the portfolio with no warning to explain the gap.                                                                                                                                                       |

Codex also listed what it had verified as sound, which is the more useful half of
a review: decimal arithmetic throughout the value/percentage path, missing-price
handling, DefiLlama identity mapping and partial-batch survival, Multicall3
length checking and per-contract failure degradation, retry/deadline coherence,
cache and rate-limiter bounds, and the server-only credential boundary.

### Findings Claude raised independently in the same pass

Not from Codex; found while re-reading the diff, and fixed alongside:

- `Retry-After` was being shortened by the 2 s backoff cap, so a provider asking
  for 60 s would have been retried after 2 s. It is now honoured exactly, and
  when honouring it would outlast the request deadline the client gives up
  instead of retrying early.
- The Alchemy adapter reported truncation when holdings landed _exactly_ on the
  asset cap with no further pages — claiming a gap where none existed.
- `PortfolioWarning`s were not deduplicated by code, and the UI keys them by
  code, so two layers raising the same concern would have collided.
- The Alchemy metadata warning could have printed "0 tokens were skipped".
- The Alchemy adapter had no direct test coverage at all. It now has 19.

### Round 1 findings re-checked in round 2

Round 1's F-02 (bounded fan-out), F-03 (bounded maps, coalescing, limiter
ceiling), F-04 (server-only boundary, safe error DTOs, log redaction), F-05
(vendor-neutral `PriceRef`), F-06 (partial balance failure) and F-13 (retry
policy) were all confirmed present and sound. F-01's disposition — two providers
selected by capability — was not re-litigated.

---

## Round 3 — release-readiness gate

A confirmation pass over the six round-2 fixes, with regenerated evidence.

**Gate round 1** returned `FIX_QUALITY: FAIL` on a real gap in one of the fixes:

> MAJOR | `src/providers/balances/alchemy.ts:263` | A non-address response value
> bypasses the guarded comparison, allowing its balances to be attributed to the
> requested wallet.

The check was `isAddress(responded) && getAddress(responded) !== address`. If the
response's `address` field was not an address at all, the `&&` short-circuited and
the balances were accepted — precisely the case the guard existed to catch. It
failed _open_ on the input it was written for. Rewritten to fail closed in both
directions:

```ts
if (!isAddress(respondedAddress, { strict: false }) || getAddress(respondedAddress) !== address) {
  throw new ProviderError('invalid-response', PROVIDER_ID, '…');
}
```

Two tests were added: one for a non-address value, and one asserting that a
casing-only difference (lowercase vs checksummed) is _not_ a false rejection.

**Gate round 2** (session `019fb32d-29b9-7cd0-9966-c2e19d59bb33`), run fresh
against regenerated evidence:

```text
INTENT:       PASS
WORKS:        PASS
FIX_QUALITY:  PASS
REMAINING:    none
VERDICT:      SHIP
```

### What the three rounds cost and returned

Twenty-five findings across four rounds. Every one was adopted at least in part;
four had a component rejected for a reason recorded above, and one unnumbered
"simpler approach" recommendation was rejected wholesale. Four defects were found
in code Codex had itself just approved. The most valuable were the ones a passing test suite could
not have surfaced: a vendor namespace leaking into chain config, a fatal-on-any-
failure balance path that contradicted a requirement, low-confidence quotes being
dropped in a way that silently understated the total, a formatter that rendered a
real dust holding as `0`, and a validation guard that failed open.

---

## Round 4 — milestone 2 review

Milestone 2 was implemented by three Claude Opus agents working in parallel in
isolated git worktrees against `M2_PLAN.md`, then merged, verified and live-tested
by the driving engineer. Codex reviewed the combined ~4,400-line diff.
Verdict: **FIX FIRST — 1 blocker, 1 major, 3 minors.** Session
`019fb41a-ee54-79e1-be61-4e1864f8bd78`. All five accepted and fixed.

| ID   | Severity    | Finding                                                                                                                                                                                                                                                                                                                                                               | What was done                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | **blocker** | The ENS client left CCIP-read (ERC-3668) enabled. viem follows a URL supplied by the _resolver contract_ using the global `fetch` — outside the injected `fetchImpl` and outside the deadline. Anyone can register a name whose resolver points at `http://169.254.169.254/…`, so any visitor's URL could make the server issue requests from inside its own network. | `ccipRead: false`, with the reasoning in the code. Verified independently before acting: `call.js` gates on `ccipRead !== false` (on by default) and `ccip.js:100` calls global `fetch` with the contract-supplied URL. Regression test constructs a real `OffchainLookup` revert pointing at the link-local metadata address and asserts the RPC call is the only request made. Cost: offchain-resolved names return not-found; ordinary onchain `.eth` still resolves (live-confirmed). |
| F-02 | major       | With every readable network empty **and** one unreadable, the view claimed nothing was found "on any supported network" and never showed the failed chain — a definitive claim about a network it could not read. Neither existing test covered that combination.                                                                                                     | The claim is now scoped to "the N networks that could be read", the unreadable count is stated, and `ChainBreakdown` renders in the empty state so the unavailable network is named. New E2E scenario covers exactly this combination.                                                                                                                                                                                                                                                    |
| F-03 | minor       | Changing networks rebuilt the URL by hand and dropped the validated `ens` parameter, so a portfolio reached by name lost its name on the first network change — a seam between the ENS work and the existing selector.                                                                                                                                                | `portfolioPath` moved from `server/addressRoute.ts` (behind `server-only`, so the client could not import it) to `domain/portfolioPath.ts`. Both the server redirect and the client selector now build links through one implementation.                                                                                                                                                                                                                                                  |
| F-04 | minor       | The E2E external-host guard was registered _before_ the API mock, and Playwright gives precedence to the most recently registered route; the API handler validated neither origin nor address. Traffic aimed at a third-party host, or at the wrong wallet, could have passed.                                                                                        | Guard registered last; the handler checks origin and address itself rather than relying on route precedence; the mock records requested chain ids so a fan-out regression is assertable.                                                                                                                                                                                                                                                                                                  |
| F-05 | minor       | `coverage.token-list-aged` was prefixed with its chain name by the aggregate combiner, producing "Ethereum Mainnet: The Ethereum token list…" — a spec deviation and another parallel-work seam.                                                                                                                                                                      | A `SELF_DESCRIBING_CODES` set exempts warnings that already name their network from the prefix; the code stays namespaced so React keys remain unique.                                                                                                                                                                                                                                                                                                                                    |

### What the parallel-agent workflow cost and returned

Three agents, ~2,900 lines of implementation and tests, all three green on
`pnpm verify` in their own worktrees. The merge cost one real conflict
(`PortfolioView.tsx`: the ENS `ensName` prop against the progressive view's
`WalletAddress` typing) and produced two seams neither agent could have seen —
F-03 and F-05 — plus one integration gap in the empty state (F-02). The blocker
was in a single agent's own work.

The lesson for the next milestone: **isolated agents produce correct parts and
predictable seams.** Both seams were in shared surfaces (a URL builder, a
warning-rendering rule) touched by two agents who could not see each other.
Worth naming shared surfaces in the plan up front and assigning ownership of
each, rather than discovering the overlap at review time.

---

## Round 5 — M2-2 price cross-check

The finished cross-check diff (~1,000 lines across 28 files) reviewed against a
written list of the six invariants it was supposed to hold — credential handling,
decimal discipline, never claiming unverified as verified, disputed-stays-in-total,
graceful degradation, and an honest summary denominator. Read-only, effort xhigh,
session `019fb873-ee79-7d42-bebf-9ca53fa4ec72`.
Verdict: **DO-NOT-SHIP — 7 high, 2 medium, 1 low.**

Seven adopted, four rejected with reasons. The review was worth its cost: two of
the findings were exactly the class of quiet overstatement this product exists to
avoid, and both were in code that passed 574 tests.

### Adopted

| ID   | Severity | Finding                                                                                                                                                                                                                                                                             | What was done                                                                                                                                                                                                                                                                                                                                                          |
| ---- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | high     | The summary said "and agreed" whenever nothing was **disputed** — including when every checked price came back `unverified`, i.e. asked and no answer. A confirmation reported that never happened.                                                                                 | `summarizePriceChecks` now counts `agreed` rather than inferring it from "checked minus disputed". `describeCrossCheck` gives each outcome its own clause. An E2E scenario holds the all-`unverified` case, which had no coverage at all.                                                                                                                              |
| F-02 | high     | Cross-check selection ranked **raw balances** — before spam detection and before the per-chain cap. A spoofed token with a fabricated price would rank first and spend the whole quota; and `checkedAssetCount` could exceed the denominator the summary quotes, printing "3 of 2". | `buildPortfolio` now runs once to decide what is worth checking, so selection sees exactly the assets that will be shown, with suspects filtered out. It is pure and does no I/O, so running it twice is cheaper than duplicating its rules — and it cannot disagree with itself. Counts are derived over the same non-suspect set, making N ≤ M true by construction. |
| F-03 | high     | A ref the verifier never reached — a batch the deadline cut off — came back as `unverified` rather than not-checked, and the warning's denominator shrank when the deadline expired early, so a total failure read as a small one.                                                  | Verifiers now return `attemptedRefKeys`; a ref that was never requested keeps `priceCheck: null`. The request count is computed up front rather than accumulated.                                                                                                                                                                                                      |
| F-04 | high     | `deriveDisputeWarnings` routed a decimal string through `Number` to round it for display — the one line in the file breaking the project's own rule.                                                                                                                                | Rounded in `Decimal`. This is the third time this rule has been broken in display code specifically, which is where it keeps happening.                                                                                                                                                                                                                                |
| F-05 | high     | Attribution was derived from the rendered rows, so it could vanish if a checked asset were truncated away, or appear when a deadline meant no request was ever made.                                                                                                                | Both closed by F-02 and F-03 — a checked asset is now always on screen, and an unasked ref carries no source tag. The two properties the component depends on are named in it, so a change that breaks them is visible.                                                                                                                                                |
| F-06 | medium   | Every failure became `crosscheck_partial`, including "all requests failed" and a rejected key. A dead or misconfigured verifier was reported as a partial success; `isAuthFailure` was exported and never called.                                                                   | All-failed now raises `unavailable`, which the caller turns into the single `crosscheck_unavailable` warning the spec always specified. A 401 stops immediately and logs at `error`: it is a configuration problem, and burning the remaining batches to reach the same answer wastes quota.                                                                           |
| F-07 | low      | A configured coverage of `0` still selected one asset.                                                                                                                                                                                                                              | Returns nothing. Zero coverage means switched off.                                                                                                                                                                                                                                                                                                                     |

### Rejected

| ID   | Finding                                                                                                                      | Why not                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | "Zod error paths include CoinGecko's contract-address record keys, which reach log lines" — reported as a privacy violation. | Tested rather than argued: the logged line reads `0xa0b8…eb48`. `redact`'s address rule abbreviates every address anywhere in a log line, so no full address leaks and the key never appears. Abbreviation is the designed behaviour, not a defect. **The useful half was adopted**: the existing guarantee was only tested on the HTTP-error path, so a schema-failure test now covers it too.                     |
| R-02 | CoinGecko's `usd` field is parsed as `z.number()` and so crosses a float boundary before reaching `decimal.js`.              | True, and identical to what the DefiLlama adapter has done since M1 (`price: z.number().finite()` → `numberToDecimalString`). A JSON number arrives as a double whatever the schema says; `numberToDecimalString` is the project's designated boundary. Changing one adapter would create an inconsistency without changing an observable value. Lossless JSON parsing is a project-wide question, not an M2-2 one. |
| R-03 | Tolerance and coverage enter as JS numbers.                                                                                  | They are dimensionless thresholds, not money, and `decimal.js` converts them exactly. No observable defect, and no test can be written that fails.                                                                                                                                                                                                                                                                  |
| R-04 | The wire schemas should refine `checkedAssetCount` / `disputedAssetCount` against the assets array.                          | No count in this schema is cross-validated — `assetCount`, `pricedAssetCount` and `suspectAssetCount` all trust the builder, which is the single producer. Refining only the two new fields would be arbitrary. Addressed where it matters instead: the **displayed** counts are now derived from the rows, so the summary cannot contradict the table.                                                             |

### What this round is evidence of

Both F-01 and F-02 were live in code that passed the full suite, and both are
honesty defects rather than crashes — the summary would have said something untrue
in a state no test constructed. The tests asserted the behaviour that had been
thought about; the review found the states that had not been.

It also caught something a reviewer is unusually well placed to catch: `AssetTable`
justified marking only disagreements by pointing at "the summary [which] states how
many prices were actually checked". That summary line did not exist. A comment can
assert a property the code does not have, and nothing fails.

---

## Round 6 — the M3 plan, before implementation

`docs/M3_PLAN.md` reviewed against a written list of six standing constraints
before any code existed. Read-only, effort xhigh, session
`019fc6d5-21bb-7c93-9c45-b594d5365bc9`.
Verdict: **REVISE — 8 blockers, 6 concerns.**

Almost everything was adopted. Three of the blockers were this project's _own past
mistakes recurring in a new feature_, which is the finding that makes the round
worth its cost: knowing a lesson and having written it down turns out not to
prevent rebuilding the same defect from scratch somewhere else.

### Adopted

| ID   | Severity | Finding                                                                                                                                                                                  | What changed                                                                                                                                                                                  |
| ---- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | blocker  | The historical lookup had no attempted-ref metadata, so a deadline cutting a batch short would be indistinguishable from the source having no price. **Round 5's F-03, rebuilt.**        | `AttemptedLookup` extracted and shared by the verifier and the history lookup; four `ChangeStatus` values instead of two.                                                                     |
| F-02 | blocker  | A change figure would be computed from a **disputed** price. A price can be `priceQuality: 'ok'` and still contradicted by the second source; ADR-019 prefers neither.                   | `isUsableCurrentQuote` suppresses on `disputed` as well as on quality. The draft checked only quality.                                                                                        |
| F-03 | blocker  | Historical timestamps were not retained, so a point 30 h old could be labelled "24 h". `assessPriceQuality` compares to `now` and would call every legitimate 7-day point stale.         | `asOf` retained; drift against the requested instant checked (±6 h / ±24 h); out-of-tolerance points become `unusable` rather than being relabelled.                                          |
| F-04 | blocker  | `formatPercent` rounds to two places, so a real 0.004 % change would render `0.00%` — the plan's own text said that means "unchanged".                                                   | `isBelowDisplayPrecision`; those render `<0.01%`. Negative zero normalised.                                                                                                                   |
| F-05 | blocker  | M3-5 specified an adapter and a formatter with nothing between them: no provider contract, no registry wiring, no response field, no deadline. The rate would be fetched by the browser. | `RateProvider` / `FxQuote`, fetched server-side inside the shared deadline, carried on the response, validated by the client. Browser→ECB would leak that the visitor is viewing a portfolio. |
| F-06 | blocker  | Insight denominators were dishonest: "3 of 55 assets make up 99 %" counts unpriced and spam rows, and one unpriced valuable holding makes the claim unsupportable.                       | Every numerator and denominator is the priced, non-suspect set, and the panel says so.                                                                                                        |
| F-07 | blocker  | No behaviour defined for progressive loading: the panel would say "100 % sits on Ethereum" while four networks were still arriving. **Round 4's F-02 class.**                            | `networksComplete` is a required argument; cross-network insights are withheld until every network has settled.                                                                               |
| F-08 | concern  | "Two extra calls per chain" was false above 60 refs — the 400-asset ceiling allows 14 per chain, 70 per load.                                                                            | `PRICE_HISTORY_MAX_ASSETS` (default 50) caps it at 2 per chain. The wrong figure was in the plan, not the code.                                                                               |
| F-09 | concern  | History would be selected before spam detection and truncation. **Round 5's F-02, rebuilt.**                                                                                             | Selected from the built portfolio, reusing the pattern the cross-check already uses. `portfolioService.ts` added to the plan's surface-ownership table, where it had been missing.            |
| F-10 | concern  | `formatMoney(value, {currency, rate})` cannot carry the rate's date, and `ChainBreakdown` was missing from the surface list — so EUR totals could sit beside unconverted USD.            | One immutable `DisplayContext` supplied by React context, not props. A missed component then cannot compile away silently — it simply cannot happen.                                          |
| F-11 | concern  | Putting formatted sentences in `domain/insights.ts` inverts the dependency: `lib/format.ts` already imports from `domain/`.                                                              | The domain returns structured facts and decimal strings; phrasing lives in `InsightsPanel`.                                                                                                   |
| F-12 | concern  | A global address→classification map mis-classifies, since the same address is unrelated contracts across chains.                                                                         | Keyed by `(chainId, lowercased address)`, with a note and review date per entry.                                                                                                              |
| F-13 | concern  | "Follows the US dollar" is a present-tense claim an address cannot prove — a depeg invalidates it.                                                                                       | "**Designed to track**", everywhere, with the holding form named separately.                                                                                                                  |
| F-14 | —        | The stated build order (M3-5 → M3-4 → M3-3) was justified by a dependency that does not exist: none of the listed insights cites a change figure.                                        | Reordered to M3-4 → M3-5 → M3-3, settling the hardest contract first. The reviewer was right and the plan's stated reason was wrong.                                                          |

### Rejected

| ID   | Finding                                                                                                                 | Why not                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | Historical prices inherit the `z.number()` → decimal-string boundary, so they cross a float before `Decimal` sees them. | Third time this has been raised (round 5 R-02). Identical to what the current-price path has done since M1; a JSON number arrives as a double whatever the schema says, and `numberToDecimalString` is the designated boundary. Changing one call site would create an inconsistency without changing a value. Genuinely a project-wide question about lossless JSON parsing, not an M3-4 one. |
| R-02 | Defer "what the value tracks" entirely, as the one insight needing a curated registry.                                  | Kept. On the benchmark wallet it is the single most informative line the panel produces — a near-exact thirds split across ETH, USD and BTC that is invisible when scanning rows. The mitigation is the conservative registry plus a **visible unclassified share**, so a thin registry degrades to an honest "we do not know" rather than a wrong bucket.                                     |

### What this round is evidence of

Three findings (F-01, F-07, F-09) were defects this project had already found,
fixed, and written an ADR about — reappearing because a new feature reasoned from
scratch instead of from the earlier one. Writing the lesson down was not enough;
the reviewer reading both the plan and the prior ADRs is what caught it.

The most instructive one is F-04. Nothing about `formatPercent` rounding to two
decimals is subtle, and the plan itself asserted that `0.00%` means "unchanged".
Holding those two sentences next to each other is all it took, and neither the
author nor the test suite did.

---

## Round 7 — the M3-1 plan, before implementation

`docs/M3-1_PLAN.md` reviewed against the seven standing constraints before any code
existed. Read-only, effort xhigh, session `019fc7e9-eee1-7e73-b1d6-bcae069c3f20`.
Verdict: **REVISE — 7 blockers, 6 concerns.**

The most useful round so far, because two of the plan's own stated premises turned
out to be **factually false about this codebase**, and the review's scope
recommendation changed what gets built rather than only how.

### The two false premises

| Claim in the plan                                                                                                        | Reality                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Display converts through the existing `DisplayContext`, so a euro figure on the landing page is labelled as elsewhere." | `DisplayProvider` is mounted **inside `PortfolioView`**. The landing page has no provider, and the FX rate arrives on the portfolio payload the landing page never fetches. The sentence describes something impossible. |
| "The storage shape is chosen with M3-2 in mind, because a bundle is a saved set of the same addresses."                  | M3-2 is specified in `DEV_PLAN.md` as "pure computation, shareable as a URL, **no storage**". It constrains nothing. The premise was invented.                                                                           |

Both were written confidently in a document whose whole purpose is to be checked
before code exists. Neither would have failed a test; both would have produced work
built on a false foundation.

### Adopted

| ID   | Severity | Finding                                                                                                                                                                                                                                                                                | What changed                                                                                                                                                                                                                                                           |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | blocker  | `lastSeen` stored a bare total, discarding **scope**. A portfolio total is a scoped priced subtotal — one network or five, failed networks excluded, unpriced assets outside it — so `$104,527` on the landing page could present a single-chain partial figure as the wallet's worth. | Cached totals **cut from the release** (see scope, below). When they return they must carry scope, a terminal outcome, and their own date.                                                                                                                             |
| F-02 | blocker  | "Write on successful load" cannot implement the plan's own rule that a failed view carries no figure: after an earlier success, a failed refresh writes nothing and the stale figure survives. Saving while data was already loaded would also read as "never opened".                 | Same cut. The underlying lesson — that "success" is not one state — is recorded for the follow-on.                                                                                                                                                                     |
| F-03 | blocker  | Landing-page EUR conversion is impossible with the proposed data and component tree.                                                                                                                                                                                                   | Same cut; and the false sentence is named above rather than deleted.                                                                                                                                                                                                   |
| F-04 | blocker  | Corrupt, blocked, or unknown-version storage all became an indistinguishable empty list. "You have no saved wallets" is a claim, and a later save would overwrite data the code never understood. Losing a wallet list is not losing a theme.                                          | A read now returns one of **five** outcomes: `ok`, `empty`, `partially-invalid`, `unsupported-version`, `unavailable`. Only `empty` may say "none saved"; `unsupported-version` refuses to write.                                                                      |
| F-05 | blocker  | Ordering by value mandated no decimal comparison, against ADR-003's explicit requirement to sort money with `Decimal.cmp`.                                                                                                                                                             | Ordering is now by `savedAt` with an address tie-breaker — total and stable. The `compareDecimal` requirement is recorded for when totals return.                                                                                                                      |
| F-06 | blocker  | The 24-hour staleness cutoff did not advance while a page stayed open, and invalid or future timestamps were undefined (`formatRelativeTime` reports a future time as "just now").                                                                                                     | Cut with the totals. `savedAt` is still validated against implausible future dates.                                                                                                                                                                                    |
| F-07 | blocker  | `useSyncExternalStore` cannot be copied literally for a list. Theme and currency return **primitives**, so reparsing per snapshot is harmless; a freshly parsed array looks changed on every read, which React treats as an endless update.                                            | The snapshot is cached and keyed by the raw stored string, with a frozen empty server snapshot. This would have been a runtime loop on first render.                                                                                                                   |
| F-08 | concern  | Only the label and the list length were bounded; `ensName`, timestamps and the raw payload were not, and duplicate addresses were undefined.                                                                                                                                           | Every string bounded, raw payload capped at 32 kB, ENS revalidated, duplicates deduplicated case-insensitively with the earliest winning, and hitting the 50-entry cap refuses visibly.                                                                                |
| F-09 | concern  | `localStorage` has no transactional read-modify-write, so two tabs mutating at once can clobber each other despite the storage event.                                                                                                                                                  | Every write re-reads immediately before mutating; last-writer-wins is stated, and a two-tab conflict is a test.                                                                                                                                                        |
| F-10 | concern  | React escaping only prevents HTML execution. A label can carry Unicode bidi overrides that visually reverse the address next to it.                                                                                                                                                    | `U+202E` and friends stripped; the canonical address is always shown and never replaced by a label.                                                                                                                                                                    |
| F-11 | concern  | **Hypothesis:** `next/link` prefetches on viewport entry in production, so listing saved wallets would send every address to the app server before any click — defeating the feature's central privacy claim.                                                                          | Treated as true, because the cost of being wrong is the whole claim. `prefetch={false}` on every row, links use the canonical address rather than the ENS name, and the E2E assertion counts requests **mentioning a saved address**, not just `/api/portfolio` calls. |
| F-12 | concern  | Rows whose stale total was withheld were still ordered by that hidden total, leaking relative values and reshuffling for invisible reasons.                                                                                                                                            | Ordering no longer uses value at all.                                                                                                                                                                                                                                  |
| F-13 | concern  | "ADR-002 holds" contradicts ADR-002, whose own consequences say watchlists are the feature that introduces Postgres.                                                                                                                                                                   | The item now ships an ADR superseding that clause and drawing the line: browser-local preference data is not server persistence.                                                                                                                                       |

### The scope change

Review's answer to "is anything here worth building much more simply" was the most
valuable single output: **cached totals, value ordering and labels carried most of
the risk**, and four of the seven blockers were about the cached total alone.

Put to the owner as an explicit choice with both versions mocked up. They chose the
lean release: **saved addresses, labels, one click to open, no money figures.** The
totals become a follow-on with the observation shape designed properly — scope,
terminal outcome, and date — rather than bolted onto a field that cannot carry them.

Also adopted from the answers: the feature is called **"Saved wallets"**, not
"Watchlist", because nothing refreshes in the background and the name should not
promise that. And the plan's rate-limit argument was **overstated** — the aggregate
endpoint costs one limiter token per wallet, not five.

### Rejected

| ID   | Finding                                                                                                                                         | Why not                                                                                                                                                                                                                                                                                                              |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01 | Withholding a stale total past 24 h is wrong; keep it, de-emphasised and dated, since the product elsewhere labels rather than hides (ADR-005). | **Accepted in principle, moot in practice.** The reasoning is right and corrects an over-application of a rule about prices feeding a total: "the value seen at time T" stays true, and hiding it loses information. Recorded for the follow-on. No code follows from it in this release, because the figure is cut. |

### What this round is evidence of

The previous six rounds found defects in code or in reasoning. This one found two
**factual errors about the codebase** in a document written by the person who had
just modified that codebase — the `DisplayProvider` claim was false about a
component mounted earlier the same day.

A plan is the cheapest place to be wrong and the most expensive place to be
confidently wrong, because everything downstream inherits it. Reviewing it against
the actual code, rather than against its own internal logic, is what caught these.

---

## Round 8 — the M3-2 plan, before implementation

`docs/M3-2_PLAN.md` reviewed against the seven standing constraints before any code
existed. Read-only, effort xhigh, session `019fcc74-0201-72f3-a84b-f9f029251f4e`.
Verdict: **REVISE — 8 blockers, 7 concerns.**

Everything adopted. Two findings are worth reading even if the rest is skipped: one
corrected the plan's central factual claim, and one cut the feature element carrying
most of its risk — the same shape of finding as round 7, on a different feature.

### The plan's headline claim was false

The draft argued that requesting each network separately for ten wallets would cost
"50 rate-limit tokens against a limit of 30, so the last four wallets would fail".

`RateLimiter` gives an unidentified client `maxRequests * 10`, and with
`TRUST_PROXY_HEADERS=false` — the default, deliberately (ADR-008) — every caller
resolves to the shared unknown bucket. **The real default allowance is 300 per
minute.** Fifty requests would not have been refused by anything.

The endpoint choice survives for a different and better reason, which the review
supplied: both paths do the same 50 cold per-chain loads and share the same cache, so
what actually differs is **concurrency shape** — an unbounded browser fan-out of 50
versus ten aggregate handlers each bounded at `CHAIN_SCAN_CONCURRENCY`, so 30. And 30
simultaneous chain loads from one link is still a burst nothing prevents, because that
setting is per request and nothing was per bundle. The revised plan adds
`BUNDLE_MEMBER_CONCURRENCY` and tests **concurrent chain loads rather than browser
requests** — counting requests is exactly what made the wrong reasoning look sound.

### Adopted

| ID   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                    | What changed                                                                                                                                                                                                                              |
| ---- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | blocker  | A merged cross-wallet row cannot carry the price state of its parts. `priceUsd`, `priceQuality`, `priceCheck` and both change fields are singular, and the table renders one of each. A stale disputed quote in one wallet and an unchecked one in another either hides the uncertainty or attributes it to the whole balance — and breaks "N of M prices were checked", the sentence round 5 found lying. | **Row merging cut.** One row per wallet position, with a Wallet column.                                                                                                                                                                   |
| F-02 | blocker  | "Not a new arithmetic path" was false for quantities. `sumMoney` rounds to 8 decimal places; a token quantity may carry 36, with the exact value in `rawQuantity` base units. Two balances of `0.000000004` would not reliably survive as `0.000000008`.                                                                                                                                                   | Same cut. Recorded that correct summing means adding `bigint` base units after proving decimals match.                                                                                                                                    |
| F-03 | blocker  | `BundlePortfolio` carried no warnings and no coverage state, so "the sum of the priced assets on the networks that could be read" overstated: a wallet can be read and still have enumerated only a token list, or stopped at the asset ceiling.                                                                                                                                                           | Every member warning preserved and scoped by wallet; identical ones combined, as the aggregate view already does per chain.                                                                                                               |
| F-04 | blocker  | Progressive states were underspecified. One empty member with two pending would print a bundle-level "No assets found", speaking for wallets not yet read. All-failed would render the null-total sentence "No prices available" — a claim about prices when nothing was read. And "2 of 3 wallets" counts a failed wallet as covered.                                                                     | Four distinct counts — `total`, `settled`, `readable`, `failed` — and the summary says "1 of 3 wallets readable". No emptiness conclusion before every member settles; all-failed renders as named failures; refresh replaces atomically. |
| F-05 | blocker  | The cost claim understated cold work and missed that `CHAIN_SCAN_CONCURRENCY` is per request, not per bundle: ten aggregate handlers permit 30 concurrent chain loads.                                                                                                                                                                                                                                     | `BUNDLE_MEMBER_CONCURRENCY` (2), and the test counts concurrent loads.                                                                                                                                                                    |
| F-06 | blocker  | Redirecting when only one address was valid would erase the "we rejected this input" notice the plan's own honesty rules demand — the page cannot say what it dropped if it is no longer the page.                                                                                                                                                                                                         | A one-member bundle renders as a bundle. Redirect only when there is nothing to report. Parsing returns a structured result carrying rejects, duplicate count and omitted count.                                                          |
| F-07 | blocker  | `fetchedAt` had no derivation rule, and the aggregate endpoint stamps assembly time even when its chains came from cache — so a bundle could print "updated just now" about minute-old data.                                                                                                                                                                                                               | Derived from the oldest `Portfolio.fetchedAt` across every successful member chain, as `progressiveAggregate.ts` already does.                                                                                                            |
| F-08 | blocker  | "View together" would prefetch a URL containing up to ten saved addresses on panel render, handing the server the whole saved list before any click.                                                                                                                                                                                                                                                       | A plain anchor, like every other row there, with the existing zero-request assertion extended to cover it. This is the M3-1 finding recurring one commit later.                                                                           |
| F-09 | concern  | A singular bundle `fxRate` had no conflict rule; ten independent responses do not share one, and "first non-null" could put EUR figures beside a `rates.unavailable` warning saying figures are USD-only.                                                                                                                                                                                                  | Convert only when every readable member agrees on `asOf`; otherwise no EUR, and say why.                                                                                                                                                  |
| F-10 | concern  | `failure` per member, plus `failedAddresses`, plus eight scalar counts: three representations of the same facts, any two of which can drift.                                                                                                                                                                                                                                                               | One canonical member map; totals, counts, failures and warnings are selectors over it. A shared totals reducer is extracted so both axes compute subtotals through one implementation.                                                    |
| F-11 | concern  | Validation, de-duplication and the cap had no stated order, and the raw path was unbounded — twelve junk segments could crowd out two real addresses.                                                                                                                                                                                                                                                      | Bound raw input first (2 kB, 32 segments), then validate, then de-duplicate, then cap.                                                                                                                                                    |
| F-12 | concern  | The merge key did not lowercase the contract address, and `null` must stay the one native identity per chain.                                                                                                                                                                                                                                                                                              | Moot with merging cut; the identity rule is recorded for when it returns.                                                                                                                                                                 |
| F-13 | concern  | Dust and suspect counts become ambiguous once rows merge — two $0.60 positions become a $1.20 primary row, and one spam token across three wallets is one row but three occurrences.                                                                                                                                                                                                                       | Moot with merging cut.                                                                                                                                                                                                                    |
| F-14 | concern  | The bundle route did not specify robots metadata, though the wallet route sets `noindex, nofollow`. A bundle URL discloses an association between addresses, which is more sensitive than either alone.                                                                                                                                                                                                    | `noindex, nofollow`, and the raw list stays out of the title and description.                                                                                                                                                             |
| F-15 | —        | `bundlePortfolioSchema` was specified for data that never crosses a wire or a persistence boundary.                                                                                                                                                                                                                                                                                                        | Dropped. The bundle is computed in the browser from member responses.                                                                                                                                                                     |

### What this round is evidence of

Round 7 found two factual errors about the codebase in a plan. Round 8 found one
more — and it was the plan's _headline argument_, the thing the whole design was
justified by, stated with a specific number.

The pattern is now clear enough to name: **the most dangerous sentence in a plan is
the confident quantitative one.** "50 tokens against a limit of 30" reads as though
someone measured it. Nobody had; it was inferred from a default that a second default
overrides ten lines away in the same file. Prose that sounds measured gets less
scrutiny than prose that sounds uncertain, which is exactly backwards.

The corollary for this project's own habit: measuring the _provider_ before building
against it has been done religiously since ADR-005. Measuring **our own code** before
reasoning about it has not, and that is where the last two rounds' worst findings came
from.

---

## Round 9 — M2-5(b), after implementation

**What was reviewed.** The finished, uncommitted M2-5(b): a scheduled workflow that
regenerates the five token lists monthly and opens a pull request, plus the drift guard
that compares the regenerated lists against the committed ones. Codex read-only, with
the working tree in place — the first round in this project to review code rather than
a plan.

Five findings adopted, one rejected with a reason, one deferred to observation.

| ID   | Severity                  | Finding                                                                                                                                                                                                                                                                     | What changed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | blocker                   | The removal test is _gross_ and both thresholds must hold, so the five lists can shed **268 tokens in one run** — 2.2 % of all coverage — and report nothing. The guard's stated property was that coverage cannot shrink silently. Codex computed the number; it is exact. | A second, sharper test: a **net** decrease over 5 per chain is a finding on its own. Additions normally mask removals — every chain grew over the measured five days — so a chain that ends smaller is already the anomaly. The per-run bound falls to **25 tokens, 0.20 %**, measured the same way. The gross test stays: it catches a truncation whose losses are hidden by an equal number of new listings.                                                                                                                                                        |
| F-02 | concern                   | `relabelled` was counted but never a finding, so every name and symbol on a chain could be replaced and the title would read `+0 / -0 tokens`. Names are what the app displays and what M2-1's symbol-spoof check uses as its whitelist.                                    | A mass-rename finding at rank 2, and the report now lists renames as pairs — old label beside new — because a rename is only judgeable as a pair.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| F-04 | concern                   | `sourceVersion` is interpolated into the report's table straight from upstream, and the generator builds it from `version.major/minor/patch` without validating them. A pipe or newline there breaks the table apart.                                                       | Routed through the same `visible()` escaping as names and symbols.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F-05 | blocker                   | Creating a pull request with `GITHUB_TOKEN` needs Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests". Codex flagged the repository's setting as an open question.                                                                    | Measured instead of assumed: `gh api` reports `can_approve_pull_request_reviews: false`, so the first run **would** have failed. The step now names that exact setting on failure and prints a compare URL, and the branch is pushed before the attempt so nothing is lost.                                                                                                                                                                                                                                                                                           |
| F-03 | rejected                  | Anomalous list _growth_ is not flagged, and a bloated list could create enough RPC batches to hit the request deadline, reducing effective coverage.                                                                                                                        | Rejected, with a reason: that degradation is already honest — `rpcTokenList.ts` reports "the balance scan ran out of time with N of M batches unchecked". And additions are the normal mode of upstream change, so flagging them is precisely the alert fatigue the design set out to avoid.                                                                                                                                                                                                                                                                          |
| F-06 | adopted — Codex was right | The comment claiming a pull request opened by `GITHUB_TOKEN` triggers no workflow run is out of date; GitHub may now create approval-required runs.                                                                                                                         | Deferred to observation rather than settled from documentation, because this is exactly the kind of claim this project keeps getting wrong. The first real run answered it and **Codex was right**: GitHub creates a `pull_request` run and parks it in `action_required`, so `gh pr checks` says "no checks reported" while a run waits indefinitely. Corrected in the workflow, the ADR and the pull request text. It also strengthens the design rather than weakening it — a pending check reads as one that might still pass, which is worse than an absent one. |

Codex also confirmed what it could not fault: shell quoting, single-line
`$GITHUB_OUTPUT` values, the persisted checkout credentials, the same-month update
path, and no injection reachable through a shell — names travel node → file →
`--body-file`, never through an argument.

**Two caveats on this round's own weight.** The workflow file was edited while Codex
was reading it, so its view of that file may mix two versions. And its sandbox could
not run vitest, so nothing it says about the tests was executed.

### What this round is evidence of

Rounds 7 and 8 found confident quantitative claims about our own code that were wrong.
This round found the same shape one level up: **a guard whose stated property was
stronger than its arithmetic.** "Coverage cannot shrink silently" was the intent; the
implementation permitted 2.2 % per run. Nobody had computed the bound, because the
threshold was chosen by reasoning about plausible churn rather than by asking what the
worst permitted case was.

The habit worth adding: when a check exists to enforce a property, compute the largest
violation it still allows, and put that number in the file. Both bounds — 268 and 25 —
are now in `tokenListDrift.mjs`, so the next person to touch a threshold can see what
it costs.

### Addendum, same day — the owner's question found a seventh finding

Codex reviewed the guard and the workflow's mechanics thoroughly. It did not question
the **schedule**, and neither had I beyond a sentence in the workflow asserting that a
weekly run "would mostly open pull requests that say nothing changed".

The owner asked: "why only once a month? is that really enough?" The measured churn was
already in the file two paragraphs away — 24 added and 5 removed in five days, roughly
34 a week — so the assertion was not merely unsupported, it was contradicted by this
project's own measurement. A weekly run has real content every time.

The design changed the same day: weekly, with the drift verdict deciding whether a run
lands on `main` unattended or becomes a pull request. Better on both axes — fresher
lists, fewer interruptions — at the cost of making the guard load-bearing, which is
recorded in the ADR rather than glossed.

**What this is evidence of.** Three rounds have now found wrong quantitative claims
about our own system, and this one was found by a non-technical question rather than by
a reviewer reading code. The reviewer checked whether the mechanism worked; nobody
checked whether the _policy_ was justified, because the justification was a fluent
sentence sitting in a comment. Fluency is not evidence, and a plain question — "is that
really enough?" — is a better test of a justification than a technical one.

---

## Round 10 — the self-update mechanism, after implementation

**What was reviewed.** The pull-based deployment shipped the previous evening:
`scripts/self-update.sh` (runs unattended on the target), `scripts/assemble-bundle.sh`,
the reworked `deploy.sh`, and `ci.yml`'s publish step. Requested by the owner —
"why not also asking codex if is this a good solution" — and the answer was
**VERDICT: FAIL, 17 findings**, several of them the kind that only hurt at 3am.
The review ran while the mechanism was still inert (no token on the box yet), which
turned the worst finding into a near-miss instead of an incident.

Twelve adopted, three partially, two rejected with reasons.

| ID   | Severity | Finding                                                                                                                                                                                                                                                                    | Disposition                                                                                                                                                                                                                                                                                                                                  |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | critical | The updater's repository-write token was to live in `~/nuxfolio/env` — which the app's unit loads — while `ReadWritePaths=%h/nuxfolio` let the internet-facing app rewrite the updater script itself. App compromise → token theft → sandbox escape on the next timer run. | **Adopted, before the token existed.** Token moved to `~/nuxfolio/updater-env`, read by nothing but the updater; the app's writable surface narrowed to `~/nuxfolio/app/.next/cache`.                                                                                                                                                        |
| F-02 | critical | The whole verify job held `contents: write` while running checkout, install and tests — code a same-repository pull request controls — with checkout's persisted credential in the workspace.                                                                              | **Adopted.** Workflow defaults to `contents: read`; publishing moved to its own job with the only writable token, and that job runs no project code at all — no checkout, no install, just artifact download and upload.                                                                                                                     |
| F-09 | high     | Publishing happened inside `verify`, with no dependency on `e2e` — a build whose end-to-end suite was failing could ship to the target.                                                                                                                                    | **Adopted.** The publish job `needs: [verify, e2e]`.                                                                                                                                                                                                                                                                                         |
| F-04 | high     | `deploy.sh` rsyncs into the app directory without stopping the timer; a run firing mid-copy would move the directory rsync is writing into.                                                                                                                                | **Adopted.** The timer is stopped before shipping and restarted after — by a trap too, so a failed deploy does not also silently disable auto-updates.                                                                                                                                                                                       |
| F-07 | high     | A build that fails its health check is retried every 15 minutes forever, each attempt restarting the working copy.                                                                                                                                                         | **Adopted.** A rejected checksum is quarantined until the published checksum changes.                                                                                                                                                                                                                                                        |
| F-08 | high     | Crash-orphaned work directories accumulate; no free-space check before download; no size bound on the archive; a compression bomb could fill the shared disk.                                                                                                              | **Adopted** (the cheap, real parts): stale work dirs pruned under the lock, 500 MB free-space floor, 200 MB archive sanity bound, `Nice=10`. CPU/IO quotas skipped — extraction of a 13 MB archive is ~1 s.                                                                                                                                  |
| F-11 | medium   | `Type=oneshot` with no timeout: Ubuntu disables start timeouts for oneshot units, so one hung download holds the update lock forever and ends all future updates.                                                                                                          | **Adopted.** `RuntimeMaxSec=600`.                                                                                                                                                                                                                                                                                                            |
| F-10 | medium   | The health check was one `GET /` — a bundle serving unstyled HTML (404ing stylesheets) or a broken API route reads as healthy and permanently replaces the rollback copy.                                                                                                  | **Adopted.** Three probes: the page, one real stylesheet parsed out of it, and `/api/portfolio` with a malformed address expecting 400 — proves the API validates without one upstream call.                                                                                                                                                 |
| F-12 | medium   | Tag reporting is non-fatal (right) but the unchanged fast path exits before retrying it, so one API hiccup leaves the liveness signal stale until the next build.                                                                                                          | **Adopted.** A failed tag move is recorded and retried on every run, including the fast path.                                                                                                                                                                                                                                                |
| F-15 | later    | The deploy script grepped for `GH_TOKEN=` without exercising it; fine-grained tokens default to 30-day expiry and die with nothing but a journal line.                                                                                                                     | **Adopted.** The deploy exercises the token against the release API and says "present but NOT WORKING" when it fails; the ADR tells the owner to set expiry deliberately.                                                                                                                                                                    |
| F-16 | later    | No deterministic build id, so rebuilding the same commit changes the checksum and pointlessly restarts the live site.                                                                                                                                                      | **Adopted.** `generateBuildId` is the commit SHA in CI; local builds keep the default.                                                                                                                                                                                                                                                       |
| F-17 | note     | `Persistent=true` on a timer with only monotonic triggers does nothing — it only affects `OnCalendar`.                                                                                                                                                                     | **Adopted** — removed, with the reasoning in the unit: missed runs do not matter when only the newest build does.                                                                                                                                                                                                                            |
| F-03 | high     | The two-rename swap is not transactional: power loss between them leaves no app directory, and a `set -e` failure mid-rollback could abandon it half-done. Proposed immutable release dirs behind an `app` symlink.                                                        | **Partial.** The rollback path now tolerates each step failing and verifies the restored copy answers. The symlink redesign is rejected: the window is two same-filesystem renames, and it _self-heals_ — `.deployed-sha256` is only written after health, so the next timer run re-installs cleanly. Accepted and documented in the script. |
| F-05 | high     | `--clobber` publish is not atomic; a cancelled run can leave mixed assets.                                                                                                                                                                                                 | **Partial.** The tarball now uploads strictly before the checksum — the checksum is the trigger the target polls, so an interrupted publish leaves the old trigger in place and the target stays put. The manifest redesign is rejected as a second mechanism for the same guarantee.                                                        |
| F-06 | high     | A checksum/tarball pair from different builds is not always "blocked until the next push".                                                                                                                                                                                 | **Partial — same fix.** With the trigger uploaded last, the mixed state the target can observe is new-tar-plus-old-checksum, which reads as "nothing new". The genuinely bad orderings require the trigger to change first, which the upload order now rules out.                                                                            |
| F-13 | medium   | `Contents: write` on the target's token is more than tag-moving needs; a stolen token can replace release assets and feed the updater an attacker's build.                                                                                                                 | **Rejected, with the trade named.** No narrower fine-grained permission moves a git ref, and the tag is the liveness signal the weekly check reads. The mitigation is F-01's isolation: the token is no longer reachable from the app, and the remaining holder — the box — already holds an SSH identity worth more than this token.        |
| F-14 | medium   | Actions pinned by tag not SHA; runner, dependencies and anything on `main` are all trusted; the checksum authenticates nothing.                                                                                                                                            | **Rejected as action, adopted as documentation.** For a private solo repository using only GitHub-authored actions, `main` _is_ the trust root and pinning theatre would not change that. The ADR now states what the checksum does and does not protect against, instead of letting it imply more.                                          |

Also confirmed by the review rather than found: asset retention (release assets do not
expire like workflow artifacts), the memory ceilings, and the lock design.

### What this round is evidence of

The worst finding was not subtle — a write-capable credential readable by the most
exposed process on the machine — and it was in the design I had just described to the
owner as the safer alternative to giving GitHub a Tailscale key. It was invisible for
the same reason as ever: the design _narrative_ was about which network boundary the
credential crossed, so nobody looked at which processes could read the file it landed
in. The owner's "why not also ask codex" was the entire reason a second reader looked
before the token existed.

The pattern for the working agreement: adversarial review of _mechanisms that will run
unattended_ is not optional polish — nobody is present when they fail, so the review is
the only chance for several classes of defect to be found before they are incidents.

---

## Round 11 — the ENS render-path gate, after implementation

**What was reviewed.** ADR-025's gate, committed an hour earlier: `ensGate.ts`, its
tests, the page wiring, and every other path that could reach an `eth_call` during a
server render. Requested because the fix closed a standing security prerequisite and
the owner had just asked about going public.

**VERDICT: FAIL — with no bypass found.** The distinction matters: Codex verified the
hole was actually closed everywhere it looked, then failed the review on the boundary
being _fail-open_ and the tests not pinning it. That is a better finding than a bypass
would have been, because a bypass is one bug and this was a whole class.

| ID   | Severity | Finding                                                                                                                                                                                                                                                                          | Disposition                                                                                                                                                                                                                                                                                                                            |
| ---- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-04 | medium   | All six tests inject both limiter and resolver, so they test the gate in isolation and never prove the _page_ uses it — while `addressRoute.ts` kept `resolveEnsName` as a fallback. Deleting one line in `page.tsx` would reopen the vulnerability with every test still green. | **Adopted, and it was the most valuable finding.** `resolve` is now mandatory in `PortfolioRouteInput` — no default, so removing the wiring is a _type error_. Plus four page-boundary tests that read the source. Confirmed by mutation: removing the gate fails 3 of them.                                                           |
| F-03 | medium   | The `rate-limited` reason was discarded by `resolvePortfolioRoute`, so a throttled lookup rendered under "That address does not look right" — telling the visitor to re-check a spelling that was fine.                                                                          | **Adopted.** The reason survives to the page, which renders "Too many name lookups just now". A real 429 is rejected: this is a rendered page, not an API response, and moving it to a response-capable layer would trade a clear message for a status code nobody sees.                                                               |
| F-01 | high     | `resolveClientId` accepts any ≤64-char string as an identity without validating it as an IP. With `TRUST_PROXY_HEADERS=true` and a header the proxy merely _forwards_, an attacker rotates values for fresh budgets.                                                             | **Adopted as documentation, deferred as code.** Pre-existing in ADR-008 and affects the API identically, so fixing it here would fix half a thing. It cannot bite today (`TRUST_PROXY_HEADERS=false`, tailnet-only) and it is now a named row in DEV_PLAN Part 6 — the configuration that must be verified _before_ public, not after. |
| F-02 | medium   | Denied requests still cost a Next render and a log line, so denial traffic is itself unmetered.                                                                                                                                                                                  | **Accepted, recorded.** Cannot be fixed inside the app: the render is what receives the request. Belongs at the edge (Caddy rate limiting), which is now a Part 6 row. Log sampling deferred — a warn line per denial is the operator signal, and volume only matters in the public scenario Part 6 gates.                             |

Also confirmed clean by the review, which is worth recording because each was a
plausible bypass: both `generateMetadata` implementations parse without resolving; the
bundle route refuses names outright; saved-wallet and bundle links are canonical `0x`
anchors; `AddressForm` navigates only on submit; there is no middleware; no in-app
link targets `/portfolio/<name>.eth`; and the module-level limiter is a genuine
per-process singleton rather than something rebuilt per request.

### What this round is evidence of

The gate was correct. What was missing was any reason to believe it would _stay_
correct — the tests described the mechanism rather than the property, and the module
still offered the unsafe path as a default. "Fail-open with green tests" is the shape
to look for: a security fix whose absence is invisible to its own suite.

The check that settled it was a mutation, not an argument: delete the gate, watch three
tests go red. That is the same move as measuring contrast instead of judging colour by
eye, applied to a guarantee rather than a value — and it is now the standard for
security work here, because a test that cannot fail proves nothing about a property it
claims to protect.

---

## Round 12 — the M5 plan, before implementation

**What was reviewed.** `docs/M5_PLAN.md`, written the same morning and reviewed before
a line of code existed. The subject is protocol accounting — reading Aave v3 debt and
health factors, the last unmet item in the original brief.

**VERDICT: CHANGES REQUIRED — 9 findings, two of them critical**, and both criticals
would have produced numbers that were simply wrong on screen.

| ID   | Severity | Finding                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                                                                    |
| ---- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01 | critical | The plan said the health factor is ray-scaled (1e27). It is **18 decimals**. A real `1.04` would have rendered as `0.00000000104`.                                                                        | **Adopted.** And the plan contained its own disproof: the probe printed `1.157e+59` for the no-debt sentinel, which is uint256 max ÷ 1e18. Divided by 1e27 it would be `1.157e+50`. The measurement was in the document, three sections above the wrong claim. |
| F-02 | critical | `netValueUsd = totalValueUsd − borrowedValueUsd` subtracts a liability from a total that never contained its matching asset, because v3 receipt tokens are unlisted and therefore invisible to the total. | **Adopted — the whole section was replaced.** Worked through: a wallet supplying $100k and borrowing $40k it still holds would report a net of **$0** against a true $60k; if the borrowed funds left, **−$40k**. v1 now ships **no net total at all**.        |
| F-03 | high     | `totalCollateralBase` is collateral, not supplies — a supply-with-collateral-off position is invisible — so calling the field "supplied" is a false claim.                                                | **Adopted.** Renamed `collateralValueUsd`, and the milestone's promise narrowed from "your Aave positions" to borrower risk.                                                                                                                                   |
| F-04 | high     | Ethereum runs Core, Prime and EtherFi markets. Keying an account by chain + protocol reads one and silently misses the others.                                                                            | **Adopted.** `marketId`/`marketName`, a bounded configured market list. Rejected the weekly-refresh idea for the address registry: proxy addresses are stable, and a CI sanity check is the proportionate version.                                             |
| F-05 | high     | Shipping `positions: []` asserts "checked and found none" when nothing looked — the exact substitution this codebase refuses.                                                                             | **Adopted.** The field is absent in v1 rather than empty, plus a per-market `status` so a failed read and a genuine zero cannot collapse.                                                                                                                      |
| F-06 | high     | `sumPortfolioTotals` drops null subtotals before summing, so a failed Aave read would shrink a complete-looking debt figure across both aggregation axes.                                                 | **Adopted.** Debt aggregates only with checked/failed/total counts and a "so far" label; health factors are not additive and stay per market.                                                                                                                  |
| F-07 | medium   | The double-count measurement covered only the keyless path. Under Alchemy, an indexer enumerates unlisted aTokens, so collateral could appear twice.                                                      | **Adopted as a constraint.** v1 survives because Aave's figures are explicitly non-additive and never summed into the wallet total; reconciliation is M5-2's problem, when they are combined. Both provider modes get a test.                                  |
| F-08 | medium   | §5a measured one market at one moment; Aave's oracle permits a non-USD base, which would make the `…Usd` names and 8-decimal scaling false elsewhere.                                                     | **Adopted.** Each market is probed for base currency and unit before being enabled; a non-USD market is excluded rather than guessed at.                                                                                                                       |
| F-09 | medium   | "State the health factor, never interpret it" leaves a reader unable to tell whether 1.04 is a percentage or whether higher is better.                                                                    | **Adopted, and it sharpened a rule.** A _definition_ is not advice: "below 1 becomes eligible for liquidation; higher is further from that threshold" says what the number is. "You should repay" says what to do, and stays out.                              |

### What this round is evidence of

The plan opened by citing the process that "caught a plan claim that was factually wrong
about this codebase" in rounds 7 and 8 — and then contained two of its own, one of which
its **own measurement disproved three sections earlier**. The probe output and the wrong
claim sat in the same document, and writing one did not cause me to check the other.

So the lesson is not "measure more". It is that a measurement only helps if something
reconciles it against the claims elsewhere in the document. Round 8 said the most
dangerous sentence in a plan is the confident quantitative one; round 12 adds that the
second most dangerous is the one contradicted by your own evidence, because it reads as
supported.

F-02 is the one worth remembering, though. It was not a factual error — every input was
right. The mistake was arithmetic performed across two different scopes: subtracting a
liability from a total whose matching asset was, by this plan's own design, invisible. No
amount of measuring would have caught it. Only working an example through end to end did,
and that is now a step rather than an instinct.

---

## Round 13 — M5-2, after implementation

Codex reviewed the whole M5-2 diff: per-asset rows inside an Aave market, priced by the
market's own oracle, with the claim that the rows sum to the market totals exactly.

The claim itself survived. Codex worked through e-mode, isolation mode, frozen and
paused reserves, siloed borrowing, and a collateral-enabled reserve with a zero
liquidation threshold, and found none of them break the sum — valuation in Aave's
`GenericLogic` does not consult those flags. What it found instead were three things the
measurement had not covered and three that were simply wrong.

### Adopted

| #   | Severity | Finding                                                                                                                                                              | What changed                                                                                                                                                                                                                                                         |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | high     | Skipping the breakdown when both totals are zero hides every supply with collateral switched off — the one position invisible to the totals by definition.           | **Measured, then reversed.** The skipped call costs 134 ms across all three Ethereum markets. The breakdown is now read for every detail-capable market; `hasPosition` considers it; the fourth status value `not-requested` was deleted because nothing reaches it. |
| F-2 | low      | `Decimal.dividedBy` rounds to 20 significant digits, so a 21-digit base-unit amount reaches the wire short. The test that should have caught it used a power of ten. | Amounts now go through the exact `formatBaseUnits`. The vacuous test is replaced with `123456789012345678901`, which used to come back two units light.                                                                                                              |
| F-3 | low      | A configured oracle address that goes stale keeps answering with plausible prices, so the rows would look right and quietly stop adding up.                          | The oracle is **derived** from the market's `PoolAddressesProvider`, in the same batch as the balances — no extra round trip, and five hand-maintained addresses removed from config.                                                                                |
| F-4 | low      | The schema said a collateral flag being false was the user's choice. Aave reports the flag, not the reason.                                                          | Wording corrected. The UI's neutral "Not used as collateral" was already right.                                                                                                                                                                                      |
| F-5 | low      | A row the oracle cannot price shows no figure, so the component's unqualified "these sum exactly" is false for that market.                                          | The claim is qualified where it is made, in ADR-027 and in the component.                                                                                                                                                                                            |

Chasing F-3 turned up something the review had not asked about. Deriving the oracle
needed a `getPriceOracle()` selector, and the one written into the constant block —
`0x87e0a92c` — was **invented**. It sat among four correct selectors, which is exactly
why it looked fine. Hashing the signature gives `0xfca513a8`. There is now a test that
hashes every signature in that block and compares, because four right answers are no
evidence at all about the fifth.

The config comment claiming "CI asserts each pool still answers" was also false — no such
job exists. Corrected to say what is true: nothing re-checks these addresses, a market
that moves surfaces as a failed read, and every _number_ is read live regardless.

### Rejected, with the residual risk recorded

**Block pinning (Codex's other high).** The totals, the balances and the indices are
three reads at `latest`, so nothing guarantees they describe one block. The fix — take
`eth_blockNumber` and pin all three — was rejected. Interest accruing over the few
hundred milliseconds between reads is orders of magnitude below the cent these figures
are shown to; the probe measured the gap at **3 base units, $0.00000003**. The visible
failure needs a repayment to land mid-read, and pinning would trade that for a worse
one: this runs on public endpoints with fallover, and a fallback node one block behind
cannot answer at a pinned height, so the breakdown would start failing on exactly the
flaky endpoints the fallover exists for. **Accepted residual: a transaction landing
between two reads shows a mismatch until the next refresh.**

**GHO (Codex's medium).** GHO's variable-debt token historically overrode `balanceOf`
with a stkAAVE discount, which would make reconstructing debt from `scaled × index`
overstate it. Settled by measurement rather than by argument: the deployed token has no
discount machinery at all — `DISCOUNT_TOKEN()` and `getDiscountPercent()` both revert —
and its own `totalSupply` equals `ceil(scaledTotalSupply × index)` **exactly**, across
101,746,313.9 GHO. No change needed.

### What this round is evidence of

The two findings that mattered were both **decided by measuring the thing rather than
reasoning about it**, and they went in opposite directions. The skip looked obviously
worth keeping until the 134 ms was on screen, at which point it was obviously not. GHO
looked like a real hazard until the totals reconciled to the unit, at which point it was
not. Neither answer was available from first principles, and I had already argued myself
into the wrong position on the first one.

The invented selector is the sharper lesson, and it is the same shape as round 13's
predecessor: a claim that _looked_ verified because it kept company with verified ones.
Four correct constants next to a fifth do not make the fifth correct — and the fix is
never to be more careful, it is to make the check executable.

---

## Round 14 — the M4 plan, before any code

Codex reviewed the plan for the history milestone. It returned four blockers and a long
tail of operational findings, and the useful response to it was **not** to adopt them all.
The owner's warning while it was running — _don't overcomplicate the plan because Codex
may be too smart_ — is the reason this round is worth recording.

### Adopted, because they were bugs

| #   | Finding                                                                                                                                          | What changed                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| F-1 | The database file would sit in the directory `deploy.sh` `rsync --delete`s. It would be destroyed by the next deploy.                            | Its own directory, its own systemd write permission, and "survives a deploy" became an exit criterion verified by deploying.              |
| F-2 | SQLite's numeric affinity converts decimal text to IEEE-754. A `NUMERIC` column would silently undo five milestones of ADR-003.                  | Decimal values stored as `TEXT`, summed through the existing `Decimal` path.                                                              |
| F-3 | `PRIMARY KEY (address, chain_id, captured_at)` keys on an instant, so a retry or a redeploy mid-run writes a duplicate rather than the same row. | Keyed on a UTC `snapshot_day`. The job became safe to re-run, which is the difference between a cron that may fail and one that must not. |
| F-4 | Postgres on a 3.8 GB box with no swap needs a load test, a pool, and a memory budget before it can be called safe.                               | SQLite. One writer, one host, ~200-byte rows. ADR-002 named Postgres before the box was known.                                            |
| F-5 | "98 % is the asset list" was 99.05 %, and the prose quoted 210 KB against its own table's 195 KB.                                                | Corrected, with the error left visible in the plan.                                                                                       |
| F-6 | The browser-local watchlist is ADR-023, not ADR-009.                                                                                             | Corrected.                                                                                                                                |
| F-7 | The daily cron is a full provider fan-out per chain, not a cheap write. For a hundred wallets it exceeds ADR-019's CoinGecko quota by itself.    | Recorded as the first open uncertainty, with the fix named: the job skips the enrichments the snapshot does not store.                    |

### Rejected, and the reason is the same one each time

Codex asked for an authentication model, a cardinality cap, per-source quotas, an untrack
path, deletion authorisation, GDPR retention and backup-restore resurrection semantics — all
downstream of the plan's own proposal of a user-facing "track this wallet" button.

**The button was the mistake, not the missing controls.** Replacing it with a fixed list of
the owner's addresses in configuration deletes every one of those questions, because a
stranger cannot add a row. The site is private and tailnet-only with one user. Codex said
as much in passing and then costed the general case anyway.

Also rejected: metric/schema versioning, a run-completeness header table (all-or-nothing
runs make it unnecessary), p50/p95/p99 payload benchmarks with committed provenance, and
connection-pool design (moot without a daemon).

### What this round is evidence of

A good adversarial review answers the question it was asked, and the question was framed
around a design that had one avoidable complication in it. Four of Codex's five "blockers"
were consequences of that single choice. Removing the choice removed them — the revised
plan is **shorter** than the one that was reviewed.

The lesson is not that the review was wrong. It found two things that would have destroyed
data and one that would have silently broken the decimal discipline. It is that a reviewer
optimising for completeness will cost a small project its simplicity unless someone holds
the line on scope, and on this project that someone is the owner.
