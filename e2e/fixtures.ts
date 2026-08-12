import type { Page, Route } from '@playwright/test';

import { E2E_PORT } from '../playwright.config';

import {
  aggregatePortfolioSchema,
  ALL_CHAINS,
  portfolioSchema,
  type AggregatePortfolio,
  type ApiErrorCode,
  type Portfolio,
  type PortfolioAsset,
  type PortfolioWarning,
} from '@/domain/portfolio';

/**
 * Payload fixtures and the API interception the end-to-end suite runs on.
 *
 * Two properties make these fixtures worth trusting:
 *
 *  - They are typed as the real domain model and validated against the real zod
 *    schema, the same one the browser client validates responses with. A schema
 *    change therefore fails `pnpm typecheck`, or throws a zod error the moment a
 *    test builds its plan — instead of surfacing as an unexplained empty table.
 *  - Every number is written out rather than computed. A fixture that derives
 *    its totals with the application's own helpers can agree with a bug in them,
 *    and these figures are round enough to check by eye.
 *
 * Only `@/domain/portfolio` is imported: it is client-safe. Nothing under
 * `@/config` or `@/server` may be pulled in here — those modules import
 * `server-only`, which throws outside a React Server Component graph.
 */

/** The wallet every scenario looks up: a well-known public address. */
export const E2E_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

/** Fixed, so no rendered figure depends on when the suite runs. */
const FETCHED_AT = '2026-07-30T12:00:00.000Z';

/** Real mainnet USDC, so a reader can recognise the row it produces. */
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
/** Real mainnet WBTC, so the classification registry resolves it. */
const WBTC = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';
/** Off the bundled list by construction — this is the spoofing test subject. */
const FAKE_USDC = '0x00000000000000000000000000000000DeaDBeef';

/**
 * Chain identities, mirroring the registry in `src/config/chains.ts` (server-only,
 * so it cannot be imported here). `chainName` is what the UI renders; `listSize`
 * is the real bundled list size, because the coverage warning quotes it and the
 * aggregate view parses it back out of that sentence to combine the warnings.
 */
const CHAINS = {
  ethereum: { chainId: 1, chainName: 'Ethereum Mainnet', shortName: 'Ethereum', listSize: 5078 },
  base: { chainId: 8453, chainName: 'Base', shortName: 'Base', listSize: 2557 },
  arbitrum: { chainId: 42161, chainName: 'Arbitrum One', shortName: 'Arbitrum', listSize: 1037 },
  optimism: { chainId: 10, chainName: 'OP Mainnet', shortName: 'Optimism', listSize: 247 },
  bsc: { chainId: 56, chainName: 'BNB Smart Chain', shortName: 'BNB Chain', listSize: 3427 },
  polygon: { chainId: 137, chainName: 'Polygon PoS', shortName: 'Polygon', listSize: 857 },
  avalanche: {
    chainId: 43114,
    chainName: 'Avalanche C-Chain',
    shortName: 'Avalanche',
    listSize: 693,
  },
  gnosis: { chainId: 100, chainName: 'Gnosis', shortName: 'Gnosis', listSize: 111 },
} as const;

/** Registry order, which is the order the aggregate view lists networks in. */
const CHAIN_ORDER = [
  CHAINS.ethereum,
  CHAINS.base,
  CHAINS.arbitrum,
  CHAINS.optimism,
  CHAINS.bsc,
  CHAINS.polygon,
  CHAINS.avalanche,
  CHAINS.gnosis,
] as const;

type ChainIdentity = (typeof CHAIN_ORDER)[number];

/** The chain the API falls back to when a request names none. */
const DEFAULT_CHAIN_ID = 1;

export type ApiFailure = {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly message: string;
};

/** The 429 the API returns when its own fixed-window limiter trips. */
export const RATE_LIMITED: ApiFailure = {
  status: 429,
  code: 'rate-limited',
  message: 'Too many requests. Please wait a moment and try again.',
};

/** How a chain whose RPC endpoints are all down is reported. */
export const CHAIN_UNAVAILABLE: ApiFailure = {
  status: 503,
  code: 'upstream-unavailable',
  message: 'The data provider is unavailable right now. Please try again shortly.',
};

type ChainOutcome = { readonly portfolio: Portfolio } | { readonly failure: ApiFailure };

/**
 * What the mocked API will answer for one wallet.
 *
 * The cross-chain money figures are part of the plan rather than summed from the
 * chains for the reason given above: the totals a test asserts on should be
 * stated, not derived.
 */
export type PortfolioPlan = {
  /** One entry per registered chain, in registry order. */
  readonly chains: readonly { readonly identity: ChainIdentity; readonly outcome: ChainOutcome }[];
  readonly totalValueUsd: string | null;
  readonly suspectValueUsd: string | null;
};

