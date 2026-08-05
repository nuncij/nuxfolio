# Data Providers

What Nuxfolio talks to, what each one is allowed to be relied on for, where it
breaks, and how to replace it.

**A note on what is verified here.** The endpoint behaviour below was measured
directly on **2026-07-30** — and for the CoinGecko cross-check in section 4, on
**2026-07-31** — and is reproducible with the commands shown. The
usage-rights notes are _not_ a legal review: an endpoint answering a request
proves availability, not permission. Before any commercial or high-volume
deployment, an operator must read each provider's current terms and confirm the
points marked **verify before production**.

---

## 1. Balances — `rpc-token-list` (keyless fallback, used when no `ALCHEMY_API_KEY` is set)

|               |                                                                                 |
| ------------- | ------------------------------------------------------------------------------- |
| Endpoints     | two public endpoints per chain, tried in order — see the table below            |
| Methods       | `eth_getBalance`, `eth_call` (Multicall3 `aggregate3`)                          |
| Credentials   | none                                                                            |
| Configuration | `ETHEREUM_RPC_URLS`, `BASE_RPC_URLS`, `ARBITRUM_RPC_URLS`, `OPTIMISM_RPC_URLS`, |
|               | `BSC_RPC_URLS` override the defaults                                            |

| Chain           | Default endpoints                                         |
| --------------- | --------------------------------------------------------- |
| Ethereum        | `ethereum-rpc.publicnode.com`, `eth.llamarpc.com`         |
| Base            | `base-rpc.publicnode.com`, `mainnet.base.org`             |
| Arbitrum One    | `arbitrum-one-rpc.publicnode.com`, `arb1.arbitrum.io/rpc` |
| OP Mainnet      | `optimism-rpc.publicnode.com`, `mainnet.optimism.io`      |
| BNB Smart Chain | `bsc-rpc.publicnode.com`, `bsc-dataseed.binance.org`      |

**How it works.** A node cannot enumerate an address's ERC-20 holdings, so this
adapter asks `balanceOf` for every token in that chain's bundled list — 12,346
across the five networks — and keeps the non-zero answers. Reads are batched
through Multicall3 (`0xcA11bde05977b3631167028862bE2a173976CA11`, verified
byte-identical on all five chains) at **500 calls per request**, with **4 batches
in flight**. Ethereum's 5,078 tokens are therefore 11 `aggregate3` calls plus one
`eth_getBalance`; a full five-network scan takes ~2 s cold and is cached for 60 s.

**Verified behaviour.**

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","latest"]}' \
  https://ethereum-rpc.publicnode.com
```

**Limitations.**

1. **Coverage is partial by construction.** Tokens outside the bundled list are
   invisible. Reported as `coverage: "token-list"` plus a user-visible warning on
   every response — never silently.
2. The list ages until `pnpm tokens:generate` is re-run.
3. Public endpoints are shared infrastructure with undisclosed, changeable rate
   limits. Requests are issued sequentially for this reason.
4. No spam- or scam-token filtering beyond the list itself.

**Usage rights.** PublicNode (Allnodes) and the chains' own public endpoints are
published for public use without registration. None publishes a hard per-client
quota. **Verify before production**, and prefer a dedicated endpoint:
public RPC is appropriate for development and low traffic, not for a service
whose availability you promise to anyone.

**Cost assumption.** Zero, and correspondingly zero availability guarantee.

**Replacement.** Set the relevant `*_RPC_URLS` variable to any JSON-RPC endpoint
for that chain — your own node, Alchemy, Infura, QuickNode. No code change. A
keyed URL is never written to a log: endpoints are identified as "endpoint 1",
"endpoint 2", and any configured URL is additionally scrubbed from log output.

---

## 2. Balances — `alchemy` (preferred whenever a key is configured)

|             |                                                                          |
| ----------- | ------------------------------------------------------------------------ |
| Endpoint    | `https://eth-mainnet.g.alchemy.com/v2/{ALCHEMY_API_KEY}`                 |
| Methods     | `alchemy_getTokenBalances`, `alchemy_getTokenMetadata`, `eth_getBalance` |
| Credentials | `ALCHEMY_API_KEY` — server-side only                                     |
| Activation  | automatic when the key is set                                            |

**How it works.** Alchemy's index answers the question a node cannot, returning
every ERC-20 the address holds. Metadata for tokens already on the bundled list
is taken from the list, so `alchemy_getTokenMetadata` is only called for
contracts Nuxfolio does not recognise.

