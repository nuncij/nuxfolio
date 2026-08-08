# Architectural Decisions

Short records of choices that are expensive to reverse or that a reader would
otherwise question. Newest last.

---

## ADR-001 — Next.js 15 App Router as the single deployable

**Context.** The brief asks for "a modern React full-stack framework" with
server-side routes, and for provider API keys never to reach the browser.

**Decision.** Next.js 15 with the App Router. Pages are server components; the
only network call the browser makes is to our own `/api/portfolio`.

**Consequences.** One process to operate. Provider credentials live in server
modules that import `config/env.ts`, which is server-only. The alternative
(separate Vite SPA + standalone API) doubles the deployment surface for no gain
at this size.

---

## ADR-002 — No database in milestone 1

**Context.** The brief allows "a relational database only where persistence is
genuinely needed".

**Decision.** No database. A portfolio read is a pure function of
(address, chain, current chain state, current prices).

**Consequences.** Nothing to migrate, back up, or leak. Watchlists and
snapshots (Phase 2) are the first features that genuinely need persistence;
that is when Postgres + Drizzle gets introduced, not before.

_The watchlist half of that sentence is superseded by ADR-023._ Saved wallets ship
as browser-local data and need no database; historical snapshots (M4) are the real
first case. The decision above — no database — stands.

---

## ADR-003 — Monetary and quantity fields are decimal strings, not `number`

**Context.** The kickoff sketches `totalValueUsd: number | null`,
`priceUsd: number | null`, `valueUsd: number | null`, and in the same section
requires: "Do not use JavaScript floating-point arithmetic for token quantities
or financial calculations where precision matters."

**Decision.** Keep the sketch's field names and nullability, but type every
monetary and quantity field as a decimal **string**. `bigint` carries base
units; `Decimal` (decimal.js) does all arithmetic; strings cross the API
boundary; `Intl.NumberFormat` renders.

**Rationale.** The two requirements conflict and precision is the stronger one.
An 18-decimal balance exceeds `Number.MAX_SAFE_INTEGER` by orders of magnitude,
so `number` loses digits before any arithmetic happens. Serialising `Decimal`
to `number` in the JSON response would reintroduce exactly the error the brief
forbids.

**Consequences.** A documented deviation from the sketch. Components must
format rather than interpolate. Comparisons in sorting use `Decimal.cmp`, not
`<`.

---

## ADR-004 — Two real balance providers, RPC-first by default

**Context.** A plain RPC node cannot enumerate which ERC-20s an address holds;
that requires an indexer. Indexers require API keys. The brief also forbids
tight coupling to one third-party provider and requires the app to run from
documented commands.

**Decision.** Ship two real adapters behind `PortfolioProvider`, selected by
**capability rather than by a mode switch**:

- `alchemy` — used automatically whenever `ALCHEMY_API_KEY` is set.
  `alchemy_getTokenBalances` gives complete discovery, with every dimension of
  fan-out bounded (pages, assets, metadata concurrency, deadline).
- `rpc-token-list` — the fallback when no key is configured. Public RPC,
  `eth_getBalance` plus a `Multicall3` `balanceOf` sweep across a bundled
  395-token Ethereum list. Zero keys.

An indexer is strictly better than a token-list sweep, so if a key exists it
wins; there is no environment variable to get wrong.

Every `BalanceSnapshot` carries a `coverage` field (`complete` | `token-list`)
that the API returns and the UI displays.

**Rationale.** `git clone && pnpm install && pnpm dev` must show real on-chain
data, or the acceptance criteria cannot be met by a reviewer without an
account. Two adapters that differ in _capability_, not just vendor, is what
actually proves the abstraction holds — a second adapter with an identical
shape proves nothing.

**Consequences.** The keyless mode under-reports: a wallet holding a token
outside the list shows a smaller portfolio. This is stated in the response
warnings and rendered in the UI. The honest-partial-data path is exercised on
every keyless request, which is a feature — the brief demands "explain
uncertainty instead of hiding it".

An independent review argued for making the indexer the _only_ provider and
deferring the token-list path. Rejected: acceptance criterion 3 requires the
application to display real asset data using the documented commands, and a
reviewer without an Alchemy account would see nothing. A single interface with a
single implementation also proves nothing about the anti-coupling requirement.
See `REVIEW_LOG.md`, F-01.

---

## ADR-005 — DefiLlama Coins API for prices, not CoinGecko

**Context.** Measured on 2026-07-30 against the keyless public tiers:

- CoinGecko `/simple/token_price/ethereum` rejects more than **one** contract
  address per request without a Demo key (`error_code: 10012`). Pricing 40
  tokens would mean 40 requests against a ~5-15 req/min budget.
- DefiLlama `coins.llama.fi/prices/current/...` accepts a batched,
  comma-separated list of `chain:address` refs, needs no key, and returns
  `price`, `timestamp`, `decimals` and `confidence` per coin.

**Decision.** `defillama` is the default `PriceProvider`.

The `confidence` score and the per-coin `timestamp` do **not** gate inclusion.
A quote below `PRICE_CONFIDENCE_MIN` (default `0.7`), older than
`PRICE_MAX_AGE_SECONDS` (default `3600`), or carrying no timestamp at all is
**kept and flagged** — `priceQuality` becomes `low-confidence`, `stale` or
`unknown-age`, the row shows a marker, and the response carries a warning.

An earlier draft of this ADR excluded low-confidence quotes instead. That was
wrong: dropping a quote removes its asset's value from the subtotal, so the
headline figure silently understates the portfolio and no warning explains the
gap. Flagging keeps the arithmetic complete and moves the judgement to the
person who can make it.

**Rationale.** Batching is the difference between one request and forty. The
per-coin `timestamp` and `confidence` are precisely the inputs needed to label
stale or unreliable data, which CoinGecko's keyless response does not provide —
and labelling is only possible because those fields exist.

**Consequences.** A single price source with no cross-check. Replacement is one
file plus one registry line; a CoinGecko adapter remains straightforward to add
once a key is available.

_Superseded in part by ADR-019._ A CoinGecko key arrived and the cross-check
exists — but as a verifier layered on top, not a replacement, precisely to keep
the `timestamp` and `confidence` fields this decision was made for. DefiLlama
remains the primary source.

---

## ADR-006 — Bundled, generated token list instead of a runtime fetch

**Context.** The default balance provider needs a list of candidate ERC-20
contracts.

**Decision.** `scripts/generate-token-list.mjs` fetches
`https://tokens.uniswap.org`, keeps `chainId === 1`, strips everything except
`address`/`name`/`symbol`/`decimals`/`logoURI`, checksums addresses, and writes
`src/config/tokenlists/ethereum.json`. The output is committed.

**Rationale.** Fetching a token list on the request path adds a failure mode
and latency to every portfolio load for data that changes weekly at most. The
committed file makes the request path deterministic and the diff reviewable.
Addresses, symbols and decimals are factual identifiers; the file records its
provenance and the exact list version.

**Consequences.** The list ages until the script is re-run. `coverage:
"token-list"` already tells users the set is finite, so an aging list degrades
the same way a short list does — visibly.

At five chains and 12,346 tokens the committed lists total about 1.4 MB. That is
the price of a request path with no network dependency and an install that works
offline. Two things keep it as low as possible: `logoURI` is stripped at
generation time (nothing renders it — ADR-009), and each token is written on its
own line so a regeneration produces a diff a human can read.

### Addendum, 2026-08-04 — the refresh is automated, the merge is not (M2-5(b))

"The list ages until the script is re-run" was true for four milestones, and
M2-5(a) made the ageing visible rather than fixing it: the app warns once a list
passes 60 days. That left the repair depending on a human reading a warning.

`.github/workflows/token-lists.yml` now regenerates all five lists at 03:00 UTC every
Monday. What happens next depends on what changed.

**The drift verdict routes the run; that is the whole design.** An automated
regeneration can produce a list that is _worse_ than the one it replaces. If the
upstream response is truncated on the morning the cron fires, the new file carries a
fresh `generatedAt` with fewer tokens — and the 60-day warning goes quiet at
precisely the moment coverage shrank. That is the ADR-012 failure mode with a
timestamp laundering it. `scripts/tokenListDrift.mjs` compares the two versions and
classifies the result:

- `unchanged` or `changed` — ordinary churn, committed straight to `main`. Nobody is
  asked, because there is nothing to decide.
- `attention` — a moved chain id, a mass removal, a net shrink, a mass rename or a
  decimals change. Pushed to a branch and opened as a pull request, because a
  threshold can say "this is unusual" but cannot say whether 400 absent tokens are
  real delistings.

**This replaced a monthly job that asked permission every time**, on the same day it
shipped. The owner's question — "is once a month really enough?" — exposed that the
schedule had been justified by an unchecked claim, written in the workflow itself:
that a weekly run "would mostly open pull requests that say nothing changed". The
measured rate is 24 added and 5 removed in five days, roughly 34 a week, so weekly
runs have real content every time and the stated reason was simply false arithmetic.

Routing on the verdict is better on both axes at once: lists a week old instead of a
month, and a message only when it carries a decision. The cost is real and worth
naming — **the guard is now load-bearing.** A wrong `changed` verdict lands without
review, where before a human saw every diff. That is why its thresholds are measured
rather than intuited, why the worst case each one still permits is computed and
written into the module, and why `pnpm verify` runs inside the job on exactly the tree
being pushed. Three things still bound the damage: the zod schema in the build, the
app's own coverage warnings, and `main` never being force-pushed — a concurrent push
turns the run into a pull request instead of anything clever.

**Two removal tests, because one was measurably too coarse.** The first version
tested gross removals against "25 or more, and at least 2 % of the list". Round 9
computed what that still permitted: **268 tokens across the five lists in a single
run, 2.2 % of all coverage** — for a guard whose stated property was that coverage
cannot shrink silently. The fix is a second test on the _net_ count, because
additions normally mask removals: over the five measured days every chain grew, so a
chain that ends up smaller than it started is already the anomaly. A net drop past 5
is a finding, which puts the per-run bound at **25 tokens, 0.20 %**. The gross test
stays — it catches a truncation whose losses are hidden by an equal number of new
listings, which the net test cannot see. Both bounds are recorded in the module, so
the next person to move a threshold can see its price.

**Findings are ranked, because only one fits in the title.** The pull request title
is what arrives in a notification, so it carries the worst finding rather than the
first: a moved chain id (wrong balances) outranks a mass removal (missing
balances), which outranks a decimals change (one token's metadata, as likely an
upstream fix as an upstream break). Rehearsing the flagged path against real data
caught this reporting an 80 % coverage loss as "1 token changed decimals".