/** A usable change observation, for the rows that should show a figure. */
function rose(pct: string, thenUsd: string): PortfolioAsset['priceChange24h'] {
  return { status: 'ok', pct, thenUsd, asOf: '2026-07-29T12:00:00.000Z' };
}

/** The ECB rate the EUR fixtures convert at. 1 EUR = 1.25 USD keeps the maths round. */
const FX_RATE = { base: 'EUR' as const, quote: 'USD' as const, rate: '1.25', asOf: '2026-07-31' };

/** Every network answers; Ethereum carries a spoofed airdrop. Total: $5,400.00. */
export function allNetworksPlan(): PortfolioPlan {
  return {
    chains: [
      { identity: CHAINS.ethereum, outcome: { portfolio: ethereumPortfolio() } },
      { identity: CHAINS.base, outcome: { portfolio: basePortfolio() } },
      { identity: CHAINS.arbitrum, outcome: { portfolio: arbitrumPortfolio() } },
      { identity: CHAINS.optimism, outcome: { portfolio: optimismPortfolio() } },
      { identity: CHAINS.bsc, outcome: { portfolio: bscPortfolio() } },
    ],
    // 4,000 + 500 + 200 + 100 + 600, with the spoofed 5,000 deliberately outside.
    totalValueUsd: '5400.00000000',
    suspectValueUsd: '5000.00000000',
  };
}

/** BNB Chain is unreachable; the other four answer. Total: $4,800.00. */
export function oneNetworkFailingPlan(): PortfolioPlan {
  return {
    chains: [
      { identity: CHAINS.ethereum, outcome: { portfolio: ethereumPortfolio() } },
      { identity: CHAINS.base, outcome: { portfolio: basePortfolio() } },
      { identity: CHAINS.arbitrum, outcome: { portfolio: arbitrumPortfolio() } },
      { identity: CHAINS.optimism, outcome: { portfolio: optimismPortfolio() } },
      { identity: CHAINS.bsc, outcome: { failure: CHAIN_UNAVAILABLE } },
    ],
    // 5,400 less BNB Chain's 600: a network that could not be read is absent
    // from the total and named separately, never quietly counted as zero.
    totalValueUsd: '4800.00000000',
    suspectValueUsd: '5000.00000000',
  };
}

/** A valid wallet holding nothing any list covers. No total exists, so: null. */
export function emptyWalletPlan(): PortfolioPlan {
  return {
    chains: CHAIN_ORDER.map((identity) => ({
      identity,
      outcome: { portfolio: emptyPortfolio(identity) },
    })),
    totalValueUsd: null,
    suspectValueUsd: null,
  };
}

/**
 * Every network answers and Ethereum's prices were cross-checked: ETH agreed,
 * USDC disputed by 40 %.
 *
 * The total is the same $5,400 as `allNetworksPlan`, deliberately. A disputed
 * price is doubt about the number, not about whether the holding is the user's,
 * so it stays in the total and is flagged — unlike a spoofed asset, which leaves
 * it. The other four networks carry no check, which is what makes this fixture
 * also cover "unchecked is not claimed as agreed".
 */
export function crossCheckedPlan(): PortfolioPlan {
  return {
    chains: [
      { identity: CHAINS.ethereum, outcome: { portfolio: crossCheckedEthereumPortfolio() } },
      { identity: CHAINS.base, outcome: { portfolio: basePortfolio() } },
      { identity: CHAINS.arbitrum, outcome: { portfolio: arbitrumPortfolio() } },
      { identity: CHAINS.optimism, outcome: { portfolio: optimismPortfolio() } },
      { identity: CHAINS.bsc, outcome: { portfolio: bscPortfolio() } },
    ],
    totalValueUsd: '5400.00000000',
    suspectValueUsd: '5000.00000000',
  };
}

/**
 * A portfolio the insights panel and the change column can both speak about.
 *
 * Uses the real mainnet WBTC and USDC addresses so the classification registry
 * resolves them — the panel classifies by address on purpose, and a fixture with
 * invented addresses would prove nothing about that.
 *
 * $4,000 of ether, $4,000 of bitcoin, $2,000 of dollars: a shape whose exposure
 * split is checkable by eye.
 */
