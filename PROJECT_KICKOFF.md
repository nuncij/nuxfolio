# Nuxfolio — Claude Code Project Kickoff

You are the lead engineer for **Nuxfolio**, a read-only crypto portfolio tracker intended to become a credible alternative to DeBank.

Your job is not only to propose an architecture. Inspect the repository, make sensible decisions, scaffold the application, and implement the first working vertical slice.

## 1. Product vision

Nuxfolio should let a user enter a public wallet address and immediately understand:

- what assets the wallet owns,
- the estimated total portfolio value,
- how the portfolio is distributed across chains and tokens,
- where the largest risks and concentrations are,
- and, later, which DeFi protocols and positions the wallet is using.

The product must be:

- read-only,
- privacy-conscious,
- fast,
- easy to understand,
- multichain-ready,
- and designed for later AI-powered portfolio analysis.

Suggested positioning:

> **Nuxfolio — Your crypto portfolio, clearly explained.**

## 2. MVP scope

Build the smallest useful version first.

### Required in the first MVP

1. A landing/dashboard page with an input for a public EVM wallet address.
2. Validation of the entered address.
3. Retrieval of:
   - native asset balance,
   - ERC-20 token balances,
   - token metadata,
   - current estimated fiat value where available.
4. A portfolio summary showing:
   - total estimated value,
   - number of assets,
   - largest position,
   - chain or network being viewed.
5. A token table containing:
   - token name,
   - symbol,
   - quantity,
   - unit price,
   - total value,
   - percentage of the portfolio.
6. Sorting by value and token name.
7. Clear loading, empty, partial-data, rate-limit, and error states.
8. A responsive dark interface suitable for desktop and mobile.
9. A shareable URL or route for a wallet address.
10. A README explaining how to run the project locally.

### Keep out of the first MVP

Do not implement these yet unless the basic vertical slice is already complete:

- wallet connection or transaction signing,
- swaps,
- sending assets,
- private-key handling,
- full transaction history,
- taxation,
- AI investment recommendations,
- automatic CeFi exchange integration,
- social features,
- a custom blockchain indexer,
- every EVM chain at once.

For the first implementation, support **Ethereum mainnet first**, but design the code so additional EVM chains can be added through configuration and provider adapters.

## 3. Technical direction

Prefer a simple architecture that one developer can operate.

Unless the existing repository clearly suggests a better choice, use:

- TypeScript,
- a modern React full-stack framework,
- server-side API routes or server functions,
- a relational database only where persistence is genuinely needed,
- a small provider abstraction for blockchain balances,
- a separate price-provider abstraction,
- schema validation for all external data,
- environment variables for API keys,
- caching for expensive external requests,
- automated tests for important business logic.

Do not tightly couple the application to a single third-party provider.

Create interfaces such as:

- `PortfolioProvider`
- `PriceProvider`
- `ChainConfig`

A provider should return normalized domain objects rather than leaking its raw API response into the UI.

Do not scrape DeBank. Use official RPC endpoints or legitimate third-party APIs whose current terms permit this use. Document the chosen provider, limitations, pricing assumptions, and replacement strategy.

## 4. Suggested domain model

Use a normalized model similar to:

```ts
type Portfolio = {
  address: string;
  chainId: number;
  totalValueUsd: number | null;
  assets: PortfolioAsset[];
  fetchedAt: string;
  warnings: string[];
};

type PortfolioAsset = {
  assetId: string;
  chainId: number;
  contractAddress: string | null;
  name: string;
  symbol: string;
  decimals: number;
  quantity: string;
  priceUsd: number | null;
  valueUsd: number | null;
  portfolioSharePct: number | null;
  logoUrl: string | null;
};
```

Use precise decimal handling. Do not use JavaScript floating-point arithmetic for token quantities or financial calculations where precision matters.

## 5. UX direction

The initial dashboard should feel clean and credible, not like a trading casino.

Include:

- a prominent wallet-address input,
- a compact portfolio summary,
- a chain selector prepared for future networks,
- a sortable asset table,
- skeleton loading states,
- helpful warnings when price data is missing,
- an explanation that values are estimates,
- a visible “read-only” security note.

Never ask for a seed phrase or private key.

Do not fill the interface with placeholder cards that have no working functionality.

## 6. Security and reliability requirements

- Never log secrets.
- Never request private keys or seed phrases.
- Validate and normalize all addresses.
- Validate all third-party API responses.
- Add timeouts and sensible retries to external requests.
- Handle partial provider failures.
- Add basic rate limiting or abuse protection to public endpoints.
- Cache portfolio results for a short period.
- Keep dependencies minimal and justified.
- Add an `.env.example`.
- Ensure secrets are excluded from version control.
- Add structured server-side logging.
- Avoid exposing provider API keys to the browser.
- Clearly label stale or incomplete data.

## 7. Engineering workflow

Follow this sequence:

1. Inspect the repository and current environment.
2. Summarize what already exists.
3. Write a concise implementation plan in `docs/IMPLEMENTATION_PLAN.md`.
4. Record important architectural decisions in `docs/DECISIONS.md`.
5. Scaffold only what is required.
6. Implement one end-to-end vertical slice:
   - user enters an Ethereum address,
   - the server retrieves balances,
   - prices are resolved,
   - normalized data is returned,
   - the dashboard renders the portfolio.
7. Add tests for:
   - address validation,
   - portfolio normalization,
   - percentage calculations,
   - missing-price handling,
   - provider error handling.
8. Run formatting, linting, type checking, tests, and the production build.
9. Fix failures rather than merely reporting them.
10. Update the README with exact local setup instructions.

Do not stop after creating a plan. Implement the working slice.

## 8. Acceptance criteria

The first milestone is complete when:

- the project starts locally using documented commands,
- a user can enter a valid Ethereum address,
- the application retrieves and displays real asset data,
- invalid addresses are rejected with a clear message,
- missing prices do not break the page,
- the API key is never sent to the client,
- the page works on desktop and mobile,
- linting, type checking, tests, and production build pass,
- setup and architectural decisions are documented.

## 9. Future roadmap

Design for these later phases, but do not build them before the MVP works:

### Phase 2

- additional EVM chains,
- saved watchlist,
- portfolio snapshots,
- historical value chart,
- multiple wallet aggregation.

### Phase 3

- DeFi protocol positions,
- lending and borrowing,
- LP positions,
- staking,
- debt and health-factor visibility.

### Phase 4

- Bitcoin and other non-EVM networks,
- manual CeFi and cold-wallet entries,
- unified net-worth view.

### Phase 5

- AI risk analysis,
- concentration warnings,
- protocol and stablecoin exposure,
- scenario analysis,
- personalized reports,
- paid analysis features.

## 10. Important product principles

- Read-only before transactional.
- Accurate before feature-rich.
- Explain uncertainty instead of hiding it.
- Build a useful vertical slice before adding more chains.
- Keep external providers replaceable.
- Do not claim that a value is exact when it is estimated.
- Do not present AI output as guaranteed financial advice.
- Prefer a maintainable product over a flashy prototype.

## 11. Start now

Begin by inspecting the repository.

Then:

1. report the current state,
2. choose the smallest sensible stack,
3. write the implementation plan,
4. scaffold the application,
5. implement the Ethereum portfolio vertical slice,
6. run all checks,
7. leave the repository in a working state.

When making assumptions, document them and continue unless the decision would cause irreversible data loss or create a security risk.
