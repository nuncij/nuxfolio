# Nuxfolio — Implementation Plan (Milestone 1)

Status: authoritative plan for the first vertical slice.
Scope source: `PROJECT_KICKOFF.md`.

## 1. Repository state before this milestone

The repository was effectively empty:

```text
.git/                              (initialised, zero commits)
.nvmrc                             (24.18.1)
NUXFOLIO_CLAUDE_CODE_KICKOFF.md    (the kickoff brief)
NUXFOLIO_WSL_SETUP.md              (WSL environment notes, Slovenian)
```

Verified toolchain: Node.js v24.18.1, pnpm 11.18.0, both from `~/.nvm`. No
`package.json`, no dependencies, no source, no commits. Nothing to migrate or
preserve, so the stack is a free choice.

## 2. Stack

| Concern       | Choice                         | Why                                                           |
| ------------- | ------------------------------ | ------------------------------------------------------------- |
| Language      | TypeScript (strict)            | Required by the brief.                                        |
| Framework     | Next.js 15 (App Router)        | One process serves UI + server routes; keys stay server-side. |
| Styling       | Tailwind CSS v4                | No component-library weight; dark theme is a few tokens.      |
| Chain access  | `viem`                         | Typed RPC, `isAddress`/`getAddress`, batched `multicall`.     |
| Validation    | `zod`                          | Every external payload is parsed, never trusted.              |
| Decimal math  | `decimal.js` + native `bigint` | No float arithmetic on quantities or money.                   |
| Tests         | Vitest                         | Fast, no browser needed for logic tests.                      |
| Lint / format | ESLint (`next`) + Prettier     | Standard for this stack.                                      |
| Database      | **none**                       | Milestone 1 persists nothing. See `DECISIONS.md`.             |

Total runtime dependencies: `next`, `react`, `react-dom`, `viem`, `zod`,
`decimal.js`. Everything else is a dev dependency.

## 3. Architecture

Four layers, one direction of dependency (`app → server → providers → domain`):

```text
src/
  app/          Next.js routes: pages + /api/portfolio route handler
  components/   Presentational React; no provider or fetch logic
  server/       Request-scoped concerns: cache, rate limit, logging, HTTP, service
  providers/    Replaceable adapters behind PortfolioProvider / PriceProvider
  domain/       Types, zod schemas, address rules, decimal helpers, normalisation
  config/       ChainConfig registry, validated env, bundled token lists
```

Providers return **normalised domain objects**. No raw provider payload reaches
`server/` or the UI; every adapter parses its own response with zod and maps it.

### 3.1 Provider interfaces

```ts
interface PortfolioProvider {
  readonly id: string;
  supportsChain(chainId: number): boolean;
  // Raw base-unit balances + token metadata. No prices, no USD.
  fetchBalances(input: { address: Address; chain: ChainConfig }): Promise<BalanceSnapshot>;
}

interface PriceProvider {
  readonly id: string;
  // Batch lookup; unknown assets are simply absent from the result map.
  fetchPrices(input: { chain: ChainConfig; refs: PriceRef[] }): Promise<PriceMap>;
}
```

`BalanceSnapshot` carries `balances`, plus `warnings` and a `coverage`
descriptor so the UI can state _how_ the balances were discovered. That is the
mechanism behind "explain uncertainty instead of hiding it".

### 3.2 Adapters shipped in milestone 1

**Balances**

1. `rpc-token-list` (**default, zero configuration**) — `eth_getBalance` for the
   native asset plus a `Multicall3` `balanceOf` sweep over a bundled token list
   (395 Ethereum tokens from the Uniswap Labs default list, chunked 100 calls
   per request). Real on-chain data with no API key. Coverage is _partial by
   construction_: tokens outside the list are invisible, and the response says
   so explicitly.
2. `alchemy` (opt-in, `ALCHEMY_API_KEY`) — `alchemy_getTokenBalances` +
   `alchemy_getTokenMetadata` for full token discovery. Coverage `complete`.
3. `fixture` — deterministic in-repo data. Used by tests and by `pnpm dev`
   when someone wants the UI without touching the network.

**Prices**

`defillama` (**default, zero configuration**) — `coins.llama.fi` batch endpoint.
Returns price, timestamp and a confidence score per asset. Quotes below
`PRICE_CONFIDENCE_MIN`, or older than `PRICE_MAX_AGE_SECONDS`, are **flagged and
kept** rather than dropped: dropping them would leave the subtotal quietly wrong,
where flagging lets the user judge.

Selection happens in `providers/registry.ts` and is driven by capability — the
presence of a credential — not by a mode switch. Adding a provider means adding
one file and one registry entry; nothing else changes.