**`pnpm verify` runs inside the refresh job, not on the pull request.** CI cannot be
relied on to run on a branch pushed by `GITHUB_TOKEN`. This ADR first asserted the
long-standing rule — that such events trigger no workflow run at all — and round 9
challenged it. The first real run settled it by observation, and **the challenge was
right**: GitHub _does_ create a `pull_request` run for a bot-opened pull request and
parks it in `action_required`, awaiting manual approval. `gh pr checks` reports "no
checks reported" while that run sits there indefinitely. That is worse than no run,
because a pending check looks like one that might still pass — so the in-job gate is
more necessary than the original argument claimed, not less. The alternatives were a
personal access token
token held as a repository secret, or duplicating the gate. A long-lived
credential with write access is a worse thing to own than a duplicated step — and
running the gate before the pull request exists is the better property anyway,
because a refresh that breaks the build never becomes something to review. The
pull request body says the gate ran and links the run, since an absence of checks
would otherwise read as "untested".

**What this does not fix.** GitHub disables scheduled workflows in a repository
with no activity for 60 days, and that failure is silent. It is not silent in the
product: the M2-5(a) warning is what surfaces it. So the warning is not made
obsolete by the automation — it becomes the monitor for it, and that is the reason
not to relax it now.

### Addendum, 2026-08-04 (later) — the automation kept the repo current, not the app

The addendum above claims M2-5(b) closed the token-list maintenance debt. That was half
true, and the missing half is the half that matters.

The lists are **compiled into the build** — `config/chains.ts` imports the JSON — the
build must not run on the target (3.7 GB, no swap, other services on it, ADR-018), and
the target is reachable only over Tailscale, which GitHub's runners are not on. So a
refresh landing on `main` changes nothing a browser sees. Every Monday the repository
gets fresher and the running app does not.

Left there, the outcome would be worse than before the automation: the repository would
look current while the live site quietly served older lists, and the only thing that
would eventually say so is the app's own 60-day warning — the "reminder to a human"
this work existed to replace.

Three options were weighed. **Deploying from CI** needs a Tailscale auth key stored as
a GitHub secret: a credential that reaches a private network, held by a third party, to
save one command. **A cron on the target** is ruled out by the memory limits above.
What ships is the third: **make the shortfall visible and specific.**

- `scripts/deploy.sh` force-moves a `deployed` tag and pushes it — a tag rather than a
  committed file, so recording a deploy leaves no diff.
- The refresh compares the `generatedAt` of the lists that tag points at against
  `main`'s. Not commits behind: the same quantity the app's own age warning measures,
  because "the running site is using lists from six weeks ago" is a decision and "four
  commits behind" is noise.
- Past **30 days** — half the app's own threshold, so there is a month of slack before
  any visitor is told anything — it opens **one** long-lived issue and updates rather
  than duplicates it. Inside 30 days it stays silent, because a refresh lands most
  Mondays and a weekly "something to ship" notice would be ignored within a month.
  That is precisely how the monthly always-ask design failed.
- A successful deploy closes the issue itself, so it disappears when the work is done
  rather than up to seven days later.

`unknown` is a first-class answer: before any deploy has recorded itself there is
nothing to compare, and reporting "probably fine" would be the same species of
dishonesty as a fresh timestamp on a shrunken list.

**What this still does not do: it does not deploy.** The gap is measured and reported,
not removed. Closing it properly is the Tailscale-key decision, which is the owner's to
make.

---

## ADR-007 — In-process cache and rate limiter

**Context.** The brief requires short-lived caching of portfolio results and
"basic rate limiting or abuse protection to public endpoints", while keeping
dependencies minimal.

**Decision.** A `Map`-based TTL cache (60 s, keyed by `chainId:address`) and a
fixed-window per-IP counter, both in module scope. No Redis.

**Rationale.** Adding a network dependency to satisfy "basic" protection on a
single-instance MVP is the wrong trade. The interfaces are narrow enough that
swapping in a shared store is a one-file change.

**Consequences.** Per-instance semantics: N instances mean N caches and an
effective rate limit of N × the configured value. Recorded as a known
limitation and a Phase 2 prerequisite for horizontal scaling.

---

## ADR-008 — Client IP resolution is explicitly configured, not guessed

**Context.** Rate limiting needs a client identity, and `x-forwarded-for` is
attacker-controlled unless a trusted proxy sets it.

**Decision.** Trust forwarding headers only when `TRUST_PROXY_HEADERS=true`.
Otherwise fall back to the platform-provided address, and to a single shared
bucket when no address is available — degrading to a global limit rather than
to no limit.

**Rationale.** Reading `x-forwarded-for` unconditionally makes the limiter
trivially bypassable by sending a random header value per request, which is
worse than no limiter because it looks like protection.

**Consequences.** Deployments behind a proxy must set the flag; the
`.env.example` says so.

---

## ADR-009 — No third-party images in the browser

**Context.** The brief's domain model includes `logoUrl`, and token lists supply
logo URLs. It also requires the product to be privacy-conscious.

**Decision.** `logoUrl` is populated in the API and **not rendered**. The asset
table draws a deterministic initials glyph instead. `next.config.ts` allow-lists
no remote image host.

**Rationale.** Rendering logos means the user's browser requests an image per
holding from a third-party CDN, which discloses the wallet's composition to that
host on every page view. Server-side optimisation would move the disclosure but
add a fetch of a URL that ultimately comes from an external list. Neither is
worth it for decoration: an initial is enough to scan a table by. The field stays
in the payload because it is part of the specified model and a future client may
choose differently.

**Consequences.** The page makes zero third-party requests — no logos, no
webfonts, no analytics. Slightly plainer rows.

---

## ADR-010 — State is written from callbacks and events, never inside an effect

**Context.** The portfolio view fetches on mount. Writing state synchronously in
an effect body triggers cascading renders, and `react-hooks/set-state-in-effect`
flags it.

**Decision.** Requesting and validating the portfolio lives in
`src/lib/portfolioClient.ts`, outside React. The component's effect calls it and
updates state in the returned promise's callback; the manual refresh button
updates state from a user event. `loading` starts `true`, and
`src/app/portfolio/[address]/page.tsx` keys the component by address and chain so
navigation remounts it with correct initial state.

**Rationale.** Suppressing the lint rule was the alternative. Extracting the
request instead fixed a real bug the rule had pointed at — without the remount
key, navigating between wallets showed the previous wallet's assets while the new
request was in flight — and produced a module that is unit-tested without
rendering anything.

**Consequences.** One more file, nine more tests, no lint suppressions.

---

## ADR-011 — Toolchain versions are pinned to what actually works together

**Context.** Installing the newest of everything produced two incompatibilities:

- `typescript@7.0.2` sits outside `typescript-eslint@8`'s peer range
  (`>=4.8.4 <6.1.0`), and `eslint-config-next@16` depends on that major.
- `eslint@10` breaks `eslint-plugin-react@7.37.5`, which still calls
  `context.getFilename()` and declares a peer ceiling of `^9.7`.
  `eslint-config-next` nonetheless advertises `eslint: >=9.0.0`.

**Decision.** Pin exact versions: TypeScript 6.0.3 and ESLint 9.39.5, with
Next.js 16.2.12, React 19.2.8, Vitest 4.1.10, Tailwind 4.3.3, zod 4.4.3,
viem 2.55.10. No carets anywhere.

**Rationale.** A working lint and type-check pipeline is worth more than a higher
version number, and an over-permissive upstream peer range is not a reason to
ship a broken one. Exact pins make `pnpm install` reproducible.

**Consequences.** Upgrades become deliberate. TypeScript 7 and ESLint 10 unblock
once `eslint-config-next` updates its transitive plugins.

---

## ADR-012 — Token lists come from CoinGecko, not from a DEX routing list

**Context.** Milestone 1 shipped with the Uniswap Labs Default list, 395 tokens
on Ethereum. Checked against a real wallet, Nuxfolio reported $35,175 where
DeBank reported $106,197 for the same address on the same chain.

The cause was not missing DeFi-protocol support, which is what the gap looked
like at first: DeBank _groups_ holdings under LIDO, Maple and Aave, but
mechanically those were plain ERC-20 receipt tokens sitting in the wallet.
`balanceOf` finds them fine. They were invisible because **wstETH, stETH, rETH,
sfrxETH, crvUSD and syrupUSDC are not on the Uniswap list at all.**

That is not a defect in the Uniswap list. It is curated for what is worth
routing a swap through, which is a different question from what is worth showing
in a portfolio. It was the wrong list for this job.

**Decision.** Generate the bundled lists from CoinGecko's per-platform token
lists instead. Ethereum goes from 395 to 5,078 tokens; five chains total 12,346.

**Measured result** on the wallet above, keyless:

|              | Before  | After    | DeBank   |
| ------------ | ------- | -------- | -------- |
| Ethereum     | $35,175 | $106,226 | $106,197 |
| All networks | —       | $106,900 | $106,888 |

The three previously-missing positions were wstETH ($36,561), syrupUSDC
($34,393) and stkAAVE ($24).

**Why it did not get slower.** A 5,078-token sweep is 11 `aggregate3` batches
instead of 4. Measured against a public endpoint, a 500-call batch takes the same
~130 ms as a 100-call batch — the cost is the round trip, not the calls inside
it. So `CALLS_PER_MULTICALL` went from 100 to 500 and batches now run four at a
time, taking a full sweep of 5,078 tokens to about one second: _faster_ than the
original 395-token sequential scan.

**Consequences.** Larger committed lists (see ADR-006). A broader list surfaces
more junk, which the price layer already handles — an airdropped token with no
price is shown unpriced and excluded from the total. Discovery is still bounded
by the list, so `coverage: "token-list"` and its warning remain exactly as
before; the set is simply much larger.

---

## ADR-013 — Five chains, with an all-networks view as the default

**Context.** Ethereum-only left roughly $673 of the wallet above unaccounted for,
spread across four L2s and BNB Chain. Phase 2 of the brief calls for additional
EVM chains.

**Decision.** Register Ethereum, Base, Arbitrum One, OP Mainnet and BNB Smart
Chain. `/portfolio/0x…` defaults to **all networks**; `?chainId=<id>` narrows to
one.

Three things made this configuration rather than architecture:

1. Multicall3 is deployed at the same address on all five chains, with
   byte-identical code — verified, not assumed. One balance adapter serves all.
2. `PriceRef` was already vendor-neutral (ADR-005), so a chain needs one
   namespace entry inside the price adapter and nothing outside it.
3. `RawBalance` already carried `chainId`, so assets were chain-aware before any
   chain but one existed.

**Aggregation shape.** `AggregatePortfolio` wraps per-chain `Portfolio` values
rather than flattening them. Per-chain subtotals are what a user actually wants
to see, and — more importantly — a chain that fails stays reportable on its own.
A network that could not be read appears in `failedChains` and is rendered as
"Unavailable", never silently omitted from the total. The request fails only when
no chain at all could be read.

Cross-chain shares are recomputed against the cross-chain total. Each asset
arrives carrying a share of its own chain's subtotal; left alone, every network
would sum to 100 % and the column would be meaningless.