**Bounds.** Discovery is unbounded by nature — anyone can airdrop tokens into
any wallet — so every dimension has a ceiling: 5 pages of balances,
`MAX_ASSETS_PER_PORTFOLIO` (default 400) assets, 6 concurrent metadata reads,
and the shared `REQUEST_DEADLINE_MS` budget. When a ceiling is reached the
snapshot reports `coverage: "truncated"`, never `"complete"`.

**Limitations.**

1. Requires an account. Nuxfolio must work without one, which is why it is not
   the only balance provider.
2. Free-tier compute units are finite; a wallet with thousands of unrecognised
   tokens is the expensive case.
3. Tokens whose `decimals` cannot be resolved are skipped rather than shown with
   a guessed quantity, and counted in a warning.

**Usage rights.** Ordinary API use under an Alchemy account, subject to their
current terms and the tier you signed up for. **Verify before production** that
your traffic fits your plan.

**Cost assumption.** Free tier is sufficient for personal use. Costs scale with
requests, so the metadata-from-token-list optimisation is a cost control, not
only a latency one.

**Replacement.** Write one adapter implementing `PortfolioProvider`
(`src/providers/balances/`) and add a branch in
`src/providers/registry.ts`. Moralis, Covalent, Ankr and self-hosted indexers all
fit the same interface. Nothing outside those two files changes.

---

## 3. Prices — `defillama` (default, no key)

|             |                                                |
| ----------- | ---------------------------------------------- |
| Endpoint    | `https://coins.llama.fi/prices/current/{refs}` |
| Credentials | none                                           |
| Batch size  | 60 refs per request                            |

**How it works.** Refs are `ethereum:0x…` for tokens and `coingecko:ethereum`
for the native asset. The response carries `price`, `timestamp`, `symbol`,
`decimals` and `confidence` per coin.

**Verified behaviour.**

```bash
curl -s "https://coins.llama.fi/prices/current/ethereum:0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,coingecko:ethereum"
```

**Why not CoinGecko as the primary.** Measured the same day: without an API key,
`/api/v3/simple/token_price/ethereum` rejects more than **one** contract address
per request with `error_code: 10012`. Pricing a 60-token wallet would mean 60
requests against a low keyless budget. DefiLlama batches, and it returns the
per-coin `timestamp` and `confidence` that make honest staleness labelling
possible at all — CoinGecko reports no confidence figure, so selecting it
_instead_ would silently disable the staleness flags. That is why the key, when it
arrived, made CoinGecko a verifier rather than a replacement (section 4).

**Past prices.** The same adapter implements `fetchHistoricalPrices` against
`/prices/historical/{unix}/{refs}`, which returns the same `price`, `timestamp`
and `confidence` fields at a chosen instant. Used for the 24 h / 7 d change
column. Deliberately **not** `/percentage`, which answers the question in one call
but returns a bare number with no timestamp and no confidence — so there is no way
to tell whether the figure rests on a usable observation (ADR-020). Verified that
the locally-computed change matches `/percentage` to the cent, so the extra call
buys the metadata rather than a different answer.

Bounded by `PRICE_HISTORY_MAX_ASSETS` (default 50 per chain, by value): two batched
requests per chain, ten per five-network load. Without the cap the 400-asset
ceiling would allow 14 per chain.

**Limitations.**

1. One source, unless a CoinGecko Demo key is configured — see section 4, which
   adds a cross-check on top rather than replacing this provider.
2. `confidence` is DefiLlama's own metric; Nuxfolio surfaces it rather than
   interpreting it, flagging quotes below `PRICE_CONFIDENCE_MIN` (default 0.7).
3. Illiquid tokens may be unpriced or priced with a stale timestamp. Unpriced
   assets are excluded from the total and counted in a warning; quotes older than
   `PRICE_MAX_AGE_SECONDS` (default 3600) are marked stale in the table.
4. A price is a market reference, not an executable quote. The UI says so.

**Usage rights.** DefiLlama publishes this endpoint for free public use without
registration and documents paid tiers for higher volume. **Verify before
production**, including any attribution expectation.

**Cost assumption.** Zero at MVP volume, with a paid tier available if that
changes.

**Replacement.** Implement `PriceProvider` in `src/providers/prices/` and change
one line in `registry.ts`. `PriceRef` is deliberately vendor-neutral —
`{ chainId, contractAddress }` — so a CoinGecko, CoinMarketCap or on-chain-oracle
adapter maps identities internally without touching chain config or the service
layer.

---

## 4. Price cross-check — `coingecko` (optional, needs a free Demo key)