### 3.3 Chain configuration

```ts
type ChainConfig = {
  chainId: number;
  slug: string;
  name: string;
  shortName: string;
  nativeAsset: { symbol; name; decimals; priceId };
  rpcUrls: string[];
  multicall3Address: Address | null;
  explorerUrl: string;
  tokenList: TokenListEntry[];
  priceProviderNamespace: string;
  enabled: boolean;
};
```

Ethereum mainnet is `enabled: true`. A second entry (Base) ships
`enabled: false` purely to prove the registry and chain selector generalise —
it is not selectable and no code branches on chain identity.

### 3.4 Request flow (the vertical slice)

```text
/portfolio/0xabc…            (server component, validates + normalises address)
  └─ <PortfolioView>         (client: loading / error / partial states)
       └─ GET /api/portfolio?address=…&chainId=1
            ├─ rate limit (per IP, fixed window)
            ├─ cache lookup (address+chainId, 60 s TTL)
            ├─ PortfolioProvider.fetchBalances()
            ├─ PriceProvider.fetchPrices()      ← failure is non-fatal
            ├─ buildPortfolio()                 ← decimal math, shares, sort
            └─ zod-validated JSON response
```

Price failure degrades to quantities-only with a warning. Balance failure is
fatal _only_ when nothing usable was obtained: individual `balanceOf` reverts,
undecodable returns and failed batches are skipped, counted and warned about, so
one bad token cannot cost the user the rest of their portfolio.

## 4. Domain model

Follows the kickoff shape with one deliberate change: **money and quantity
fields are decimal strings, not `number`**.

```ts
type PortfolioAsset = {
  assetId: string; // `${chainId}:native` | `${chainId}:0x…`
  chainId: number;
  contractAddress: string | null;
  name: string;
  symbol: string;
  decimals: number;
  quantity: string; // human decimal, e.g. "1234.567891"
  rawQuantity: string; // base units, e.g. "1234567891"
  priceUsd: string | null;
  valueUsd: string | null;
  portfolioSharePct: string | null;
  logoUrl: string | null; // populated, not rendered — ADR-009
  priceSource: string | null;
  priceUpdatedAt: string | null; // null means "age unknown", not "fresh"
  priceQuality: 'ok' | 'low-confidence' | 'stale' | null;
};
```

The kickoff asks for a model "similar to" the sketch **and** forbids float
arithmetic where precision matters. `number` for `valueUsd` contradicts the
second requirement, so the second wins; the rationale is recorded in
`DECISIONS.md`. Rendering parses these strings with `Intl.NumberFormat` at the
last moment.

Arithmetic rules: `bigint` for base units, `Decimal` for prices, values, sums
and percentages. Share percentages are computed against the sum of _priced_
assets and only when that sum is > 0.

## 5. Files to create

```text
package.json  tsconfig.json  next.config.ts  postcss.config.mjs
eslint.config.mjs  .prettierrc.json  .prettierignore  vitest.config.ts
pnpm-workspace.yaml  .gitignore  .env.example  README.md

docs/{IMPLEMENTATION_PLAN,DECISIONS,PROVIDERS,REVIEW_LOG}.md

scripts/generate-token-list.mjs        Regenerates the bundled token list.

src/config/env.ts                      zod-validated server env; `server-only`
src/config/chains.ts                   ChainConfig registry; `server-only`
src/config/tokenlists/ethereum.json    Generated: 395 tokens

src/domain/address.ts                  parseWalletAddress(), shortenAddress()
src/domain/money.ts                    Decimal helpers and safe parsing
src/domain/portfolio.ts                Types + zod schemas
src/domain/normalize.ts                buildPortfolio(), sortAssets(), summarize
src/domain/viewState.ts                selectPortfolioViewState()

src/providers/types.ts                 Interfaces + ProviderError taxonomy
src/providers/registry.ts              capability → adapter instances
src/providers/balances/{jsonRpc,rpcTokenList,alchemy}.ts
src/providers/prices/defiLlama.ts

src/server/{logger,http,cache,rateLimit,deadline,concurrency,portfolioService}.ts

src/lib/{format,portfolioClient}.ts    Display formatting; browser API client

src/app/{layout.tsx,globals.css,page.tsx,not-found.tsx,icon.svg}
src/app/portfolio/[address]/page.tsx
src/app/api/portfolio/route.ts
src/components/{AddressForm,ChainSelector,PortfolioView,PortfolioSummary,
                AssetTable,WarningPanel,PortfolioSkeleton}.tsx
src/test/helpers.ts                    Shared fixtures; no test reaches the network
```

## 6. Tests (Vitest, colocated `*.test.ts`)