**Consequences.** An all-networks request fans out to five chains, so
`CHAIN_SCAN_CONCURRENCY` (default 3) bounds how many run at once, on top of the
per-chain batch bound. Measured end to end at about two seconds cold and served
from cache thereafter. Adding a sixth chain is one registry entry plus
`pnpm tokens:generate`.

---

## ADR-014 — Likely spam is excluded from the total; doubtful prices are not

**Context.** Broad token lists and indexer discovery both surface assets the
wallet never asked for. Anyone can send anything to any address, so a wallet's
_contents_ are not the same thing as its _holdings_. When one of those airdrops
carries a price — a token named "USDC" with a real quote — it inflates the
headline figure. That is the one remaining way Nuxfolio could **overstate** a
portfolio, and overstating is the specific failure this product exists to avoid.

ADR-005 settled the opposite case: a quote that is old, undated or
low-confidence is **kept and flagged**, because dropping it would make the
subtotal quietly understate a real holding.

**Decision.** Treat the two as different claims.

- _Price uncertainty_ ("we are unsure what this is worth") → flag and keep,
  per ADR-005. Unchanged.
- _Identity suspicion_ ("this is probably not yours") → exclude from
  `totalValueUsd` and from every share, count it, and show it in a collapsed
  section of its own.

An asset is suspect when one of two deterministic checks fires (`domain/suspect.ts`):

1. **Symbol spoofing** — its contract is not on the chain's bundled token list,
   but its symbol collides case-insensitively with a listed token's symbol, or
   with the chain's native symbol. Only indexer-discovered assets can trip this;
   the keyless path sees nothing but listed tokens.
2. **Bait naming** — its name or symbol contains a URL, a domain-like suffix, or
   one of `claim`, `airdrop`, `voucher`, `reward`.

`PortfolioAsset` gains `suspect` and `suspectReason`; `Portfolio` and
`AggregatePortfolio` gain `suspectAssetCount` and `suspectValueUsd`, and a
warning (`assets.suspect`) names the count and the reasons. Nothing is hidden
without an accounting of what was hidden — the excluded rows and their total are
one click away, and the assets stay in `assetCount` and in the response.

**The token list is a whitelist, and that is load-bearing.** An asset whose
contract is on its chain's list is never suspect, whatever it is called. The
bundled lists carry genuine tokens named "ether.fi Staked ETH", "Crypto.com
Staked ETH", "Venus Reward" and "Voucher DOT" — around seventy across the five
chains trip the bait patterns. Flagging those would drop real holdings out of
the total, which is the same category of quiet error, in the opposite direction.

**Rationale.** Both checks are cheap to defend to the person whose portfolio it
is: "this contract is not the USDC contract but calls itself USDC" and "this
token's name is a web address" are statements about the asset, not guesses about
its value. Deliberately **not** heuristics: price confidence, staleness, a
missing price, a small balance, or an unrecognised contract on its own. Each of
those would exclude assets on a suspicion about the data rather than about the
asset, and the first two are already answered by ADR-005.

**Consequences.** False positives are possible — an off-list token that shares a
symbol with a listed one is excluded from the total even if the holder acquired
it deliberately. That is why exclusion is visible rather than silent: the row,
its value and its reason are all shown, and the total it is missing from says how
much was withheld. The patterns are a reviewable constant, small on purpose.
Anything cleverer (transfer-history analysis, holder counts, allow-lists per
address) needs data Nuxfolio does not read.

Dust is deliberately **not** handled this way. A sub-dollar row is a
presentation problem, not a correctness one, so `SMALL_BALANCE_THRESHOLD_USD`
folds those rows into one expander client-side and changes no total.

### Addendum, 2026-08-04 — both checks compare what is rendered, not what is stored

"Collides case-insensitively" was the whole comparison for four milestones, and it
made both checks trivially evadable. A token whose symbol is `USD\u200bC` — a
zero-width space between the D and the C — **renders as "USDC"** in every browser,
compares unequal to `USDC`, and therefore passed as an ordinary asset: priced,
counted in the total, no badge. The bait patterns fell to the same trick, since
`cl\u200baim` does not match `/\bclaim/`.

This was not hypothetical, and it was not found by looking for it. Building the
token-list refresh (M2-5(b)) meant scanning the bundled lists for characters that
would misrender in a pull request body, and one of the 12,366 listed tokens turned out
to be named with two leading zero-width spaces. That token exploits nothing — its
symbol is clean — but it proved the characters arrive from upstream, which made the
question about `suspect.ts` unavoidable.

**The fix is to compare appearance, because appearance is what the deception is
about.** Everything now passes through `canonicalize` — NFKC folding, invisible
characters stripped, lowercased, then a small map of non-Latin letters that are
visually _identical_ to a Latin one — applied to **both sides** of every comparison.
Raw-string equality answers whether two things _are_ the same; the attack is that they
_appear_ the same.

**What measurement changed about the design.** The first plan was to flag any symbol
mixing Latin with Cyrillic or Greek, which needs no lookalike table at all. Scanning
the real lists killed it: four listed symbols mix scripts, including `S\u039eR`, a
genuine token that styles its ticker with the ether sigil. A mixed-script rule would
mark holdings like that suspect — the exact quiet error the whitelist paragraph above
exists to prevent. So the narrower, anchored approach won: mapping only
indistinguishable glyphs, which can flag an asset only when it resembles a symbol that
is actually on the list. Greek Xi is absent from the map for that reason, and a test
pins it.

Three numbers, all measured rather than reasoned about:

- Of 12,366 listed symbols, **8** canonicalise differently from plain lowercase, and
  **no two distinct symbols collapse together** — the mapping adds no ambiguity.
- Building the index costs **6.7 ms against 3.4 ms**, about 3 ms added to a cold scan
  of roughly two seconds.
- **Zero** listed symbols contain an invisible character today, so stripping them
  cannot break a legitimate match.

**How exploitable it actually was, measured rather than implied.** Not, in the
deployed configuration. Symbol spoofing can only fire on an asset whose contract is
_off_ the bundled list, and the keyless `rpc-token-list` provider discovers balances by
probing that list — so every asset it finds is whitelisted by address before either
heuristic runs. Confirmed against the benchmark wallet on the live instance:
`suspectAssetCount: 0`, `balanceSource: "rpc-token-list"`. The bypass needed indexer
discovery, which means an Alchemy key, which was measured and removed on 2026-08-03.
That does not make the defect theoretical — one line in the VPS env restores the key,
and a heuristic that is wrong is worth fixing while it is cheap — but the honest
statement is that nothing in production was being spoofed through it.

**What this does not cover, stated plainly.** The map is a curated subset of Unicode
confusables, not the whole set. A determined spoof using a glyph outside it still
compares unequal — the class of attack is narrowed, not closed. Full coverage means
importing a confusables table, and the argument against it is the same one that
rejected mixed-script: every entry can only ever mark an asset suspect, so a wrong
entry costs a real holding.

---

## ADR-015 — The all-networks view is assembled in the browser, per network

**Context.** `?chainId=all` reads five chains server-side and answers once, so
the page showed nothing until the slowest network finished — about two seconds
cold, and longer whenever one chain was having a bad day. All five subtotals were
already available individually through `?chainId=<id>`, each behind the same
per-chain cache.

**Decision.** The all-networks **page** fires one request per network,
concurrently, and assembles the aggregate client-side as the answers arrive.
`domain/progressiveAggregate.ts` is a pure reducer over the results collected so
far; `buildAggregatePortfolio` still does the arithmetic. The server's
`?chainId=all` endpoint is unchanged and remains the single-request path for API
callers.

Two rules keep the streamed view from ever being a different view:

1. **Registry order, not arrival order.** The aggregate is derived by walking the
   requested chain list, so the same set of results always produces the same
   aggregate — byte-identical to what the server would have built from them.
2. **Partial is labelled as partial.** Every figure is a sum over the networks
   that have answered, so the view carries "Loading… (k of n networks)" and the
   network card counts what it covers until all have settled. An unlabelled
   partial total is indistinguishable from a finished smaller one, which is the
   quiet error this product exists to avoid.

A network whose request fails becomes a `failedChains` entry rendered as
"Unavailable", exactly as in the server-side path. The wording is shared:
`domain/chainFailure.ts` holds the sentences, and the server maps a
`ProviderError` kind onto them while the browser maps the API error code of the
failed response. The view fails as a whole only when every network failed, which
mirrors the server rule.

**Rationale.** Server-sent events or a streamed RSC payload would also have
worked, and both keep the single-request cost. Both also add a transport to
maintain and a partial-failure story to invent, while the per-chain endpoint,
its cache and its validation already existed — this change is a client-side
reducer and one fan-out helper, testable without a browser.

**Consequences.** A page load spends one rate-limit token per network (five
today, against a default ceiling of 30 per minute) instead of one, so
`RATE_LIMIT_MAX_REQUESTS` has to stay comfortably above the chain count, and it
grows with each chain added. Upstream provider load is unchanged, since every
request reads the same per-chain cache. `CHAIN_SCAN_CONCURRENCY` no longer bounds
this path — the browser's own per-host connection limit does. The aggregate is
stamped with the oldest per-chain timestamp rather than "now", because a view
combining a fresh read with a cached one is only as current as its stalest part.
A manual refresh with a complete view already on screen waits for all networks
before replacing it, so the total is never seen collapsing and rebuilding.

---

## ADR-016 — Two themes, system-first, resolved before first paint

**Context.** The interface was dark-only. A financial reading surface gets used
in daylight and in bright offices, and an OS-level light preference was simply
ignored.

**Decision.** Light and dark palettes, with three modes: `system` (default),
`light`, `dark`. The choice is a `data-theme` attribute on `<html>`, absent when
following the system so the stylesheet's `prefers-color-scheme` block governs.

Three details are load-bearing:

1. **`@theme inline`.** Without `inline`, Tailwind resolves each token to its
   literal value at build time and utilities stop referencing the variable, so
   overriding it per theme would have no effect. With it, `bg-surface` compiles
   to `var(--nx-surface)` and follows the cascade. Verified by grepping the built
   CSS, not assumed.
2. **A blocking inline script.** Styling depends on an attribute, so the
   attribute must exist before the browser paints. Setting it from an effect
   would flash light-then-dark on every navigation for dark-mode visitors. The
   script is tiny and wrapped in try/catch — `localStorage` throws outright when
   storage is blocked, and a theme preference is never worth a broken page load.
   `<html suppressHydrationWarning>` is therefore required, and is scoped to that
   one element so nothing inside the tree loses its hydration checks.
3. **`system` removes the attribute** rather than writing a resolved value.
   Storing `light` for a system-light visitor would freeze them in light mode
   when their OS later switched.