export function insightfulPlan(): PortfolioPlan {
  const chain = CHAINS.ethereum;

  return {
    chains: [
      {
        identity: chain,
        outcome: {
          portfolio: checkedPortfolio({
            address: E2E_ADDRESS,
            chainId: chain.chainId,
            chainName: chain.chainName,
            protocolAccounts: [],
            stakedPositions: [],
            stakedStatus: 'unavailable',
            totalValueUsd: '10000.00000000',
            netOfAaveDebtUsd: null,
            assetCount: 3,
            pricedAssetCount: 3,
            unpricedAssetCount: 0,
            suspectAssetCount: 0,
            suspectValueUsd: null,
            checkedAssetCount: 0,
            disputedAssetCount: 0,
            coverage: 'token-list',
            balanceSource: 'rpc-token-list',
            priceSource: 'defillama',
            assets: [
              asset({
                chainId: chain.chainId,
                contractAddress: null,
                name: 'Ether',
                symbol: 'ETH',
                decimals: 18,
                quantity: '2',
                rawQuantity: '2000000000000000000',
                priceUsd: '2000',
                valueUsd: '4000.00000000',
                portfolioSharePct: '40.0000',
                priceChange24h: rose('5.0000', '1904.7619'),
                priceChange7d: rose('-10.0000', '2222.2222'),
              }),
              asset({
                chainId: chain.chainId,
                contractAddress: WBTC,
                name: 'Wrapped BTC',
                symbol: 'WBTC',
                decimals: 8,
                quantity: '0.1',
                rawQuantity: '10000000',
                priceUsd: '40000',
                valueUsd: '4000.00000000',
                portfolioSharePct: '40.0000',
                // A real change too small for two decimals: must read "<0.01%",
                // never "0.00%", which would assert the opposite.
                priceChange24h: rose('0.0040', '39998.4'),
                priceChange7d: { status: 'no-quote', pct: null, thenUsd: null, asOf: null },
              }),
              asset({
                chainId: chain.chainId,
                contractAddress: USDC,
                name: 'USD Coin',
                symbol: 'USDC',
                decimals: 6,
                quantity: '2000',
                rawQuantity: '2000000000',
                priceUsd: '1',
                valueUsd: '2000.00000000',
                portfolioSharePct: '20.0000',
                priceChange24h: rose('0.0000', '1'),
                priceChange7d: rose('0.0000', '1'),
              }),
            ],
            fxRate: FX_RATE,
            fetchedAt: FETCHED_AT,
            warnings: [coverageWarning(chain)],
          }),
        },
      },
      ...CHAIN_ORDER.slice(1).map((identity) => ({
        identity,
        outcome: { portfolio: emptyPortfolio(identity) } as ChainOutcome,
      })),
    ],
    totalValueUsd: '10000.00000000',
    suspectValueUsd: null,
  };
}

/**
 * The prices were checked and the second source had no opinion on either.
 *
 * The case a reviewer caught before it shipped: with no disputes, a summary that
 * says "and agreed" would report a confirmation that never happened. `unverified`
 * means asked-and-no-answer, which is not agreement.
 */
export function unconfirmedPricesPlan(): PortfolioPlan {
  const chain = CHAINS.ethereum;
  const unverified = {
    status: 'unverified' as const,
    source: 'coingecko',
    priceUsd: null,
    deltaPct: null,
  };

  return {
    chains: [
      {
        identity: chain,
        outcome: {
          portfolio: checkedPortfolio({
            address: E2E_ADDRESS,
            chainId: chain.chainId,
            chainName: chain.chainName,
            protocolAccounts: [],
            stakedPositions: [],
            stakedStatus: 'unavailable',
            totalValueUsd: '4000.00000000',
            netOfAaveDebtUsd: null,
            assetCount: 2,
            pricedAssetCount: 2,
            unpricedAssetCount: 0,
            suspectAssetCount: 0,
            suspectValueUsd: null,
            checkedAssetCount: 2,
            disputedAssetCount: 0,
            coverage: 'token-list',
            balanceSource: 'rpc-token-list',
            priceSource: 'defillama',
            assets: [
              asset({
                chainId: chain.chainId,
                contractAddress: null,
                name: 'Ether',
                symbol: 'ETH',
                decimals: 18,
                quantity: '1.5',
                rawQuantity: '1500000000000000000',
                priceUsd: '2000',
                valueUsd: '3000.00000000',
                portfolioSharePct: '75.0000',
                priceCheck: unverified,
              }),
              asset({
                chainId: chain.chainId,
                contractAddress: USDC,
                name: 'USD Coin',
                symbol: 'USDC',
                decimals: 6,
                quantity: '1000',
                rawQuantity: '1000000000',
                priceUsd: '1',
                valueUsd: '1000.00000000',
                portfolioSharePct: '25.0000',
                priceCheck: unverified,
              }),
            ],
            fxRate: null,
            fetchedAt: FETCHED_AT,
            warnings: [coverageWarning(chain)],
          }),
        },
      },
      ...CHAIN_ORDER.slice(1).map((identity) => ({
        identity,
        outcome: { portfolio: emptyPortfolio(identity) } as ChainOutcome,
      })),
    ],
    totalValueUsd: '4000.00000000',
    suspectValueUsd: null,
  };
}