|             |                                                                |
| ----------- | -------------------------------------------------------------- |
| Endpoints   | `/api/v3/simple/token_price/{platform}` (tokens by contract)   |
|             | `/api/v3/simple/price` (native assets by coin id)              |
| Credentials | `COINGECKO_API_KEY`, sent as an `x-cg-demo-api-key` **header** |
| Batch size  | 100 contract addresses per request                             |
| Quota       | 100 calls/min, 10,000 calls/month (Demo plan, free)            |

**What it is.** A `PriceVerifier`, not a `PriceProvider` — a second opinion
layered over the primary lookup rather than an alternative to it. Nuxfolio asks it
only about the assets material to the total, compares in `Decimal`, and marks a
disagreement beyond `PRICE_DISPUTE_TOLERANCE` (default 2 %) as `disputed`.
**Neither source wins:** the primary price stays in the total and both figures are
available. Rationale in ADR-019.

Assets not asked about carry `priceCheck: null` and are reported as unchecked, not
as agreed. Because the table marks only disagreements, the summary states the
scope — "2 of 6 prices were checked against a second source".

**Verified behaviour**, probed live on 2026-07-31 rather than read from the docs:

| Probe                    | Result                                                      |
| ------------------------ | ----------------------------------------------------------- |
| Keyless, 2+ addresses    | `error_code: 10012` — one address per call                  |
| Demo key, 175 addresses  | 200 OK                                                      |
| Demo key, 200 addresses  | **HTTP 414, HTML body** — nginx URI limit (~8 KB), not JSON |
| Invalid key              | 401 with `error_code: 10002`                                |
| Native asset by contract | not possible; needs `/simple/price?ids=<coin id>`           |

The 414 is why the chunk size is 100 rather than 175: the ceiling belongs to
someone else's web-server configuration and arrives as an unparseable body rather
than an error code the adapter could branch on. Measured cost on the benchmark
wallet: **8 requests** for a full five-network load (7 of 55 assets checked), so
roughly 1,250 loads a month fit inside the Demo quota.

**Credential handling.** The key travels in a header, never in a URL — a URL
reaches error messages, proxy logs and referrers. The adapter also logs a fixed
label instead of the request URL, so neither the key nor the wallet's contract
addresses can leak through a log line. Both properties have tests.

**Usage rights — an obligation, not a courtesy.** The Demo plan requires visible
attribution: **"Powered by CoinGecko API"**, linked to their API page, at no less
than 10 pt. Nuxfolio renders it from the response payload whenever a cross-checked
price is shown, so it cannot be forgotten when the check runs or displayed when it
did not. Two E2E tests hold both halves.

**Limitations.**

1. Coverage is 95 % of value per network, capped at 25 assets — quota is finite.
   Unchecked is reported as unchecked.
2. CoinGecko reports no confidence score. The verifier records `confidence: null`
   rather than inventing `1.0`, which would claim certainty the source never
   offered.
3. Chains without a platform mapping simply go unchecked; that is not an error.
4. A dispute means the two sources disagree. It does not identify which is wrong,
   and Nuxfolio does not pretend otherwise.

**Cost assumption.** Zero. The Demo plan is free and has no expiry; the quota
maths above leaves a wide margin at single-user volume.

**Replacement.** Implement `PriceVerifier` in `src/providers/prices/`. It returns
the same `PriceLookup` shape as `PriceProvider`, so a third source needs no new
type and the comparison logic in `domain/priceCheck.ts` is untouched.

---

## 5. Exchange rate — European Central Bank (keyless)

|             |                                                                 |
| ----------- | --------------------------------------------------------------- |
| Endpoint    | `https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml` |
| Credentials | none                                                            |
| Format      | XML — the one adapter that does not parse JSON                  |
| Cached      | one day, server-side                                            |

**What it is for.** The optional euro display. Nuxfolio computes in USD
throughout; a euro figure is a render-time conversion and nothing else (ADR-021).

**Verified behaviour**, probed 2026-08-03:

```bash
curl -s https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml | head -12
# <Cube time='2026-07-31'>
#   <Cube currency='USD' rate='1.1485'/>
```

**The date matters more than the rate.** The ECB fixes rates around 16:00 CET on
**TARGET business days only**. A request on a Monday returns Friday's figure, and a
holiday can make it four days old. `asOf` is therefore taken from the document,
never from the fetch time, and the page names it. A rate older than 14 days — well
beyond any weekend — raises `rates.aged`.

**Direction.** The ECB quotes the euro as the base: `1 EUR = 1.1485 USD`. Dollars
become euros by **dividing**. Multiplying would overstate every figure by about a
third, consistently enough to look plausible, which is why the direction has its
own test against a hand-computed value.