**Accent and caution hues differ per theme.** A colour legible on near-black is
not legible on near-white: the pale sky accent (`#7dd3fc`) becomes a deep blue
(`#0369a1`), and amber caution text darkens to `#8a5a00`. Every text token was
checked numerically against every surface it can sit on; all pairs meet WCAG AA
(4.5:1) in both themes.

That check found a **pre-existing defect**: `ink-subtle`, the caption colour used
in 17 places, scored 3.93:1 against a card in the dark theme — below AA since
milestone 1. It is now `#7b8390` (4.86:1). Adding light mode is what surfaced it,
which is an argument for expressing this kind of constraint as an executable
check rather than a design intention.

**Alpha-blended caution colours were replaced with solid tokens.** Panels used
`bg-caution-surface/40`, whose result depends on whatever sits behind it — the
exact assumption a theme switch invalidates. A dedicated `caution-line` token
also means panel borders no longer derive from the caution _text_ colour.

**Consequences.** Thirteen semantic tokens instead of eleven, declared twice.
Component classes are unchanged — they name intent, so they themed for free. The
toggle uses `useSyncExternalStore` with a server snapshot rather than reading
storage in an effect, which keeps `react-hooks/set-state-in-effect` satisfied
honestly and buys cross-tab sync as a side effect.

---

## ADR-017 — End-to-end tests run against a production build

**Context.** The E2E suite started its own `next dev` on port 3100. Next.js
permits only one dev server per project directory, so `pnpm test:e2e` failed
outright whenever a developer already had `pnpm dev` running — which is most of
the time. The failure was in the harness, not the app, and it made the suite
unrunnable exactly when it was most useful.

**Decision.** The Playwright `webServer` runs `pnpm build && pnpm start`. No
singleton lock applies to `next start`.

**Rationale.** Beyond fixing the collision, it is the more faithful target: the
suite exists to prove wiring, and the wiring that ships is the built output.
Precompiled routes also remove the first-hit compile that forced a 45 s
per-test ceiling, now 30 s.

**Consequences.** A run pays a build (~10 s) instead of a dev boot. Both are
inside a suite that is deliberately outside `pnpm verify`.

**Addendum, 2026-08-03: the per-test ceiling was too tight.** It was set to 30 s on
the reasoning that precompiled routes mean no test pays a first-hit compile. True,
but incomplete: the first wave of parallel workers all race the same freshly booted
server, and those page loads measure 22–24 s locally while the second wave, hitting
a warm server, takes 1–2 s. The margin was thin enough to fail intermittently, which
it duly did. Raised to 60 s, sized for the cold wave rather than the warm case.

---

## ADR-018 — Deployed as a standalone bundle behind Tailscale, on a shared host

**Context.** The deployment target is a 2 vCPU / 3.7 GB Hetzner box with **no
swap**, reached only over Tailscale, and it **already runs the owner's other
projects**: three user-level systemd services, several `tailscale serve` routes
and one public Funnel. Roughly 1 GB of memory was already committed. `ufw`
default-denies inbound and admits only the Tailscale interface.

Three constraints followed from surveying it rather than assuming:

**1. Do not build on the target.** `next build` on 2 vCPU with no swap risks an
out-of-memory kill, and on a shared host that kill can take the neighbours with
it. `output: 'standalone'` produces a 42 MB self-contained bundle — `server.js`
plus only traced dependencies — so the build happens on a developer machine and
only the output travels. The target needs no package manager and no
`node_modules` install; it has Node and that is enough.

Note the trap: `next build` leaves `.next/static` **out** of the standalone
directory. A bundle that is merely copied serves HTML with no CSS. `deploy.sh`
assembles the two together so that cannot be got wrong by hand.

**2. Tailscale Serve instead of a reverse proxy.** Installing Caddy or nginx
would mean claiming port 443 — already bound by Tailscale on the tailnet
interface — and opening firewall holes in a box deliberately closed. One
`tailscale serve` route gives a real, auto-renewed certificate at
`https://<host>.ts.net:9443`, reachable from the owner's devices and nothing
else. No firewall rule changed, no new public surface.

The app binds `127.0.0.1` only, so even inside the tailnet it is reachable solely
through that route.

**3. Match the host's conventions; stay additive.** The existing services are
_user_ systemd units with lingering enabled, so Nuxfolio is one too — no sudo,
no system-level unit. `sudo` is used for exactly one command, `tailscale serve`,
which requires root. The alternative, `tailscale set --operator=$USER`, was
rejected: it permanently grants this account control over the host's entire
Tailscale configuration, and that configuration carries other projects' routes.
The serve config is backed up before every change for the same reason.

`MemoryHigh=512M` / `MemoryMax=768M` bound the service so a leak here gets
Nuxfolio killed rather than the machine thrashing — which it cannot do, having no
swap. Measured actual usage: **48 MB**.

**Consequences.** Deploys are `pnpm deploy` from a tailnet machine, which
verifies, builds, ships, restarts and health-checks. CI cannot deploy: GitHub's
runners are not on the tailnet, and putting them there means storing a Tailscale
auth key as a repo secret — deferred until the manual path proves annoying.

Because the site is tailnet-only, the unmetered ENS lookup on the page-render
path is **no longer a deployment blocker**. Only the owner's own devices can
reach it. It becomes a prerequisite again the moment Funnel or a public domain is
switched on, and is recorded that way in `DEV_PLAN.md`.

**Addendum, 2026-08-03: the premise about port 443 no longer holds.** This ADR
argued against a reverse proxy partly because "installing Caddy or nginx would mean
claiming port 443 — already bound by Tailscale on the tailnet interface". That was
true when written. The owner has since put **Caddy 2.11 on the tailnet address:443** for
their personal domain, taking that port from `tailscale serve`, and documented the
whole arrangement in a separate, private infrastructure repository.

So Nuxfolio now sits behind Caddy on a private subdomain of the owner's domain, and the
decision this ADR records is superseded on the _mechanism_ while its conclusions
survive intact:

- **Still tailnet-only, by three independent layers.** The DNS A record points at a
  CGNAT address reachable only inside the tailnet; Caddy is bound to that address
  rather than to `0.0.0.0`; and `ufw` still admits only the `tailscale0` interface.
  Any one of the three would be sufficient.
- **Still no public surface and no firewall change.** Verified: the host's public IP
  answers nothing on 443.
- **Still additive.** One DNS record and one Caddy block, following the recipe the
  owner had already written down, with the previous config backed up first.
- **Certificates still arrive without an open port**, now via Caddy's DNS-01
  challenge against Cloudflare rather than via Tailscale's own certificate service.

The `tailscale serve` route on `:9443` is left in place because `deploy.sh` re-adds
it on every deploy; it reaches the same process and is a useful fallback if Caddy
stops. Both paths are recorded in that infrastructure repository.

### Addendum, 2026-08-04 — the target pulls its own builds, and a correction

The owner asked why a cron on the target could not do this. The answer given was the
memory ceiling in this ADR — and **that answer was wrong**, which measuring settled in
two commands: `next build` peaks at **950 MB**, and the target has **2,579 MB
available** against 1,240 MB in use by its other services. It fits. "3.7 GB and no
swap" had been repeated as though it closed the question, and it does not; the real
risk is narrower — with zero swap there is no cushion, so an unusually heavy build
could have the kernel kill a _neighbour_ — and even that is fixable with a memory cap
on the build.

So the objection was replaced with a better design rather than defended. Three shapes
were weighed:

1. **Deploy from CI.** Needs a Tailscale auth key stored as a GitHub secret: a
   credential reaching into a private network, held by a third party, to save one
   command. Rejected.
2. **Build on the target.** Feasible, per the measurement. But it needs a checkout, a
   package manager and a toolchain on a box running other people's services, and it
   competes for 2 vCPUs while serving.
3. **Pull a build made elsewhere.** What ships.

**The shape.** `ci.yml` already ends its verify job in `pnpm build`, so on a push to
`main` it assembles the bundle and uploads it to a single rolling prerelease tagged
`build`, replacing the assets in place — this is the current deployable build, not a
version history, so exactly one copy is ever stored. A systemd user timer on the target
checks every 15 minutes, and the check costs one request for a 90-byte checksum, so the
ordinary case of nothing-published costs nothing worth measuring. The tar is built with
sorted names and a fixed mtime so an unchanged build yields an unchanged checksum.

The target needs **no toolchain at all**: `output: 'standalone'` is self-contained.
And it reaches _out_ over HTTPS, so nothing has to reach _in_ — `ufw` still admits only
the tailnet, and the three privacy layers are untouched.

**Assembly is shared.** `scripts/assemble-bundle.sh` is called by both `deploy.sh` and
CI. They had a copy each, which stays correct exactly until one is edited — and the
copy is what guarantees a hand-shipped build and a pulled build are the same thing.

**Nobody watches this, so it assumes it will fail.** The checksum is verified before
anything is unpacked, because a truncated download is the likeliest fault and would
otherwise become a half-extracted application. `server.js` and `.next/static` are both
asserted present — the second because a bundle missing static assets serves unstyled
HTML rather than failing, which is the worst kind of broken. The previous bundle is
kept, and if the new one does not answer on loopback within twenty seconds it is moved
aside and the previous one restored. A `flock` means a timer firing mid-swap waits
instead of interleaving.

**The credential, stated plainly.** A fine-grained token scoped to this one repository,
Contents read and write, in **`~/nuxfolio/updater-env`** (mode 600, never written by a
deploy). Read is to download the asset. Write is only so the updater can move the
`deployed` tag through the git refs API — there is no checkout on that box — and that
matters because it changes what the weekly refresh's 30-day check _means_: with this
timer running it is no longer a nudge to deploy, it is a **liveness check for the
timer**. If the updater dies, the tag stops moving and the refresh says so.

_This addendum first said `~/nuxfolio/env`, and review round 10 (F-01) showed why that
would have been a serious mistake:_ the app's unit loads `env`, so the internet-facing
process would have been able to read a repository-write token — and, since the unit
also had the whole of `~/nuxfolio` writable, to rewrite the updater script itself and
escape its sandbox on the next timer run. Caught before the token existed. The fix is
separation on both axes: the token sits in a file nothing but the updater reads, and
the app's unit can now write only `~/nuxfolio/app/.next/cache`, its runtime cache.
Round 10's F-13 pushed further — drop write scope entirely — and was rejected: the
moved tag is the liveness signal, no narrower API permission moves a git ref, and with
the app isolated from the token the remaining holder is the box itself, which already
holds an SSH identity worth more.

**What the checksum is and is not.** It protects against a truncated or corrupted
download, and against catching a publish mid-replacement. It does **not** authenticate
the publisher — it is uploaded by the same workflow as the bundle. The trust root is
`main` itself: whatever lands there gets built, published and installed. For a private
solo repository whose actions are all GitHub-authored (`checkout`, `setup-node`,
`upload`/`download-artifact`), that is accepted and stated rather than dressed up
(round 10, F-14). What was tightened instead: tests no longer run under a writable
token — publishing moved to a job that runs no project code and starts only after
_both_ test jobs pass, so a build whose end-to-end suite failed can no longer ship
(F-02, F-09).