/**
 * Every network is empty except one that cannot be read at all.
 *
 * The combination matters: "nothing found anywhere" is a claim about networks
 * that answered, and a network Nuxfolio never reached must not be folded into it.
 */
export function emptyWithOneNetworkFailingPlan(): PortfolioPlan {
  return {
    chains: CHAIN_ORDER.map((identity, index) => ({
      identity,
      outcome:
        index === CHAIN_ORDER.length - 1
          ? {
              failure: {
                status: 503,
                code: 'upstream-unavailable' as const,
                message: 'The data provider is unavailable right now.',
              },
            }
          : { portfolio: emptyPortfolio(identity) },
    })),
    totalValueUsd: null,
    suspectValueUsd: null,
  };
}

/**
 * One wallet's five-network aggregate, for a bundle member.
 *
 * Written out rather than derived, like every other figure here: a fixture that
 * computes its totals with the application's own helpers can agree with a bug in them.
 */
export function bundleMemberAggregate(input: {
  address: string;
  totalValueUsd: string;
  symbol: string;
  quantity: string;
  priceUsd: string;
}): AggregatePortfolio {
  const chain = CHAINS.ethereum;
  const portfolio = checkedPortfolio({
    address: input.address,
    chainId: chain.chainId,
    chainName: chain.chainName,
    protocolAccounts: [],
    stakedPositions: [],
    stakedStatus: 'unavailable',
    totalValueUsd: input.totalValueUsd,
    netOfAaveDebtUsd: null,
    assetCount: 1,
    pricedAssetCount: 1,
    unpricedAssetCount: 0,
    suspectAssetCount: 0,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    coverage: 'token-list',
    balanceSource: 'rpc-token-list',
    priceSource: 'defillama',
    assets: [
      asset({
        chainId: chain.chainId,
        contractAddress: USDC,
        name: 'USD Coin',
        symbol: input.symbol,
        decimals: 6,
        quantity: input.quantity,
        rawQuantity: '1000000',
        priceUsd: input.priceUsd,
        valueUsd: input.totalValueUsd,
        portfolioSharePct: '100.0000',
      }),
    ],
    fxRate: null,
    fetchedAt: FETCHED_AT,
    warnings: [coverageWarning(chain)],
  });

  return checkedAggregate({
    address: input.address,
    totalValueUsd: input.totalValueUsd,
    netOfAaveDebtUsd: null,
    assetCount: 1,
    pricedAssetCount: 1,
    unpricedAssetCount: 0,
    suspectAssetCount: 0,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    chains: [portfolio],
    failedChains: [],
    fxRate: null,
    fetchedAt: FETCHED_AT,
  });
}

/** Controls a live interception for the rest of the test. */
export type PortfolioApiMock = {
  /**
   * Stops answering with `failWith`, so the next request is served from the plan.
   * A latch rather than a request count on purpose: React's development
   * double-mount makes the number of requests behind one page load an
   * implementation detail, and a test that counted them would be testing that.
   */
  readonly stopFailing: () => void;
  /** How many `/api/portfolio` requests the browser has made so far. */
  readonly requestCount: () => number;
  /** Every `chainId` value the page requested, in arrival order. */
  readonly requestedChainIds: () => readonly string[];
  /**
   * Every URL the browser asked for, of any kind.
   *
   * Not just `/api/portfolio`: the saved-wallets panel must not leak an address
   * through a prefetched route either, and a check that only counted API calls
   * would miss exactly that.
   */
  readonly requestedUrls: () => readonly string[];
  /**
   * Forgets every request recorded so far.
   *
   * Needed because a test that asserts "loading this page leaks nothing" has
   * usually navigated somewhere deliberately first, and those requests are not the
   * ones under test.
   */
  readonly clearRequestLog: () => void;
  /**
   * Registers an extra wallet so a bundle can be assembled from several.
   *
   * `'fail'` makes that member unavailable, which is the state a bundle most needs to
   * get right: its subtotal must be absent from the total and the wallet named, never
   * counted as zero.
   */
  readonly addBundleMember: (address: string, value: AggregatePortfolio | 'fail') => void;
};

/**
 * Intercepts every `/api/portfolio` request the browser makes and answers it
 * from `plan`.
 *
 * Both request shapes are served on purpose. Today the aggregate view asks once
 * with `?chainId=all`; item M2-3 changes it to one request per chain
 * (`?chainId=1`, `?chainId=8453`, …). Answering either means this suite keeps
 * testing the UI across that change instead of failing on the request shape.
 */