**Fetched server-side**, inside the shared request deadline, and carried on the
API response. A browser request to the ECB would disclose that the visitor is
looking at a portfolio — the same leak ADR-009 refuses for logo CDNs.

**Limitations.** One currency pair, because that is all a display conversion needs.
No historical rates, so a past valuation cannot be converted at its own day's rate.
A rate that is zero, negative or unparseable yields no rate at all rather than a
division.

**Usage rights.** The ECB publishes these reference rates for public use and
states they are intended for information purposes. **Verify before production** if
you intend to redistribute them or rely on them for settlement — they are reference
rates, not tradable quotes.

**Cost assumption.** Zero. No registration, no quota published.

**Replacement.** Implement `RateProvider` in `src/providers/rates/`. `FxQuote` is
vendor-neutral and carries a decimal-string rate plus the source's own date, so any
provider that publishes both fits without touching the display layer.

---

## 6. Token list — Uniswap Labs Default

|            |                                                                   |
| ---------- | ----------------------------------------------------------------- |
| Source     | `https://tokens.coingecko.com/{platform}/all.json`, one per chain |
| In tree    | **12,346 tokens**, generated 2026-07-30                           |
| Regenerate | `pnpm tokens:generate` (all chains) or with a chain slug          |
| Output     | `src/config/tokenlists/{chain}.json` (generated, committed)       |

| List      | Entries | CoinGecko platform    |
| --------- | ------- | --------------------- |
| Ethereum  | 5,078   | `ethereum`            |
| BNB Chain | 3,427   | `binance-smart-chain` |
| Base      | 2,557   | `base`                |
| Arbitrum  | 1,037   | `arbitrum-one`        |
| Optimism  | 247     | `optimistic-ethereum` |

Fetched at build time rather than on the request path: lists change slowly, and a
runtime fetch would add latency and a failure mode to every portfolio load. Only
`address`, `name`, `symbol`, `decimals` and `logoURI` are kept, each file records
its `source` and `generatedAt`, and addresses are checksummed on the way in.

**Why not the Uniswap default list**, which this originally used: it is a DEX
_routing_ list of 395 Ethereum entries, curated for swappability rather than for
holdings. Benchmarking against a real wallet found it missing wstETH, syrupUSDC
and others — a **≈ $71k** coverage gap on a ≈ $105k portfolio, with entirely
correct code. Coverage gaps hide in data choices, not only in code. See ADR-012.

**Limitations.** Inclusion is CoinGecko's editorial decision, not a completeness
guarantee, and the committed copy ages between regenerations. `generatedAt` is
recorded and the UI warns past `TOKEN_LIST_MAX_AGE_DAYS` (default 60), so aging is
visible rather than silent — but regeneration is still a manual step (M2-5(b)).

**Usage rights.** The retained fields are factual token identifiers. Each file
records its source. **Verify before production** if you intend to redistribute the
lists themselves rather than consume them.

**Replacement.** Point `TOKEN_LIST_URL` at any
[token-list-standard](https://tokenlists.org) URL and re-run the generator for
that chain.

---

## 7. What Nuxfolio deliberately does not do

- **No DeBank scraping**, or scraping of any competitor. Every byte comes from a
  documented public API or a public RPC method.
- **No third-party requests from the browser.** Token logos are not rendered
  (ADR-009), so a wallet's holdings are never disclosed to a logo CDN.
- **No credential ever reaches the client.** Every provider call is made
  server-side; `src/config/env.ts` is marked `server-only` so an accidental
  client import fails the build rather than leaking a key.

## 8. Operational summary

| Failure                      | Effect on the user                                  |
| ---------------------------- | --------------------------------------------------- |
| One RPC endpoint down        | Silent fallback to the next endpoint                |
| All RPC endpoints down       | Error page with a retry action                      |
| One token batch fails        | Portfolio renders, warning names the gap            |
| Price provider down          | Quantities render, values blank, warning shown      |
| Provider rate-limits us      | 503 with `Retry-After`, retry offered               |
| Wallet holds unlisted tokens | Coverage warning states what was not checked        |
| Cross-check batch fails      | Those prices go unconfirmed, warning names how many |
| Cross-check unavailable      | Portfolio unchanged, one warning, no price marked   |
| No CoinGecko key configured  | No cross-check and no warning — the default state   |
| Past prices unavailable      | No change figures, one warning, values unaffected   |
| Exchange rate unavailable    | No euro toggle, one warning, dollars unaffected     |