Creating the token is a web flow, so it is the one step that cannot be automated. Set
its expiry deliberately — the default is 30 days, after which updates would stop with
nothing but a journal line to say why; the deploy script exercises the token on every
run precisely so a dead one is noticed (F-15). Until it exists the timer is installed
and failing, which `journalctl --user -u nuxfolio-update` shows.

**What is now automatic and what is not.** A push to `main` reaches the live site
within about fifteen minutes without anyone doing anything. `deploy.sh` still exists
and still installs the timer, so whoever can deploy by hand has by that act installed
the thing that makes deploying by hand unnecessary.

**But a hand-shipped build is now temporary**, and that is a real change in what
`deploy.sh` means. The timer is authoritative: within fifteen minutes it pulls whatever
CI published for `main` and swaps it in, over the top of anything shipped by hand.
Trying a branch on the target therefore means stopping the timer first
(`systemctl --user stop nuxfolio-update.timer`). The alternative — having a deploy
record the published checksum when it happens to match — would leave a hand-deployed
branch running indefinitely with nothing indicating it had diverged from `main`. Losing
the pin is the better failure of the two.

The ENS prerequisite named here was closed on 2026-08-05 (ADR-025); the remaining
go-public considerations are capacity and quota decisions, recorded in `DEV_PLAN.md`
Part 6. A domain name is still not publication: the checklist for going public in
that repository names Nuxfolio as a deliberate exception, with the reason, so the two
documents cannot drift into disagreeing about whether it is safe to expose.

---

## ADR-019 — A second price source verifies, and neither source wins

**Context.** Every price came from DefiLlama alone. ADR-005 named the gap in
those words: _"a single price source with no cross-check"_. The `priceQuality`
flags handle **declared** uncertainty — a provider saying a quote is old or
low-confidence — and are useless against a quote that is confidently wrong. A
CoinGecko Demo key made a second opinion possible.

**Decision.** CoinGecko is a `PriceVerifier` **layered over** the primary lookup,
not a `PriceProvider` selectable instead of it. Disagreement is reported;
disputed prices stay in the total; neither source is preferred.

**Rationale, in three parts.**

**1. Verifier, not alternative.** Swapping DefiLlama out for CoinGecko would lose
the per-quote confidence scores and timestamps the honesty flags depend on —
CoinGecko reports neither. Layering adds disagreement detection without giving
anything up. `PriceVerifier` deliberately returns the same shape as
`PriceProvider`, so the comparison is between like and like and a third source
needs no new type.

**2. Neither source wins.** A dispute flags the asset and leaves the primary
price in the total, with both figures available. Picking a winner would invent a
confidence we do not have: nothing here establishes which source is right. This
is ADR-014's flag-and-keep applied to disagreement instead of staleness — and it
cuts the other way from a suspect asset, which _leaves_ the total. The doubt
there is about whether the holding is the user's; here it is only about the
number.

**3. Not every asset.** The Demo quota is 10,000 calls/month, so the verifier is
asked only about assets material to the total: sorted by value, enough to cover
`PRICE_CROSSCHECK_COVERAGE` (0.95) of the priced subtotal, capped at
`PRICE_CROSSCHECK_MAX_ASSETS` (25) per chain. On the benchmark wallet that is 7
of 55 assets. Unchecked assets get `priceCheck: null` and are **never** rendered
as agreed.

Selection runs on the **built portfolio**, not on raw balances — after spam
detection and after the per-chain cap. `buildPortfolio` is therefore called twice:
once to decide what is worth checking, once with the results. It is pure and does
no I/O, so that is cheaper than duplicating the rules it applies, and it removes a
whole class of disagreement between what was checked and what is shown. Ranking
raw balances instead let a spoofed token with a fabricated price rank first and
spend the entire quota on an asset excluded from the total anyway — found in
review, round 5 F-02.

**4. Four states, not two.** `agreed`, `disputed`, `unverified` (asked, no
answer) and `null` (never asked) are four different claims, and keeping them apart
is most of what makes the feature honest:

- a verifier returns `attemptedRefKeys`, so a ref a deadline cut off stays `null`
  rather than becoming `unverified` — the second would overstate both the coverage
  and the source's involvement, and would credit CoinGecko for data it never sent;
- the summary counts `agreed` rather than inferring it from "checked minus
  disputed", because zero disputes among all-`unverified` checks is not agreement;
- the displayed counts are derived from the asset rows, so the sentence in the
  summary cannot contradict the table beneath it, and "N of M prices were checked"
  holds N ≤ M by construction rather than by assumption.

Because the table marks disagreements only, an unmarked row is ambiguous on its
own — which is why the summary states the scope at all, with a denominator that
excludes suspect assets, since those are outside the total and never worth a call.

All three points above came out of review round 5 (F-01, F-03, F-05). Each was a
sentence the UI could print that was not true, in a state no test had constructed.

**Measured, not assumed.** Probed live on 2026-07-31: keyless, the endpoint
accepts **one** contract address per call (`error_code 10012`); with the Demo key
175 worked; 200 returned **HTTP 414 with an HTML body** — nginx's ~8 KB URI
limit, not an API rule, so it arrives as an unparseable response rather than an
error code to branch on. Hence chunking at 100, half the observed ceiling:
sitting near a limit that belongs to someone else's web-server config is not a
plan.

**The spec was wrong about native assets.** It skipped them, because they need a
different endpoint (`/simple/price` by coin id) and that costs "a second slice of
quota for one asset per chain". A live run disproved it: on Base, Arbitrum and OP
Mainnet the native asset is effectively the entire holding, so skipping natives
left the single most material price on three of five chains permanently
`unverified`. Natives are now checked. This is the fourth time in this project
that turning a stated property into an executed measurement found a defect the
prose had not.

**Consequences.** The key travels as an `x-cg-demo-api-key` header, never in a
URL — a URL reaches error messages, proxy logs and referrers, and the adapter
also logs a fixed label so neither the key nor the wallet's contract addresses
can leak through a request line. Attribution is a **licence term**: "Powered by
CoinGecko API", linked, at no less than 10 pt whenever their data is used. It is
rendered from the payload, so it cannot be forgotten when the check runs or shown
falsely when it does not, and two E2E tests hold both halves of that.

Every failure degrades, and the degradation says which kind of failure it was: the
verifier shares the request deadline; _some_ requests failing becomes
`prices.crosscheck_partial`; _all_ of them failing is not a partial result but an
absent second source, so it raises and becomes a single
`prices.crosscheck_unavailable` with the portfolio otherwise unchanged; a rejected
key stops immediately and logs at `error`, because that is a configuration problem
rather than weather and every remaining request would fail identically; and no key
configured means no verifier and no warning — that is the default state, not a
fault.

---

## ADR-020 — A price change is computed locally, and withheld more often than shown

**Context.** Every tracker shows a 24-hour change; Nuxfolio did not. DefiLlama
offers three keyless ways to get one: `/percentage`, which returns the figure
directly in a single call; `/chart`, which returns a series; and
`/prices/historical/{ts}`, which returns prices at an instant with the same
`timestamp` and `confidence` fields the current-price path already uses.

**Decision.** Fetch two historical prices and compute the change here, in
`Decimal`. Suppress the figure whenever it cannot be honestly stated, which is
more often than it might appear.

**Rationale.** `/percentage` is the obvious choice and was rejected for **one**
reason, not the three the plan first gave. An earlier draft argued "bare float,
hidden prices, cannot suppress on a stale quote"; review pointed out that the
first is no different from the current-price path, which also parses JSON numbers,
and the third is achievable with `priceQuality` whatever supplies the change. What
survives is decisive on its own: `/percentage` returns **no timestamp and no
confidence**, so there is no way to know whether the number rests on a usable
observation. Verified afterwards that the local arithmetic agrees with DefiLlama's
own endpoint to the cent on ETH, wstETH and WBTC — so the extra work buys exactly
what was claimed and nothing more: the same figures, plus the metadata needed to
refuse the dishonest ones.

**Four states, not two.** `ok`, `not-requested`, `no-quote`, `unusable`. This is
ADR-019's lesson applied before the mistake rather than after it, and it requires
the provider to report `attemptedRefKeys` — otherwise a batch the deadline cut off
is indistinguishable from one the source had no answer for.

**When the figure is withheld:**

- the current quote is not `ok` — comparing a stale price to a historical one
  produces something precise-looking and meaningless;
- the current price is **disputed**. A price can be fresh and confident and still
  contradicted by the second source, and ADR-019 prefers neither. Deriving an exact
  percentage from the primary would quietly resolve the dispute in its favour.
  Review caught this; the draft checked only `priceQuality`;
- the returned observation is further from the requested instant than ±6 h (24 h
  figure) or ±24 h (7 d). DefiLlama answers with the nearest price it holds, and a
  point 30 hours old labelled "24 h" is simply false;
- the source would not date the observation at all.

**Consequences.** The column shows an em dash for any non-`ok` status, each
carrying its reason, so "we did not ask", "there was no price" and "this cannot be
compared" are distinguishable rather than looking like one shrug. It never shows
`0.00%` for a missing figure — zero means unchanged — and because `formatPercent`
rounds to two places, a real change below 0.01% renders `<0.01%` rather than
asserting the opposite. That last case was found in review, not in testing.

History is requested only for assets in the total whose current quote could
survive a comparison, selected from the built portfolio after spam detection and
truncation, and capped by `PRICE_HISTORY_MAX_ASSETS` (default 50). Without the cap
the 400-asset ceiling would allow 14 calls per chain — 70 per load; with it, 2 per
chain.

---

## ADR-021 — Euro is a display conversion, at a rate that says its own age

**Context.** The owner is EU-based and wanted figures in euro. Nuxfolio computes
in USD throughout.

**Decision.** EUR is a **render-time conversion** applied at the formatting
boundary and nowhere else. No stored value, no provider response and no arithmetic
is ever in euro. The rate comes from the ECB's daily reference file, is fetched
server-side inside the shared request deadline, and is carried on the response.

**Rationale.**

**The rate is not "today's rate".** The ECB fixes rates around 16:00 CET on TARGET
business days only, so a Monday request returns Friday's figure and a holiday can
make it four days old. `asOf` is therefore **the date inside the document**, never
the fetch time, and the disclosure names it. A euro figure is a conversion of an
estimate at a dated rate — two layers of approximation, and both are stated.

**It divides.** The ECB quotes the euro as the base: 1 EUR = 1.1485 USD. Dollars
become euros by dividing. Multiplying would overstate every figure on the page by
about a third — consistently enough to look plausible, which is why the direction
has a test of its own against a hand-computed figure.