export async function mockPortfolioApi(
  page: Page,
  basePlan: PortfolioPlan,
  options: {
    /** Fail every request with this until {@link PortfolioApiMock.stopFailing}. */
    readonly failWith?: ApiFailure;
  } = {},
): Promise<PortfolioApiMock> {
  // A registered chain the plan does not speak about answers empty rather than
  // failing: the registry grew to eight chains (2026-08-12) and most scenarios
  // are written against the original five, whose asserted totals an empty chain
  // cannot disturb. A chain outside the registry still fails loudly below —
  // that tripwire is about the app inventing a chain, not the registry growing.
  const planned = new Set(basePlan.chains.map((entry) => entry.identity.chainId));
  const plan: PortfolioPlan = {
    ...basePlan,
    chains: [
      ...basePlan.chains,
      ...CHAIN_ORDER.filter((identity) => !planned.has(identity.chainId)).map((identity) => ({
        identity,
        outcome: { portfolio: emptyPortfolio(identity) } as ChainOutcome,
      })),
    ],
  };

  let failure = options.failWith ?? null;
  let requestCount = 0;
  /** Extra addresses a bundle test registered, each answering or failing. */
  const bundleMembers = new Map<string, AggregatePortfolio | 'fail'>();
  /** Every `chainId` the page asked for, so a test can assert the fan-out shape. */
  const requestedChainIds: string[] = [];
  const requestedUrls: string[] = [];

  // Every `/api/` path, not just `/api/portfolio`: an endpoint added later must
  // not be able to slip past this and reach a live provider from the dev server.
  // A regex rather than a glob, because `?` is significant in a query string and
  // glob syntax reads it as a wildcard.
  // Every request the page makes, before any narrower handler. `route` handlers
  // are consulted most-recent-first, so this one is registered first and simply
  // records then continues.
  await page.route('**/*', async (route) => {
    requestedUrls.push(route.request().url());
    await route.fallback();
  });

  await page.route(/\/api\//, async (route) => {
    const url = new URL(route.request().url());

    // Origin is checked here as well as in the external-host guard: relying on
    // route precedence alone would make this suite pass if portfolio traffic
    // were ever aimed at a third-party host.
    if (url.origin !== BASE_ORIGIN) {
      await route.abort('blockedbyclient');
      return;
    }

    if (!url.pathname.startsWith('/api/portfolio')) {
      // Loud on purpose: an unmocked endpoint means this suite no longer covers
      // what the app actually calls.
      await fulfillFailure(route, {
        status: 501,
        code: 'internal',
        message: `No fixture for ${url.pathname}; add one to e2e/fixtures.ts.`,
      });
      return;
    }

    // The suite only ever looks up the planned wallet, or a bundle member the test
    // registered. Answering for any address would hide a regression that sends the
    // wrong one.
    const requestedAddress = url.searchParams.get('address') ?? '';
    const bundleMember = bundleMembers.get(requestedAddress.toLowerCase());
    if (bundleMember !== undefined) {
      if (bundleMember === 'fail') {
        await fulfillFailure(route, CHAIN_UNAVAILABLE);
      } else {
        requestCount += 1;
        await fulfillJson(route, 200, { aggregate: bundleMember, cached: false });
      }
      return;
    }
    if (requestedAddress.toLowerCase() !== E2E_ADDRESS.toLowerCase()) {
      await fulfillFailure(route, {
        status: 400,
        code: 'invalid-address',
        message: `No fixture for ${requestedAddress}; the plan covers ${E2E_ADDRESS}.`,
      });
      return;
    }

    requestCount += 1;

    if (failure !== null) {
      await fulfillFailure(route, failure);
      return;
    }

    const requested = url.searchParams.get('chainId') ?? String(DEFAULT_CHAIN_ID);
    requestedChainIds.push(requested);

    if (requested === ALL_CHAINS) {
      await fulfillJson(route, 200, { aggregate: buildAggregate(plan), cached: false });
      return;
    }

    const chain = plan.chains.find((entry) => String(entry.identity.chainId) === requested);
    if (chain === undefined) {
      // The plan covers every registered chain, so this means the app asked for
      // one that does not exist — worth failing on rather than papering over.
      await fulfillFailure(route, {
        status: 400,
        code: 'unsupported-chain',
        message: `No fixture for chain ${requested}.`,
      });
      return;
    }

    if ('failure' in chain.outcome) {
      await fulfillFailure(route, chain.outcome.failure);
      return;
    }

    await fulfillJson(route, 200, { portfolio: chain.outcome.portfolio, cached: false });
  });

  // Registered after the API route on purpose: Playwright gives the most
  // recently registered handler precedence, so the guard has to come last to be
  // the outermost net rather than a handler the API route shadows.
  await blockExternalHosts(page);

  return {
    stopFailing: () => {
      failure = null;
    },
    requestCount: () => requestCount,
    requestedChainIds: () => [...requestedChainIds],
    requestedUrls: () => [...requestedUrls],
    clearRequestLog: () => {
      requestedUrls.length = 0;
    },
    addBundleMember: (address, value) => {
      bundleMembers.set(address.toLowerCase(), value);
    },
  };
}