Every item the kickoff names, plus what the money layer needs:

| Area               | Cases                                                                                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Address validation | checksummed / lowercase / uppercase accepted and normalised; missing `0x`, wrong length, non-hex, ENS-looking input, whitespace, empty → typed rejection with a user-facing message |
| Decimal helpers    | base-unit → decimal for 0/6/18 decimals, huge balances beyond `Number.MAX_SAFE_INTEGER`, dust, exact multiplication                                                                 |
| Normalisation      | value = quantity × price; shares sum to 100 %; zero balances dropped; sort by value desc with symbol tie-break                                                                      |
| Missing prices     | unpriced assets keep quantity, get `valueUsd: null`, are excluded from the share denominator, and raise a warning; all-prices-missing yields `totalValueUsd: null` not `0`          |
| Provider errors    | RPC timeout / non-200 / malformed JSON / rejected zod shape → `ProviderError` with the right kind; price-provider failure is non-fatal; balance failure is fatal                    |
| HTTP client        | timeout via `AbortSignal`, retry on 429/5xx, no retry on 4xx, retry budget respected                                                                                                |
| Cache              | hit inside TTL, miss after expiry, per-address+chain keying                                                                                                                         |
| Rate limit         | allows up to the limit, blocks after, window resets                                                                                                                                 |
| API route          | invalid address → 400; valid → 200 shaped payload; over-limit → 429 with `Retry-After`                                                                                              |

## 7. Verification sequence

```bash
pnpm format:check   # prettier
pnpm lint           # eslint
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest run
pnpm build          # next build
```

Or `pnpm verify`, which chains all five. Then a manual smoke run against a real
address on `pnpm dev`, a visual check at desktop and mobile widths, and a review
of `git status` to confirm no secrets or build output are tracked.

## 8. Explicitly out of scope for this milestone

Wallet connection, signing, swaps, transfers, key handling, transaction
history, tax, AI analysis, CeFi integrations, social features, a custom
indexer, and any chain beyond Ethereum mainnet. Persistence, auth, and
multi-wallet aggregation are deferred to Phase 2.

## 9. Known limitations this milestone will ship with

This list describes **milestone 1** and is kept as written. Later milestones
closed items 3 and 4; the current list lives in `DEV_PLAN.md` under "Known gaps,
honestly stated".

1. Token discovery in the key-free mode is limited to the bundled list. Surfaced
   in the UI, not hidden.
2. Cache and rate limiter are in-process, so they are per-instance. Correct for
   a single node; a shared store is needed before horizontal scaling.
3. Prices come from one source with no cross-check. — _closed in M2-2: a
   CoinGecko verifier layered over the primary source, ADR-019._
4. Spam/scam token filtering is absent beyond the token-list constraint. —
   _closed in M2-1: suspect assets are excluded and accounted for, ADR-014._
5. No historical data of any kind.
6. Token logos are populated in the API but not rendered, so the browser makes no
   third-party requests (ADR-009).

---

## 10. Milestone 1.1 — coverage correction and multichain

Added after milestone 1 shipped, in response to a real wallet where Nuxfolio
reported $35,175 and DeBank reported $106,197 for the same address and chain.

**What was wrong.** Not the architecture — the token list. The Uniswap Labs
Default list omits wstETH, stETH, rETH, crvUSD and syrupUSDC, so three large
positions were invisible. They are ordinary ERC-20 balances; DeBank simply groups
them under protocol names. See ADR-012.

**What changed**

| Area         | Change                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------- |
| Token lists  | CoinGecko per-platform instead of Uniswap routing list: 395 → 12,346 tokens across 5 chains |
| Sweep        | `CALLS_PER_MULTICALL` 100 → 500, four batches in flight; a 5,078-token chain sweeps in ~1 s |
| Chains       | Ethereum, Base, Arbitrum One, OP Mainnet, BNB Smart Chain                                   |
| Default view | All networks; `?chainId=<id>` narrows to one                                                |
| API          | `?chainId=all` returns an `AggregatePortfolio`                                              |
| UI           | Per-network value breakdown, network column, combined coverage warning                      |
| Config       | Per-chain `*_RPC_URLS`, `CHAIN_SCAN_CONCURRENCY`                                            |

**Verified end to end**, keyless, on the benchmark wallet: ≈ $107k across five
networks against DeBank's $106,888 — within 0.01 %, with every per-network
subtotal matching. 296 tests, lint, type check and production build all pass.

**Still out of scope.** DeFi positions requiring a protocol's own accounting —
debt, health factors, LP composition, unclaimed rewards. Receipt tokens held in
the wallet are covered; the accounting behind them is Phase 3.