**Fetched server-side.** A browser request to the ECB would disclose that the
visitor is looking at a portfolio, which is the same leak ADR-009 refuses for logo
CDNs. The first draft of the plan specified an adapter and a formatter with nothing
in between, and review named exactly this gap.

**Supplied by context, not by props.** Every component that renders money reads
one immutable `DisplayContext`. A prop would have to be threaded through the
summary, the table, the network breakdown and the panel, and the plan had already
missed one of them — a miss that does not fail to compile but renders unconverted
dollars beside euros, which is worse than either alone.

**Consequences.** No rate means no toggle **and** a `rates.unavailable` warning:
the control silently disappearing would leave a user doubting their memory. A rate
older than 14 days — well beyond any weekend or holiday — raises `rates.aged`. A
zero, negative or unparseable rate yields no rate rather than a division. The one
adapter that reads XML is why `fetchJson` gained a `decode` hook; the retry policy,
deadline arithmetic and error taxonomy are shared rather than reimplemented.

---

## ADR-022 — Insights state facts, classify by address, and go quiet when partial

**Context.** The product could say what a wallet holds but not what that adds up
to. On the benchmark wallet, three positions on one network are a near-exact
thirds split across ether, dollars and bitcoin — invisible when scanning 55 rows.
The kickoff promised "where are the risks" for a much later phase; the useful part
of it is computable today from data already in `Portfolio`.

**Decision.** A rules-based panel. No provider, no key, no AI. It states facts
with named denominators, classifies exposure by contract address, and withholds
cross-network claims until every network has answered.

**Rationale.**

**Facts, not advice.** "One asset is 40% of the priced total" ships. "You are
over-concentrated" does not — that is a recommendation, and this product does not
make them. Where the line is unclear, the number is stated and nothing follows it.

**Never classify by symbol.** A symbol is attacker-controlled; that is the whole
premise of ADR-014's spoof detection. Classifying by symbol would let an airdropped
fake re-enter as a _risk statement_ the very figure it was excluded from.
Classification is keyed by **`(chainId, lowercased address)`** — never address
alone, because the same bytes are unrelated contracts across EVM chains — from a
small committed registry with a note and a review date per entry. Anything absent
is `unclassified` **and shown as such, with its share**, so a thin registry
degrades to an honest "we cannot speak for this much of the total" instead of a
wrong bucket.

**"Designed to track", not "tracks".** An address proves which instrument
something is, not that it is currently holding its peg. A depegged stablecoin is
still that entry.

**A receipt is not the thing it tracks.** syrupUSDC follows the dollar but is a
Maple lending receipt; wstETH follows ether but is a Lido staking receipt. Both
carry protocol dependencies a plain balance does not, so the panel names the form
rather than calling both "the US dollar".

**One honest universe.** Every numerator and denominator is the priced,
non-suspect set. `assetCount` includes unpriced and spam rows; `pricedAssetCount`
includes priced spam. The draft would have printed "3 of 55 assets make up 99% of
the value", which a single unpriced valuable holding makes unsupportable. Review
caught it.

**Silence while partial.** The all-networks view renders each network as it
arrives (ADR-015). A panel computing cross-network facts from a partial aggregate
would announce "100% sits on Ethereum Mainnet" while four networks were still
loading — the same defect as round 4's empty state speaking for a network it had
not read. `networksComplete` is a required argument, not an optional one, so a
caller cannot leave a partial aggregate looking settled by forgetting it.

**Consequences.** `domain/insights.ts` returns structured facts and decimal
strings; phrasing lives in the component, because `lib/format.ts` already imports
from `domain/` and a domain module importing the formatter would invert the
layering. A portfolio with fewer than two priced holdings, or none, shows no panel
rather than a padded one. The registry is maintenance — 20 entries today, and every
addition is a decision with a date rather than a guess.

### Addendum, 2026-08-06 — withdrawn

The insights panel is removed, at the owner's request: "remove this is useless."

The reasoning above still holds on its own terms — the thirds split really was
invisible when scanning rows, and the design decisions (facts not advice,
classification by contract address, silence when the aggregate is partial) were
right for what it was trying to be. What it got wrong is upstream of all of that:
the panel answered a question the owner was not asking. A correct answer to the
wrong question is still the wrong feature, and it cost 613 lines across a domain
module, its tests and a component.

Deleted rather than hidden. A feature no view renders is dead code that still has to
compile, still has to be understood by the next reader, and still shows up in every
grep — a worse state than either keeping it or removing it. Git history holds it if
it is ever wanted back.

**What this ADR is now evidence of.** Every earlier reversal here was caught by a
measurement or a review. This one could only be caught by the person who uses the
thing. Reviews check whether something is built correctly; only the owner can say
whether it should exist. Worth remembering the next time a feature is justified by
how interesting it is to build.

---

## ADR-023 — Browser-local preferences are not server persistence

**Context.** ADR-002 chose to ship no database, and its consequences named the
feature that would change that: _"Watchlists and snapshots (Phase 2) are the first
features that genuinely need persistence; that is when Postgres + Drizzle gets
introduced, not before."_

M3-1 is a watchlist, and it needs no database. That sentence and the shipped feature
cannot both stand, and independent review of the M3-1 plan pointed out that the
plan's own claim — "ADR-002 holds" — was false rather than merely loose.

**Decision.** ADR-002's watchlist clause is **superseded**. The line is drawn
between two things that clause conflated:

- **Browser-local preference data** — a theme, a display currency, a list of
  addresses this browser cares about. Lives in `localStorage`. No database, no
  accounts, no server-side state, and nothing for a server to leak because the
  server never learns it exists.
- **Server persistence** — anything that must survive the browser, be shared
  between devices, or be read by something other than the page that wrote it.
  Historical snapshots (M4) are the real first case. That is when Postgres arrives.

ADR-002's _decision_ stands unchanged. Only its prediction about which feature would
force a database was wrong.

**Rationale.** The distinction is a privacy posture rather than a technicality. A
saved-wallet list on a server is a record of which wallets a named account watches —
exactly the kind of data this product has declined to create at every other
opportunity (ADR-009 on logo CDNs, ADR-021 on fetching the FX rate server-side).
Keeping it in the browser means no such record exists anywhere.

**Consequences, stated rather than discovered.**

**The list does not follow the user to another device.** That is the price, it is
real, and the panel says so rather than letting someone find out by losing it. Sync
remains the account decision in `DEV_PLAN.md` Part 4.

**A read has five outcomes, not two.** The existing `parseThemeMode` and
`parseCurrency` fall back to a default on anything unrecognised, which is right for a
colour and wrong for a wallet list: "you have no saved wallets" is a _claim_, and
making it because the store is corrupt or unreadable would be false — and would then
let the next save overwrite data this build never understood. So `readSavedWallets`
returns `ok`, `empty`, `partiallyInvalid`, `unsupportedVersion` or `unavailable`;
only `empty` entitles the UI to say nothing is saved, and `unsupportedVersion`
refuses to write at all.

**Stored data is hostile input, and one field is free text.** Every entry is
revalidated on read — address through `parseWalletAddress`, name through
`parseEnsName`, timestamp against implausible futures — and a bad entry is dropped
rather than repaired, with its siblings still rendering and the number dropped shown.
Every string and the raw payload are bounded.

Labels additionally strip **Unicode bidirectional overrides**. React prevents a label
executing as HTML; it does nothing about `U+202E`, which reverses the text after it
and would let a label make the address beside it read as a different address. The
canonical address is always shown and never replaced by a label. For the same reason
neither the source nor its tests contain a literal invisible character — they are
written as escapes, because a file defending against Trojan-Source characters must
not carry them.

**`saveWallet` validates rather than trusting its type.** `WalletAddress` is
`0x${string}`, which no compiler can check a checksum against. An entry written with
a bad checksum would be dropped by the very next read, so the save would appear to
work and then lose the wallet. Found by a test whose fixture had a hand-written
checksum.

**Writes re-read first.** `localStorage` has no transaction, so two tabs saving at
once would otherwise clobber each other. Last writer wins, stated rather than
assumed.

**Links do not prefetch.** Next.js prefetches a `<Link>` as it enters the viewport in
production, so listing ten saved wallets could send ten addresses to the server
merely by opening the landing page — disclosing precisely the list this design exists
to keep private. Rows are **plain anchors**: `prefetch={false}` would very likely do,
but an anchor has no prefetch behaviour to disable, so the guarantee does not depend
on what a framework flag currently means. They link by canonical address rather than
by ENS name, so listing a wallet cannot trigger name resolution either.

An E2E test counts every request mentioning a saved address and asserts none — and it
is worth recording what that test taught, because it was not what it first appeared.
It failed in CI, the conclusion drawn was "`prefetch={false}` does not cover hover",
and that was **wrong**: the requests came from the landing page's own hard-coded
example-wallet link, which points at the same address the test had saved. A leak and a
link that had always been there were indistinguishable. The test now uses an address
the page does not otherwise mention, and hovers the row deliberately rather than
relying on timing. The lesson is narrower than the first reading and more useful: a
privacy assertion has to be specific about _which_ request it forbids, or it will
report the wrong culprit convincingly.

**The snapshot is memoised.** `useSyncExternalStore` compares `getSnapshot` results
by identity, and the theme and currency stores get away with re-reading storage on
every call because they return a _string_. A freshly parsed array is a new reference
each time, which React treats as an endless update. The snapshot is therefore cached
against the raw stored text. This is a render loop rather than a wrong value, so
neither the type checker nor a value assertion would have caught it — review of the
plan did.

**What this deliberately does not do:** no cached money figures. A portfolio total is
a scoped priced subtotal, so a bare figure on the landing page could present a
single-network partial as the wallet's worth; stating it honestly needs a
terminal-outcome model with recorded scope and staleness rules. That is a follow-on
item, not a field bolted onto this one. Also absent: sync, background refresh,
import/export, manual reordering.

---

## ADR-024 — A bundle is a second aggregation axis, bounded and unmerged

**Context.** `AggregatePortfolio` combines one wallet's five networks into one honest
total. M3-2 asks for the same over several wallets: `/bundle/0xA,0xB,0xC`, shareable
as a URL, with no storage.

**Decision.** A separate `BundleState` with derived selectors, one aggregate request
per wallet at bounded concurrency, and **one table row per wallet position** rather
than merged rows.

**Rationale.**

**Not a flattened `AggregatePortfolio`.** The tempting shortcut hands every
(wallet, chain) portfolio to `buildAggregatePortfolio` as though it were a chain. It
typechecks and totals correctly — and then reports `chainCount: 15` for three wallets
on five networks, with the same network appearing three times in `failedChains`. The
UI would say "15 networks". What is shared is the arithmetic, not the shape, so
`sumPortfolioTotals` was extracted and both axes now add up through one
implementation.