/** The dev server this suite talks to; anything else is a defect. */
// Imported from the config rather than re-derived: the suite once carried the
// port in two places, the config moved and this one did not, and every request
// was aborted as cross-origin (2026-08-12).
const BASE_ORIGIN = `http://localhost:${E2E_PORT}`;

/**
 * Anything the browser sends to a host other than the dev server is a defect in
 * this suite: no provider belongs in the loop. Aborting makes such a leak fail
 * visibly instead of quietly reaching the internet from CI.
 */
async function blockExternalHosts(page: Page): Promise<void> {
  await page.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|localhost[:/])/, (route) => route.abort());
}

async function fulfillJson(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Mirrors the API's error envelope: a machine code plus a sentence to render. */
async function fulfillFailure(route: Route, failure: ApiFailure): Promise<void> {
  await fulfillJson(route, failure.status, {
    error: { code: failure.code, message: failure.message },
  });
}

function buildAggregate(plan: PortfolioPlan): AggregatePortfolio {
  const answered = plan.chains.flatMap((chain) =>
    'failure' in chain.outcome ? [] : [chain.outcome.portfolio],
  );
  const failed = plan.chains.flatMap((chain) =>
    'failure' in chain.outcome
      ? [
          {
            chainId: chain.identity.chainId,
            chainName: chain.identity.chainName,
            message: chain.outcome.failure.message,
          },
        ]
      : [],
  );

  return checkedAggregate({
    address: E2E_ADDRESS,
    totalValueUsd: plan.totalValueUsd,
    netOfAaveDebtUsd: null,
    assetCount: sum(answered.map((portfolio) => portfolio.assetCount)),
    pricedAssetCount: sum(answered.map((portfolio) => portfolio.pricedAssetCount)),
    unpricedAssetCount: sum(answered.map((portfolio) => portfolio.unpricedAssetCount)),
    suspectAssetCount: sum(answered.map((portfolio) => portfolio.suspectAssetCount)),
    suspectValueUsd: plan.suspectValueUsd,
    // Summed like the other counts, and only over networks that answered: a
    // network Nuxfolio never read has no checks to contribute either way.
    checkedAssetCount: sum(answered.map((portfolio) => portfolio.checkedAssetCount)),
    disputedAssetCount: sum(answered.map((portfolio) => portfolio.disputedAssetCount)),
    chains: answered,
    failedChains: failed,
    fxRate: null,
    fetchedAt: FETCHED_AT,
  });
}

/**
 * Ethereum: 1.5 ETH at $2,000 plus 1,000 USDC at $1 — a $4,000 subtotal — and a
 * third row that wears USDC's symbol on an address no list carries. That row is
 * priced at $5,000 and excluded from every total, which is the whole point of it:
 * a spam airdrop must not be able to inflate what the wallet is said to hold.
 */
function ethereumPortfolio(): Portfolio {
  const chain = CHAINS.ethereum;

  return checkedPortfolio({
    address: E2E_ADDRESS,
    chainId: chain.chainId,
    chainName: chain.chainName,
    protocolAccounts: [],
    stakedPositions: [],
    stakedStatus: 'unavailable',
    totalValueUsd: '4000.00000000',
    netOfAaveDebtUsd: null,
    assetCount: 3,
    pricedAssetCount: 3,
    unpricedAssetCount: 0,
    suspectAssetCount: 1,
    suspectValueUsd: '5000.00000000',
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    coverage: 'token-list',
    balanceSource: 'rpc-token-list',
    priceSource: 'defillama',
    assets: [
      asset({
        chainId: chain.chainId,
        contractAddress: null,
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
        quantity: '1.5',
        rawQuantity: '1500000000000000000',
        priceUsd: '2000',
        valueUsd: '3000.00000000',
        portfolioSharePct: '75.0000',
      }),
      asset({
        chainId: chain.chainId,
        contractAddress: USDC,
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        quantity: '1000',
        rawQuantity: '1000000000',
        priceUsd: '1',
        valueUsd: '1000.00000000',
        portfolioSharePct: '25.0000',
      }),
      asset({
        chainId: chain.chainId,
        contractAddress: FAKE_USDC,
        // Same name and symbol as the real token: that is what makes it a spoof.
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        quantity: '5000',
        rawQuantity: '5000000000',
        priceUsd: '1',
        valueUsd: '5000.00000000',
        // No share: it is outside the subtotal a share would be a share of.
        portfolioSharePct: null,
        suspectReason: 'symbol-spoof',
      }),
    ],
    fxRate: null,
    fetchedAt: FETCHED_AT,
    warnings: [
      coverageWarning(chain),
      {
        code: 'assets.suspect',
        message:
          '1 asset looks like spam (with a copied symbol) and is excluded from the total. ' +
          'Review it below.',
      },
    ],
  });
}

/**
 * The same Ethereum holdings, with a second source consulted on both priced rows.
 *
 * Written out rather than derived from `ethereumPortfolio` so the two fixtures
 * cannot drift into agreement with a bug: the subtotal here is still $4,000, and
 * that identity is the assertion.
 */
function crossCheckedEthereumPortfolio(): Portfolio {
  const chain = CHAINS.ethereum;

  return checkedPortfolio({
    address: E2E_ADDRESS,
    chainId: chain.chainId,
    chainName: chain.chainName,
    protocolAccounts: [],
    stakedPositions: [],
    stakedStatus: 'unavailable',
    // Unchanged by the dispute: the primary price still sets the total.
    totalValueUsd: '4000.00000000',
    netOfAaveDebtUsd: null,
    assetCount: 3,
    pricedAssetCount: 3,
    unpricedAssetCount: 0,
    suspectAssetCount: 1,
    suspectValueUsd: '5000.00000000',
    // The spoofed row is never asked about — it is not in the total, so a second
    // opinion on its price would buy nothing and cost quota.
    checkedAssetCount: 2,
    disputedAssetCount: 1,
    coverage: 'token-list',
    balanceSource: 'rpc-token-list',
    priceSource: 'defillama',
    assets: [
      asset({
        chainId: chain.chainId,
        contractAddress: null,
        name: 'Ether',
        symbol: 'ETH',
        decimals: 18,
        quantity: '1.5',
        rawQuantity: '1500000000000000000',
        priceUsd: '2000',
        valueUsd: '3000.00000000',
        portfolioSharePct: '75.0000',
        // 2,010 against 2,000 is 0.5 %, inside the 2 % tolerance.
        priceCheck: {
          status: 'agreed',
          source: 'coingecko',
          priceUsd: '2010',
          deltaPct: '0.5000',
        },
      }),
      asset({
        chainId: chain.chainId,
        contractAddress: USDC,
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        quantity: '1000',
        rawQuantity: '1000000000',
        priceUsd: '1',
        valueUsd: '1000.00000000',
        portfolioSharePct: '25.0000',
        // A dollar against $1.40 on a stablecoin: exactly the kind of wrong quote
        // a single source cannot detect.
        priceCheck: {
          status: 'disputed',
          source: 'coingecko',
          priceUsd: '1.40',
          deltaPct: '40.0000',
        },
      }),
      asset({
        chainId: chain.chainId,
        contractAddress: FAKE_USDC,
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 6,
        quantity: '5000',
        rawQuantity: '5000000000',
        priceUsd: '1',
        valueUsd: '5000.00000000',
        portfolioSharePct: null,
        suspectReason: 'symbol-spoof',
      }),
    ],
    fxRate: null,
    fetchedAt: FETCHED_AT,
    warnings: [
      coverageWarning(chain),
      {
        code: 'assets.suspect',
        message:
          '1 asset looks like spam (with a copied symbol) and is excluded from the total. ' +
          'Review it below.',
      },
      {
        code: 'prices.disputed',
        message:
          '1 price could not be confirmed by a second source and is still counted in the ' +
          'total. The widest gap is USDC, where the two sources differ by 40.0 %.',
      },
    ],
  });
}

function basePortfolio(): Portfolio {
  return nativeOnlyPortfolio(CHAINS.base, {
    symbol: 'ETH',
    name: 'Ether',
    quantity: '0.25',
    rawQuantity: '250000000000000000',
    priceUsd: '2000',
    valueUsd: '500.00000000',
  });
}

function arbitrumPortfolio(): Portfolio {
  return nativeOnlyPortfolio(CHAINS.arbitrum, {
    symbol: 'ETH',
    name: 'Ether',
    quantity: '0.1',
    rawQuantity: '100000000000000000',
    priceUsd: '2000',
    valueUsd: '200.00000000',
  });
}

function optimismPortfolio(): Portfolio {
  return nativeOnlyPortfolio(CHAINS.optimism, {
    symbol: 'ETH',
    name: 'Ether',
    quantity: '0.05',
    rawQuantity: '50000000000000000',
    priceUsd: '2000',
    valueUsd: '100.00000000',
  });
}

function bscPortfolio(): Portfolio {
  return nativeOnlyPortfolio(CHAINS.bsc, {
    symbol: 'BNB',
    name: 'BNB',
    quantity: '2',
    rawQuantity: '2000000000000000000',
    priceUsd: '300',
    valueUsd: '600.00000000',
  });
}

/** One native holding, which is the whole of that chain's subtotal: 100 %. */
function nativeOnlyPortfolio(
  chain: ChainIdentity,
  native: {
    readonly symbol: string;
    readonly name: string;
    readonly quantity: string;
    readonly rawQuantity: string;
    readonly priceUsd: string;
    readonly valueUsd: string;
  },
): Portfolio {
  return checkedPortfolio({
    address: E2E_ADDRESS,
    chainId: chain.chainId,
    chainName: chain.chainName,
    protocolAccounts: [],
    stakedPositions: [],
    stakedStatus: 'unavailable',
    totalValueUsd: native.valueUsd,
    netOfAaveDebtUsd: null,
    assetCount: 1,
    pricedAssetCount: 1,
    unpricedAssetCount: 0,
    suspectAssetCount: 0,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    coverage: 'token-list',
    balanceSource: 'rpc-token-list',
    priceSource: 'defillama',
    assets: [
      asset({
        chainId: chain.chainId,
        contractAddress: null,
        name: native.name,
        symbol: native.symbol,
        decimals: 18,
        quantity: native.quantity,
        rawQuantity: native.rawQuantity,
        priceUsd: native.priceUsd,
        valueUsd: native.valueUsd,
        portfolioSharePct: '100.0000',
      }),
    ],
    fxRate: null,
    fetchedAt: FETCHED_AT,
    warnings: [coverageWarning(chain)],
  });
}

/**
 * Nothing found. The total is null rather than 0: zero would be a claim that the
 * wallet is worthless, which is not what "we saw nothing" means.
 */
function emptyPortfolio(chain: ChainIdentity): Portfolio {
  return checkedPortfolio({
    address: E2E_ADDRESS,
    chainId: chain.chainId,
    chainName: chain.chainName,
    protocolAccounts: [],
    stakedPositions: [],
    stakedStatus: 'unavailable',
    totalValueUsd: null,
    netOfAaveDebtUsd: null,
    assetCount: 0,
    pricedAssetCount: 0,
    unpricedAssetCount: 0,
    suspectAssetCount: 0,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    coverage: 'token-list',
    balanceSource: 'rpc-token-list',
    priceSource: null,
    assets: [],
    fxRate: null,
    fetchedAt: FETCHED_AT,
    warnings: [coverageWarning(chain)],
  });
}

/** Reproduces the keyless provider's coverage sentence, list size and all. */
function coverageWarning(chain: ChainIdentity): PortfolioWarning {
  return {
    code: 'coverage.token-list',
    message:
      `Without an indexer API key, Nuxfolio checks a fixed list of ` +
      `${chain.listSize.toLocaleString('en-US')} ${chain.shortName} tokens (CoinGecko). ` +
      `Tokens outside that list are not shown.`,
  };
}

function asset(input: {
  readonly chainId: number;
  readonly contractAddress: string | null;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly quantity: string;
  readonly rawQuantity: string;
  readonly priceUsd: string;
  readonly valueUsd: string;
  readonly portfolioSharePct: string | null;
  readonly suspectReason?: PortfolioAsset['suspectReason'];
  /** Absent means the asset was never cross-checked, which is not agreement. */
  readonly priceCheck?: PortfolioAsset['priceCheck'];
  /** Absent means no historical lookup was in scope for this asset at all. */
  readonly priceChange24h?: PortfolioAsset['priceChange24h'];
  readonly priceChange7d?: PortfolioAsset['priceChange7d'];
}): PortfolioAsset {
  const suspectReason = input.suspectReason ?? null;

  return {
    assetId: `${input.chainId}:${input.contractAddress ?? 'native'}`,
    chainId: input.chainId,
    contractAddress: input.contractAddress,
    name: input.name,
    symbol: input.symbol,
    decimals: input.decimals,
    quantity: input.quantity,
    rawQuantity: input.rawQuantity,
    priceUsd: input.priceUsd,
    valueUsd: input.valueUsd,
    portfolioSharePct: input.portfolioSharePct,
    // Logos are never rendered (ADR-009), so a fixture that carried one would be
    // describing something the UI does not do.
    logoUrl: null,
    priceSource: 'defillama',
    priceUpdatedAt: FETCHED_AT,
    priceQuality: 'ok',
    priceCheck: input.priceCheck ?? null,
    priceChange24h: input.priceChange24h ?? null,
    priceChange7d: input.priceChange7d ?? null,
    suspect: suspectReason !== null,
    suspectReason,
  };
}

/**
 * Validates a fixture against the schema the browser client uses, so drift is
 * reported here — with a zod error naming the field — rather than as a UI that
 * inexplicably shows an internal error. The parameter types are the domain ones,
 * which is what makes a missing field a `pnpm typecheck` failure as well.
 */
function checkedPortfolio(portfolio: Portfolio): Portfolio {
  portfolioSchema.parse(portfolio);
  return portfolio;
}

function checkedAggregate(aggregate: AggregatePortfolio): AggregatePortfolio {
  aggregatePortfolioSchema.parse(aggregate);
  return aggregate;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