**One canonical fact per member; everything else derived.** The first draft stored a
failure flag per member _and_ a list of failed addresses _and_ eight scalar counts —
three representations of the same facts, any two of which drift under a refresh. Only
the member map is stored.

**Four counts, not two.** A member whose request _finished_ is settled; one that
returned a portfolio is _readable_. The summary says "1 of 3 wallets readable"; saying
"2 of 3 settled" would count a failure as coverage, which is the defect review found
twice on the network axis before it could happen here.

**No merged rows, and this is the load-bearing decision.** Summing the same token
across wallets fails twice over:

- `priceUsd`, `priceQuality`, `priceCheck` and both change fields are **singular per
  asset**, and the table renders exactly one of each. A stale disputed quote in one
  wallet and an unchecked one in another leaves a merged row either hiding the
  uncertainty or applying it to a balance it does not describe — and it would break
  "N of M prices were checked", the sentence round 5 caught lying.
- Summing quantities is **not a money operation.** `sumMoney` rounds to 8 decimal
  places; a token quantity may carry 36, with the exact value in `rawQuantity` base
  units. Correct summing means adding `bigint` base units after proving the decimals
  match — a genuinely new arithmetic path, which the first draft claimed it was not.

One row per wallet position with a Wallet column shows _more_ than a merged row, not
less. The combined figure lives in the summary. Merged rows can return on top of a
member-observation model that can hold disagreeing prices.

**Bounded fan-out — and the reason is not the one first written down.** The draft
argued a per-network fan-out would cost "50 rate-limit tokens against a limit of 30".
That is false: `RateLimiter` grants an unidentified client `maxRequests * 10`, and
`TRUST_PROXY_HEADERS=false` (the default, per ADR-008) puts every caller in that
bucket — so the real allowance is 300. Fifty requests would have sailed through.

What actually matters is concurrency, and the real numbers are worse than the wrong
ones: both approaches do the same 50 cold per-chain loads and share the same cache,
but ten aggregate handlers each bounded at `CHAIN_SCAN_CONCURRENCY` permit **30
simultaneous chain loads from one link**, because that setting is per request and
nothing was per bundle. Hence `BUNDLE_MEMBER_CONCURRENCY` (2), and a test that counts
**concurrent loads rather than browser requests** — counting requests is precisely
what made the wrong argument look sound.

**Consequences.**

**ENS names are refused in a bundle URL**, with a message pointing at the single-wallet
route. Resolution is an `eth_call` on the render path — rate limited since ADR-025, but
a bundle URL would let a stranger multiply one page load into up to ten lookups, and
that argument stands on its own.

**A rejected input never causes a silent redirect.** One valid address plus one
rejected still renders as a bundle, because redirecting to the single-wallet view
would erase the notice, and a page cannot report what it discarded once it is no
longer the page. Parsing therefore returns a structured record carrying rejects,
duplicate count and omissions — and bounds the raw input _before_ parsing, validates,
de-duplicates, then caps, in that order, because capping first would let a dozen junk
segments crowd out two real addresses.

**Duplicates are removed before any arithmetic.** `/bundle/0xA,0xA` totalling one
wallet twice would overstate by 100 % and look entirely plausible.

**Freshness is the oldest member observation**, taken from member _chains_ — not from
`AggregatePortfolio.fetchedAt`, which the aggregate endpoint stamps with assembly time
even when its chains came from a nearly-expired cache. Trusting it would print
"updated just now" about minute-old data.

**Coverage and warnings travel with the total.** A wallet can be read and still have
enumerated only a bundled token list, or stopped at the asset ceiling. Every member
warning is preserved, named by wallet, with identical ones collapsed.

**EUR conversion requires agreement.** Ten independent responses need not share a
rate: one member may carry Friday's quote while another carries `rates.unavailable`
saying figures are dollars only. Convert only when every readable member agrees on the
rate and its date; otherwise no conversion, and say why.

**Every member failing is a load failure, not empty holdings.** Rendering it as "no
assets found" — or letting a null total become "no prices available" — would be a claim
about what the wallets hold when the truth is that nothing was read.

**"View together" is a plain anchor.** A prefetching link would put the whole saved
list, up to ten addresses in one URL, on the wire before any click (ADR-023).

**The route is `noindex, nofollow`** and its title is a count. A bundle URL discloses
an _association_ between addresses, which is more sensitive than any one of them.

**Row keys include the wallet.** `assetId` is `chainId:contractAddress` — the same
across wallets by design, since it identifies the token rather than the holding — so
two wallets holding USDC would have collided on it and React would have reconciled two
rows as one.

**Verified live:** two real wallets, bundle total $791,196.48 against per-wallet
figures of $685,873.55 and $105,322.93 — exact to the cent. Two API requests, one per
wallet.

---

## ADR-025 — Name resolution on the render path is rate limited

**Context.** `/api/portfolio` has been rate limited since ADR-008. But
`/portfolio/vitalik.eth` resolves the name _while rendering the page_ — an `eth_call`
against a real Ethereum endpoint, before any API is involved and outside every
protection the API has. Review round 4 named this "the one hard prerequisite before
going public", and it stayed open across three milestones because a tailnet-only
deployment (ADR-018) makes it unreachable by anyone hostile: only the owner's devices
can load the page at all.

The prerequisite stopped being theoretical when the owner asked whether Nuxfolio was
ready to be public. Unguarded, a stranger with a URL generator chooses how many
upstream calls this server makes — `/portfolio/a1.eth`, `/portfolio/a2.eth`, … — each
name distinct so the resolution cache never helps, each one an `eth_call` billed to
endpoints this deployment shares fairly with others. The resolution cache bounds
repeats of the _same_ name; nothing bounded the names.

**Decision.** ENS resolution on the page path goes through a gate
(`src/server/ensGate.ts`): the same `FixedWindowRateLimiter` class and the same
identity rules as the API — forwarding headers trusted only when an operator has said
a proxy overwrites them — but a **separate limiter instance**, so page lookups and API
calls spend independent budgets and a user browsing normally cannot lock themselves
out of their own data. Both pools read the same two knobs
(`RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_SECONDS`): one pair of numbers for an
operator to reason about.

A refused lookup is its own outcome, `rate-limited`, beside `not-found` and
`unavailable` — because the three ask the visitor for different things (give up,
retry, or wait), and collapsing "we will not look right now" into "the name is wrong"
is exactly the kind of substitution this codebase exists to refuse. The page renders
the refusal with the seconds to wait and the advice to paste the 0x address instead —
which is never rate limited, because it costs nothing upstream.

Two deliberate details. The gate runs **before** the resolution cache, so cache hits
are charged too: slightly unfair to a hot shared link, but charging only misses would
let an attacker probe which names this server resolved recently by watching which
lookups are free. And the page reads `headers()` only inside the name branch, so a
plain `0x…` render touches no request state and pays nothing.

**Consequences.** The standing go-public blocker is closed; what remains before a
public deployment are capacity and quota decisions, now recorded in `DEV_PLAN.md`
Part 6. On the tailnet deployment the gate is inert in practice — every caller is the
owner — but it means the posture no longer depends on the network boundary alone.
`generateMetadata` continues to resolve nothing, and the bundle route continues to
refuse names outright: a bundle URL would multiply one page load into up to ten
lookups, and that argument stands on its own regardless of the limiter.

---

## ADR-026 — Protocol accounts sit beside the assets, never inside the total

**Context.** M5 added Aave v3 borrower state: collateral, debt, and a health factor.
Every existing number on the page is a wallet balance priced by DefiLlama or CoinGecko.
These are neither — they are computed by Aave's own oracle, and the collateral behind
them is not in the asset list at all.

**Decision.** `protocolAccounts` is a separate array on `Portfolio`, rendered in its own
panel, and **no arithmetic combines it with `totalValueUsd`**.

**Why no net total.** The obvious formula — `total − debt` — cannot be trusted here,
and the plan proposed it before review round 12 worked an example (F-02).

The reason recorded at first was that Aave v3 receipt tokens are absent from the
bundled lists, making collateral invisible to the total. **That was wrong**, and
correcting it on 2026-08-07 made the decision better founded rather than worse: 53
tokens named `Aave v3 …` _are_ on the lists, so collateral is often visible. It is the
**inconsistency** that is fatal. `total − debt` returns the right answer for a wallet
whose receipt token happens to be listed, and is wrong by the entire collateral for one
whose is not — and nothing at runtime distinguishes the two. Taking the invisible case,
a wallet supplying $100,000 and borrowing $40,000 it still holds would report:

| Figure          | Value       |
| --------------- | ----------- |
| `totalValueUsd` | $40,000     |
| `total − debt`  | **$0**      |
| Actually worth  | **$60,000** |

The inputs were all correct. The error was arithmetic whose validity depends on data
the formula never inspects.

> **Superseded on 2026-08-08 by ADR-029, and this ADR's own prediction was wrong along
> the way.** It said a net total "becomes computable in M5-2, when per-token collateral
> is read directly and priced by the same source as everything else". M5-2 does read
> per-token collateral but prices it with **Aave's** oracle, not the app's — so the two
> figures still do not share a denominator, and for a day the conclusion here held for a
> different reason than the one written.
>
> What actually unblocked it was not a shared price source but a shared _identity_: M5-2
> also carries each position's receipt-token address, which is what tells the listed case
> from the unlisted one. The formula in ADR-029 is not `total − debt`; it removes the
> double count first. The rest of this ADR — figures beside the assets, never inside the
> total, sourced to Aave and labelled as such — is unchanged.

**The panel's wording carries this.** It says collateral _may also appear above as a
receipt token_, not "not included in the total above". The latter was true of the
figures — nothing here is summed into the total — and false about the money, which
invited precisely the addition it meant to prevent.

**Why Aave's own figures, not ours re-priced.** `getUserAccountData` returns money in
Aave's base currency (measured: USD at 1e8, through each market's own oracle). That is
a second price source — WETH at $1912.61 against DefiLlama's $1912.02 on 2026-08-06,
0.03 % apart and well inside ADR-019's tolerance. Re-pricing the debt with DefiLlama
while showing Aave's health factor would produce a page whose two numbers cannot be
reconciled with each other, because the health factor is derived from Aave's prices.
Internal inconsistency is worse than a 0.03 % difference from another source. So the
figures are Aave's, and the panel says "Reported by Aave" rather than implying they
share a denominator with the total above.

**Consequences.**

**Three states, three renderings.** No position renders as _nothing_ — a row of zeros
would be a claim. A market that could not be read renders as "Could not be read" plus a
warning naming how many of how many failed; it is never "no debt". Only a successful
read with a real balance is shown as a figure.

**Per market, not per chain.** Ethereum runs Core, Prime and EtherFi. Keying on chain
alone would read one and report a wallet borrowing in another as debt-free (round 12,
F-04). Seven markets are registered across five chains, each verified live — address,
that it answers, and that its oracle really reports USD at 1e8, because the interface
permits a base that would make every `…ValueUsd` field a lie (F-08).

**The health factor carries its definition, and rounds down.** "1.78" alone does not
say whether higher is better, so the page states that below 1 becomes eligible for
liquidation — a definition, not advice (F-09), rendered as text rather than a tooltip
that does not exist on a touch device. It rounds **down** to two decimals: 1.0999 shown
as "1.10" reads as further from liquidation than it is, and this is the one number here
where rounding the pleasant way flatters a risk. Aave rounds to nearest, so the last
digit can differ by 0.01, always toward caution.

**What this does not cover.** `totalCollateralBase` counts only reserves enabled as
collateral, so a supply-with-collateral-off position is invisible (F-03) — which is why
the field is `collateralValueUsd` and the milestone's promise is borrower risk rather
than "your Aave positions". Per-token detail, other protocols, and any net figure are
M5-2.

## ADR-027 — Positions inside a market are priced by that market's own oracle

**Context.** M5-2 breaks each Aave market's two headline figures into rows: which assets
the wallet supplied, which it borrowed, how much of each. A row wants a value beside its
amount — 4,123 USDe means little next to 671 USDC unless both carry a dollar figure.

The obvious source is the one every other value on the page uses, DefiLlama (ADR-005).
That is what the first review of this milestone recommended, with the rows labelled
"estimated" to mark them as a different source from the totals above them.

**Decision.** Rows are priced by the **market's own `AaveOracle`** — the same oracle
that produced the totals — and the row values therefore **sum to those totals exactly**.

**Why.** Because "exactly" turns out to be available, and it is worth more than
consistency with the rest of the page. Measured on Ethereum mainnet on 2026-08-07, for a
live borrower, at four consecutive blocks:

| Figure     | Rows summed | `getUserAccountData` | Difference       |
| ---------- | ----------- | -------------------- | ---------------- |
| Collateral | $17,528.00  | $17,528.00           | **0 base units** |
| Debt       | $8,064.46   | $8,064.46            | **0 base units** |

A breakdown priced by DefiLlama would be off by a different fraction of a percent every
block — small, real, and impossible for a reader to attribute to rounding rather than to
a bug. A breakdown that adds up is not a nicety here: it is the evidence that the rows
are the whole of the headline rather than a selection from it.

**Rounding follows Aave's, at both steps.** A supplied balance floors when it is scaled
and floors again when it is valued; a debt ceils at both. That second ceiling was
measured rather than assumed: flooring the value division left the debt total **3 base
units short — exactly one per borrowed row**. Aave rounds a debt up whenever it touches
it, and matching only the first step leaves an invariant that is broken by an amount
small enough to look like nothing.

**The oracle address is derived, never configured.** It is read from each market's
`PoolAddressesProvider` in the same batch as the balances, so it costs no extra round
trip. The asymmetry that decided this: a stale _pool_ address stops answering and the
read fails loudly, but a stale _oracle_ keeps returning plausible prices from a market
nobody uses any more — the rows would still look right and would quietly stop adding up.

**What this does not claim.**

- **A row the oracle cannot price shows no figure**, not a zero. Aave's oracle answers 0
  for a missing feed; carrying that through would turn a $17,000 collateral position into
  a worthless one. The visible rows then fall short of the headline by that position, and
  the row says so in words.
- **The totals and the rows are two reads**, a few hundred milliseconds apart. Interest
  accruing across that window is orders of magnitude below the cent these figures are
  shown to; a repayment landing between them is a real mismatch until the next refresh.
  Pinning both to one block would need an extra `eth_blockNumber` and would introduce a
  worse failure — a fallback endpoint one block behind cannot answer at a pinned height,
  so the breakdown would start failing on exactly the flaky public endpoints this runs
  on. Accepted, not overlooked.
- **Still no net total.** ADR-026's reasoning is unchanged: a net figure has to reconcile
  a receipt token in the asset list, priced by DefiLlama, against collateral here priced
  by Aave. Rows adding up to their own headline does not make the two headlines
  combinable.

**Consequences.** `decimals` and `symbol` are read from each underlying token rather than
joined against the bundled list, so an unlisted underlying renders properly instead of
being assumed to have 18 decimals — and MKR, which answers `symbol()` with a `bytes32`,
is one of the 80 Ethereum reserves, so the name is the single sub-call allowed to fail.

The breakdown is read for **every** detail-capable market, including one whose totals are
both zero. An earlier version skipped those to save a call; measured, that call costs
134 ms across all three Ethereum markets, and skipping it hid every supply with
collateral switched off — the one position that is invisible to the totals by
definition, and therefore the only one the breakdown alone can show. Paying the 134 ms
closes the gap ADR-026 recorded as out of scope.

## ADR-028 — Unclaimed rewards are read from every token a market has, not every token the wallet holds

**Context.** M5-4 adds the last piece of the Aave v3 adapter: incentives the market owes
but has not paid. `RewardsController.getAllUserRewards(assets, user)` answers it, and the
only question is what to pass as `assets`.

The cheap answer is the aTokens and debt tokens the wallet still holds — M5-2 already
knows them, and it costs nothing extra. **That answer is wrong**, and measurement rather
than reasoning is what showed it.

**Decision.** Pass **every** aToken and variable-debt token in the market, fetched for the
purpose, and accept the extra round trip that requires.

**Why.** The controller banks accrued rewards **per asset**. A wallet that supplied,
earned, and then withdrew in full keeps a balance that only that asset's entry can find.
Measured on Optimism on 2026-08-08, across forty wallets picked from recent aToken
transfers:

|                                                        |                                    |
| ------------------------------------------------------ | ---------------------------------- |
| Wallets with unclaimed OP                              | **18**                             |
| …that a held-tokens-only list would report as **zero** | **14**                             |
| Largest balance found                                  | **1,185.24 OP — $104**             |
| Typical balance found                                  | a few hundred-thousandths of an OP |

One of the fourteen was owed 0.915 OP while holding nothing in the market at all.
Passing an empty asset list returns zero, which is the experiment that exposed the
mechanism before the shortcut shipped rather than after.

**The distribution is the uncomfortable part, and it is recorded rather than smoothed
over.** Most unclaimed balances are dust worth a fraction of a cent. Both extremes are
shown at their true size: a threshold that hid the dust would be a number nobody chose
deciding what counts as money.

**Rewards do not need the `UiPoolDataProvider`.** The first version gated them behind the
same check as the position breakdown, which denied them to Optimism and BNB — and
Optimism has the most assets actually emitting of any market registered, fourteen of
twenty-eight. Rewards need the pool and the addresses provider, both of which every
market has. `addressesProvider` was promoted out of the optional `detail` block for this
reason: it is the root everything else is derived from, while the UI data provider is the
one genuinely optional extra.

**Everything is derived, nothing is configured.** The rewards controller comes from
`PoolAddressesProvider.getAddress(keccak256("INCENTIVES_CONTROLLER"))` — verified to
return the live controller — and the price oracle from the same provider, exactly as
ADR-027 does. No new addresses entered the registry for this feature.

**Consequences.**

- **A reward the market oracle cannot price shows an amount and no value.** Four of the
  five reward tokens Ethereum has configured are themselves aTokens, and `getAssetPrice`
  reverts for every one. That makes "no price" the ordinary case here rather than the
  exceptional one, so the price sub-call is allowed to fail and the amount stands alone.
- **`rewardsStatus` is separate from `positionsStatus`.** They are different reads over
  different contracts, and Optimism is the proof: it reports `positions: unavailable`
  beside `rewards: ok`, which is two true sentences that one field could not carry.
- **The reward read runs concurrently with the position read.** It costs three round
  trips to the position read's two; in series every market would take five.
- **A wallet with only rewards gets a panel.** `hasPosition` counts them, because most
  wallets with something unclaimed hold nothing in the market any more — the same
  measurement, applied to the question of whether to render at all.

## ADR-029 — A net-of-debt figure, now that the double count can be detected

**Supersedes the "no net total" half of ADR-026.** Everything else in ADR-026 stands.

**Context.** ADR-026 refused `netValueUsd` because the formula `total − debt` is right for
a wallet whose Aave receipt token happens to be on a bundled list and wrong by the entire
collateral for one whose is not, with nothing at runtime telling the two apart. The
worked example: a wallet supplying $100,000 and borrowing $40,000 reported **$0** against
a true $60,000.

That reasoning was sound and the missing piece was information, not judgement. M5-2 now
reads every position with the address of the receipt token it is held as. The two cases
are no longer indistinguishable.

**Decision.** Compute it, per chain and across chains:

```
  priced subtotal                  (assets, priced by the app's source)
− receipt tokens already inside it (the double count, matched by aToken address)
+ supplied, priced by the market   (the position, added back once)
− borrowed, priced by the market
```

Shown beneath the estimated value rather than in a card of its own, because the only
thing anyone wants to do with it is compare the two.

**The two worked examples, which are the reason to trust it.** Both are tests.

|                                    | Receipt token listed | Receipt token not listed |
| ---------------------------------- | -------------------- | ------------------------ |
| `total − debt` (ADR-026's formula) | $9,620.28            | **−$7,910.00**           |
| This calculation                   | $9,621.10            | **$9,618.00**            |

The correction is worth **82 cents** in the first case and **the entire collateral** in
the second. That shape is the point: it does nothing where the naive formula was already
right, and everything where it was catastrophically wrong. Verified live on 2026-08-08
against the benchmark borrower, where the adjustment came to $4.03 — the two price
sources disagreeing about the same WETH, and nothing else.

**It answers null far more readily than it answers a number**, and every refusal is a
case where the sum would be wrong in a way no reader could detect:

| Refusal                                         | Why                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| The wallet owes nothing                         | The net _is_ the total; a second copy invites a hunt for a difference that is not there     |
| A market could not be read                      | Its debt is unknown, and "it probably had nothing" is not a thing to put in a headline      |
| A market cannot say what its totals are made of | Optimism and BNB. The double count is undetectable, and both guesses are wrong by thousands |
| The market oracle could not price a position    | Leaving it out would understate by exactly the amount nobody can see                        |
| Nothing could be priced at all                  | There is no subtotal to adjust                                                              |

**What it is still not.** It is net of **Aave** debt, on the chains this product reads,
and the label says so rather than claiming "net worth". A wallet with a Compound loan
gets a figure that ignores it — which is why M5-3's coverage statement is a prerequisite
for this feature rather than an unrelated one.

**One price source still meets another inside it.** The subtotal is DefiLlama's and the
position is Aave's, so the figure inherits whatever they disagree about — $4.03 on a
$17,600 wallet when measured. That is a real cost, it was the reason to hesitate, and it
is accepted here because the alternative is a page that shows a debt and refuses to
subtract it. The disagreement is bounded by ADR-019's tolerance; the old formula's error
was not bounded at all.
