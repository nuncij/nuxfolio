import 'server-only';

import { getChainConfig, listChains, type ChainConfig } from '@/config/chains';
import { getSecretValues, getServerEnv, type ServerEnv } from '@/config/env';
import type { WalletAddress } from '@/domain/address';
import { chainFailureKindFromProviderError, chainFailureMessage } from '@/domain/chainFailure';
import { marketsForChain } from '@/config/aaveMarkets';
import { buildAggregatePortfolio, buildPortfolio } from '@/domain/normalize';
import { readAaveAccounts } from '@/providers/protocols/aaveV3';
import type {
  AggregatePortfolio,
  Portfolio,
  PortfolioAsset,
  PortfolioWarning,
  PriceCheck,
  PriceChange,
  FxQuote,
} from '@/domain/portfolio';
import { compareDecimal } from '@/domain/money';
import { comparePrices, selectAssetsToCrossCheck } from '@/domain/priceCheck';
import {
  computePriceChange,
  isUsableCurrentQuote,
  notRequested,
  PERIOD_SECONDS,
  type ChangePeriod,
} from '@/domain/priceHistory';
import {
  selectBalanceProvider,
  selectPriceProvider,
  selectPriceVerifier,
  selectRateProvider,
} from '@/providers/registry';
import {
  isProviderError,
  priceRefKey,
  ProviderError,
  type AttemptedLookup,
  type PortfolioProvider,
  type PriceProvider,
  type PriceQuote,
  type PriceVerifier,
  type PriceRef,
  type ProviderContext,
  type RateProvider,
} from '@/providers/types';

import { TtlCache } from './cache';
import { mapWithConcurrency } from './concurrency';
import { Deadline } from './deadline';
import { createLogger, describeError, type Logger } from './logger';

/**
 * Portfolio orchestration.
 *
 * The asymmetry between the two providers is deliberate:
 *  - balances are load-bearing. Without them there is nothing to show, so a
 *    balance failure surfaces as an error;
 *  - prices are enrichment. A price outage degrades the page to quantities plus
 *    a warning, because a wallet's holdings are still worth reading when the
 *    market data is not available.
 */

export type PortfolioRequest = {
  address: WalletAddress;
  chainId: number;
};

export type PortfolioResult = {
  portfolio: Portfolio;
  cached: boolean;
};

export class UnsupportedChainError extends Error {
  constructor(chainId: number) {
    super(`Chain ${chainId} is not supported`);
    this.name = 'UnsupportedChainError';
  }
}

let cache: TtlCache<Portfolio> | undefined;
let defaultLogger: Logger | undefined;

function getCache(env: ServerEnv): TtlCache<Portfolio> {
  cache ??= new TtlCache<Portfolio>({
    ttlMs: env.PORTFOLIO_CACHE_TTL_SECONDS * 1000,
    maxEntries: env.PORTFOLIO_CACHE_MAX_ENTRIES,
  });
  return cache;
}

export function getLogger(env: ServerEnv = getServerEnv()): Logger {
  defaultLogger ??= createLogger({ level: env.LOG_LEVEL, secrets: getSecretValues(env) });
  return defaultLogger;
}

/** Visible for tests: drops cached portfolios and the memoised logger. */
export function resetPortfolioServiceState(): void {
  cache?.clear();
  cache = undefined;
  defaultLogger = undefined;
}

export type PortfolioServiceDependencies = {
  env?: ServerEnv;
  logger?: Logger;
  balanceProvider?: PortfolioProvider;
  priceProvider?: PriceProvider;
  /** Null disables cross-checking explicitly; undefined falls back to the registry. */
  priceVerifier?: PriceVerifier | null;
  /** Null disables the display-rate lookup; undefined falls back to the registry. */
  rateProvider?: RateProvider | null;
  fetchImpl?: typeof globalThis.fetch;
  chain?: ChainConfig;
  /** Overrides the registry for aggregate loads; used by tests. */
  chains?: readonly ChainConfig[];
  now?: () => Date;
};

export async function getPortfolio(
  request: PortfolioRequest,
  dependencies: PortfolioServiceDependencies = {},
): Promise<PortfolioResult> {
  const env = dependencies.env ?? getServerEnv();
  const chain = dependencies.chain ?? getChainConfig(request.chainId);

  if (!chain) {
    throw new UnsupportedChainError(request.chainId);
  }

  const logger = dependencies.logger ?? getLogger(env);
  const cacheKey = `${chain.chainId}:${request.address.toLowerCase()}`;

  const { value, cached } = await getCache(env).getOrLoad(cacheKey, () =>
    loadPortfolio({ request, chain, env, logger, dependencies }),
  );

  return { portfolio: value, cached };
}

async function loadPortfolio(input: {
  request: PortfolioRequest;
  chain: ChainConfig;
  env: ServerEnv;
  logger: Logger;
  dependencies: PortfolioServiceDependencies;
}): Promise<Portfolio> {
  const { request, chain, env, logger, dependencies } = input;

  const balanceProvider = dependencies.balanceProvider ?? selectBalanceProvider(env);
  const priceProvider = dependencies.priceProvider ?? selectPriceProvider(env);
  const now = dependencies.now ?? (() => new Date());

  const context: ProviderContext = {
    deadline: new Deadline(env.REQUEST_DEADLINE_MS),
    fetch: dependencies.fetchImpl ?? globalThis.fetch,
    logger,
    maxAssets: env.MAX_ASSETS_PER_PORTFOLIO,
    tokenListMaxAgeDays: env.TOKEN_LIST_MAX_AGE_DAYS,
  };

  if (!balanceProvider.supportsChain(chain.chainId)) {
    throw new UnsupportedChainError(chain.chainId);
  }

  const startedAt = Date.now();
  const snapshot = await balanceProvider.fetchBalances({
    address: request.address,
    chain,
    context,
  });

  const refs: PriceRef[] = snapshot.balances.map((balance) => ({
    chainId: balance.chainId,
    contractAddress: balance.contractAddress,
  }));

  const warnings: PortfolioWarning[] = [...snapshot.warnings];
  let quotes: ReadonlyMap<string, PriceQuote> = new Map();
  let priceSource: string | null = null;

  try {
    const lookup = await priceProvider.fetchPrices({ chain, refs, context });
    quotes = lookup.quotes;
    priceSource = lookup.providerId;
    warnings.push(...lookup.warnings);
  } catch (error) {
    // Prices are enrichment, not a prerequisite: degrade instead of failing.
    logger.warn('portfolio.prices_unavailable', {
      chainId: chain.chainId,
      providerId: priceProvider.id,
      ...describeError(error),
    });
    warnings.push({
      code: 'prices.unavailable',
      message:
        'Price data could not be loaded, so quantities are shown without values. Try again shortly.',
    });
  }

  // Lending accounts, read alongside prices rather than after them: the two are
  // independent, and a wallet with debt should not wait for a price batch to learn
  // it. `readAaveAccounts` never throws — a market that fails comes back as a
  // `failed` account, because "we could not ask" and "there is no debt" must not
  // arrive as the same answer.
  const markets = marketsForChain(chain.chainId);
  const protocolAccounts = await readAaveAccounts({
    address: request.address,
    markets,
    rpcUrls: chain.rpcUrls,
    dependencies: { context },
  });

  if (protocolAccounts.some((account) => account.status === 'failed')) {
    const failed = protocolAccounts.filter((account) => account.status === 'failed').length;
    warnings.push({
      code: 'protocols.unavailable',
      message:
        `${failed} of ${markets.length} lending ${markets.length === 1 ? 'market' : 'markets'} on ` +
        `${chain.shortName} could not be read, so any borrowing there is not shown.`,
    });
  }

  const portfolioInput = {
    address: request.address,
    chain: {
      chainId: chain.chainId,
      name: chain.name,
      nativeSymbol: chain.nativeAsset.symbol,
    },
    protocolAccounts,
    balances: snapshot.balances,
    // The bundled list is what "listed token" means for spoof detection, so the
    // same data that bounds the keyless scan also whitelists indexer results.
    listedTokens: chain.tokenList.tokens,
    quotes,
    coverage: snapshot.coverage,
    balanceSource: snapshot.providerId,
    priceSource,
    warnings,
    fetchedAt: now().toISOString(),
    priceConfidenceMin: env.PRICE_CONFIDENCE_MIN,
    priceMaxAgeSeconds: env.PRICE_MAX_AGE_SECONDS,
    maxAssets: env.MAX_ASSETS_PER_PORTFOLIO,
  };

  // Built once without cross-checks, purely to decide what is worth checking.
  //
  // The selection has to see the assets the portfolio will actually show — after
  // spam detection and after the per-chain cap. Ranking raw balances instead
  // would let a spoofed token with a fabricated price rank first and spend the
  // whole quota on an asset that is excluded from the total anyway. `buildPortfolio`
  // is pure and does no I/O, so running it twice is cheaper than duplicating the
  // rules it applies — and it cannot disagree with itself.
  const provisional = buildPortfolio(portfolioInput);

  const priceChecks = await crossCheckPrices({
    chain,
    assets: provisional.assets,
    verifier:
      dependencies.priceVerifier === undefined
        ? selectPriceVerifier(env)
        : dependencies.priceVerifier,
    context,
    env,
    logger,
    warnings,
  });

  // Rebuilt unconditionally rather than reusing `provisional` when nothing was
  // checked: `crossCheckPrices` may have appended a warning, and deciding whether
  // it did is more fragile than simply building again.
  const checked = buildPortfolio({ ...portfolioInput, priceChecks });

  // History is selected from the *cross-checked* portfolio, not the provisional
  // one: a disputed price disqualifies an asset from having a change figure at
  // all (ADR-019 prefers neither source, so a precise percentage from one of them
  // would quietly pick a winner), and the dispute verdict only exists after the
  // build above.
  const fxRate = await loadFxRate({
    provider:
      dependencies.rateProvider === undefined ? selectRateProvider(env) : dependencies.rateProvider,
    context,
    logger,
    warnings,
    now: now(),
  });

  const priceChanges = await loadPriceChanges({
    chain,
    assets: checked.assets,
    priceProvider,
    context,
    env,
    logger,
    warnings,
    now: now(),
  });

  // Three builds, always, rather than reusing `checked` when nothing came back:
  // each enrichment step may append a warning, and a build captures the warning
  // list as it stood. Deciding whether to reuse is the fragile part — it is what
  // made an earlier version of this function silently drop a warning. The
  // function is pure and does no I/O, so three passes over at most 400 assets
  // cost nothing next to the network fan-out that produced them.
  const portfolio = buildPortfolio({ ...portfolioInput, priceChecks, priceChanges, fxRate });

  logger.info('portfolio.loaded', {
    chainId: chain.chainId,
    // The logger redacts the address; passing it keeps request correlation
    // possible without recording who was looked up.
    address: request.address,
    balanceProvider: snapshot.providerId,
    priceProvider: priceSource,
    coverage: portfolio.coverage,
    assetCount: portfolio.assetCount,
    unpricedAssetCount: portfolio.unpricedAssetCount,
    suspectAssetCount: portfolio.suspectAssetCount,
    checkedAssetCount: portfolio.checkedAssetCount,
    disputedAssetCount: portfolio.disputedAssetCount,
    durationMs: Date.now() - startedAt,
  });

  return portfolio;
}

/**
 * Asks a second source about the prices that matter, and compares.
 *
 * Enrichment on top of enrichment: every failure degrades to "not cross-checked"
 * with a warning, because a portfolio without a second opinion is still a
 * portfolio. Returns an empty map when there is no verifier at all, which is the
 * default and not a fault.
 *
 * Takes built assets rather than raw balances, so the selection sees exactly what
 * the portfolio will show: spam already flagged, the per-chain cap already
 * applied, values computed once by `buildPortfolio`. Suspect assets are dropped
 * before selection — they are outside the total, so a second opinion on them buys
 * nothing and would spend quota an honest holding needs.
 */
async function crossCheckPrices(input: {
  chain: ChainConfig;
  assets: readonly PortfolioAsset[];
  verifier: PriceVerifier | null;
  context: ProviderContext;
  env: ServerEnv;
  logger: Logger;
  warnings: PortfolioWarning[];
}): Promise<ReadonlyMap<string, PriceCheck>> {
  const checks = new Map<string, PriceCheck>();
  if (input.verifier === null) {
    return checks;
  }

  const selected = selectAssetsToCrossCheck(
    input.assets.filter((asset) => !asset.suspect),
    {
      coverage: input.env.PRICE_CROSSCHECK_COVERAGE,
      maxAssets: input.env.PRICE_CROSSCHECK_MAX_ASSETS,
    },
  )
    // A ref needs a well-formed address, and the wire type is a plain string.
    // Anything that is neither null (native) nor `0x…` cannot be asked about, and
    // is dropped rather than coerced — guessing here would send the wrong ref.
    .flatMap((asset) => {
      const ref = toPriceRef(input.chain.chainId, asset.contractAddress);
      return ref === null ? [] : [{ asset, ref, refKey: priceRefKey(ref) }];
    });
  if (selected.length === 0) {
    return checks;
  }

  try {
    const verification = await input.verifier.verify({
      chain: input.chain,
      refs: selected.map((entry) => entry.ref),
      context: input.context,
    });

    for (const { asset, refKey } of selected) {
      // Only refs the verifier actually asked about get a check. One it never
      // reached — a batch the deadline cut off — stays null, which reads as "not
      // cross-checked" rather than "checked, no opinion". The two are different
      // claims, and the second would overstate both the coverage and the source's
      // involvement.
      if (asset.priceUsd === null || !verification.attemptedRefKeys.has(refKey)) {
        continue;
      }
      checks.set(
        asset.assetId,
        comparePrices({
          primaryUsd: asset.priceUsd,
          secondUsd: verification.quotes.get(refKey)?.priceUsd ?? null,
          source: verification.providerId,
          tolerance: input.env.PRICE_DISPUTE_TOLERANCE,
        }),
      );
    }
    input.warnings.push(...verification.warnings);
  } catch (error) {
    input.logger.warn('prices.crosscheck_unavailable', {
      chainId: input.chain.chainId,
      providerId: input.verifier.id,
      ...describeError(error),
    });
    input.warnings.push({
      code: 'prices.crosscheck_unavailable',
      message:
        'Prices could not be confirmed against a second source this time, so they are shown without a second opinion.',
    });
    return new Map();
  }

  return checks;
}

/**
 * Fetches the 24 h and 7 d prices and turns them into change figures.
 *
 * Enrichment on top of enrichment, like the cross-check: every failure degrades to
 * "no change figure" with a warning, and an empty map means nothing was in scope —
 * which the UI renders as an absent column rather than as zero movement.
 *
 * Scope is deliberately narrow. Only assets that are in the total *and* whose
 * current quote could survive a comparison are asked about: a change figure is
 * going to be suppressed for a stale or disputed price anyway, so requesting it
 * would spend a batch slot to learn nothing.
 */
async function loadPriceChanges(input: {
  chain: ChainConfig;
  assets: readonly PortfolioAsset[];
  priceProvider: PriceProvider;
  context: ProviderContext;
  env: ServerEnv;
  logger: Logger;
  warnings: PortfolioWarning[];
  now: Date;
}): Promise<ReadonlyMap<string, { day: PriceChange; week: PriceChange }>> {
  const changes = new Map<string, { day: PriceChange; week: PriceChange }>();

  const fetchHistorical = input.priceProvider.fetchHistoricalPrices;
  if (fetchHistorical === undefined || input.env.PRICE_HISTORY_MAX_ASSETS < 1) {
    return changes;
  }

  const selected = input.assets
    .filter((asset) => !asset.suspect && isUsableCurrentQuote(asset))
    .sort((a, b) => -compareDecimal(a.valueUsd ?? '0', b.valueUsd ?? '0'))
    .slice(0, input.env.PRICE_HISTORY_MAX_ASSETS)
    .flatMap((asset) => {
      const ref = toPriceRef(input.chain.chainId, asset.contractAddress);
      return ref === null ? [] : [{ asset, ref, refKey: priceRefKey(ref) }];
    });

  if (selected.length === 0) {
    return changes;
  }

  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const targets = {
    day: nowSeconds - PERIOD_SECONDS['24h'],
    week: nowSeconds - PERIOD_SECONDS['7d'],
  };

  const lookups: Record<'day' | 'week', AttemptedLookup | null> = { day: null, week: null };

  // Sequential rather than concurrent: both calls share the one request deadline,
  // and the 7 d figure is the less important of the two, so if time runs out it is
  // the one that should be missing.
  for (const [period, atUnixSeconds] of [
    ['day', targets.day],
    ['week', targets.week],
  ] as const) {
    if (input.context.deadline.hasExpired()) {
      break;
    }
    try {
      lookups[period] = await fetchHistorical.call(input.priceProvider, {
        chain: input.chain,
        refs: selected.map((entry) => entry.ref),
        atUnixSeconds,
        context: input.context,
      });
    } catch (error) {
      input.logger.warn('prices.history_unavailable', {
        chainId: input.chain.chainId,
        providerId: input.priceProvider.id,
        period,
        ...describeError(error),
      });
    }
  }

  if (lookups.day === null && lookups.week === null) {
    input.warnings.push({
      code: 'prices.history_unavailable',
      message:
        'Past prices could not be loaded, so no change figures are shown. The current values are unaffected.',
    });
    return changes;
  }

  for (const { asset, refKey } of selected) {
    changes.set(asset.assetId, {
      day: toChange({ asset, lookup: lookups.day, refKey, at: targets.day, period: '24h' }),
      week: toChange({ asset, lookup: lookups.week, refKey, at: targets.week, period: '7d' }),
    });
  }

  for (const lookup of [lookups.day, lookups.week]) {
    if (lookup !== null) {
      input.warnings.push(...lookup.warnings);
    }
  }

  return changes;
}

/**
 * The display-conversion rate, or null.
 *
 * Shares the request deadline like every other upstream call, so a slow ECB
 * cannot extend a page load. A failure is reported rather than swallowed: the
 * currency toggle disappearing with no explanation would leave a user wondering
 * whether they had misremembered the feature.
 *
 * Aged rather than absent is also worth saying. The ECB publishes on business
 * days, so a few days old is normal and not worth a warning; three weeks old
 * means something has stopped working upstream.
 */
async function loadFxRate(input: {
  provider: RateProvider | null;
  context: ProviderContext;
  logger: Logger;
  warnings: PortfolioWarning[];
  now: Date;
}): Promise<FxQuote | null> {
  if (input.provider === null) {
    return null;
  }

  try {
    const quote = await input.provider.fetchRate({ context: input.context });

    const asOfMs = Date.parse(quote.asOf);
    const ageDays = Number.isNaN(asOfMs)
      ? null
      : Math.floor((input.now.getTime() - asOfMs) / 86_400_000);
    if (ageDays !== null && ageDays > FX_RATE_AGED_DAYS) {
      input.warnings.push({
        code: 'rates.aged',
        message: `The euro conversion rate is from ${quote.asOf}, ${ageDays} days ago. Euro figures are correspondingly approximate.`,
      });
    }

    return quote;
  } catch (error) {
    // A provider is allowed to be unavailable; it is not allowed to throw a
    // TypeError. Swallowing the second turns a bug into a warning that looks like
    // weather — which is how every service test came to be making a real request
    // to the ECB without anyone noticing.
    if (!isProviderError(error)) {
      throw error;
    }
    input.logger.warn('rates.unavailable', {
      providerId: input.provider.id,
      ...describeError(error),
    });
    input.warnings.push({
      code: 'rates.unavailable',
      message:
        'The euro conversion rate could not be loaded, so figures are shown in US dollars only.',
    });
    return null;
  }
}

/**
 * Days past which a reference rate is called out.
 *
 * Well beyond a weekend or a TARGET holiday, so this fires on a real upstream
 * problem rather than on an ordinary Monday.
 */
const FX_RATE_AGED_DAYS = 14;

function toChange(input: {
  asset: PortfolioAsset;
  lookup: AttemptedLookup | null;
  refKey: string;
  at: number;
  period: ChangePeriod;
}): PriceChange {
  // A lookup that never happened, or a ref inside one that was never issued: both
  // are "not requested". Reporting either as "the source had no price" would claim
  // an answer that was never sought — the round-5 lesson, applied before the fact.
  if (input.lookup === null || !input.lookup.attemptedRefKeys.has(input.refKey)) {
    return notRequested();
  }
  const quote = input.lookup.quotes.get(input.refKey);
  return computePriceChange({
    current: input.asset,
    thenUsd: quote?.priceUsd ?? null,
    thenAsOf: quote?.updatedAt ?? null,
    targetUnixSeconds: input.at,
    period: input.period,
  });
}

/**
 * A wire-shaped contract address turned back into a price ref.
 *
 * Null input is the chain's native asset, which is a valid ref. A non-null value
 * that is not `0x…` is not an address this codebase produced, so it yields null:
 * treating it as native would ask about the wrong asset entirely.
 */
function toPriceRef(chainId: number, contractAddress: string | null): PriceRef | null {
  if (contractAddress === null) {
    return { chainId, contractAddress: null };
  }
  return contractAddress.startsWith('0x')
    ? { chainId, contractAddress: contractAddress as WalletAddress }
    : null;
}

export type AggregateResult = {
  aggregate: AggregatePortfolio;
  cached: boolean;
};

/**
 * Loads every registered chain for one address.
 *
 * Chains are independent, so one failing must not cost the user the others: a
 * chain that throws is recorded in `failedChains` with a message safe to render,
 * and the rest of the view is built from what succeeded. The whole request fails
 * only when no chain at all could be read.
 */
export async function getAggregatePortfolio(
  address: WalletAddress,
  dependencies: PortfolioServiceDependencies = {},
): Promise<AggregateResult> {
  const env = dependencies.env ?? getServerEnv();
  const logger = dependencies.logger ?? getLogger(env);
  const chains = dependencies.chains ?? listChains();
  const now = dependencies.now ?? (() => new Date());

  const startedAt = Date.now();

  const results = await mapWithConcurrency(
    chains,
    env.CHAIN_SCAN_CONCURRENCY,
    async (chain): Promise<ChainOutcome> => {
      try {
        const { portfolio, cached } = await getPortfolio(
          { address, chainId: chain.chainId },
          { ...dependencies, env, logger, chain },
        );
        return { kind: 'ok', portfolio, cached };
      } catch (error) {
        logger.warn('portfolio.chain_failed', {
          chainId: chain.chainId,
          ...describeError(error),
        });
        return {
          kind: 'failed',
          chainId: chain.chainId,
          chainName: chain.name,
          message: describeChainFailure(error),
          error,
        };
      }
    },
  );

  const succeeded = results.filter((result) => result.kind === 'ok');
  const failed = results.filter((result) => result.kind === 'failed');

  if (succeeded.length === 0) {
    // Nothing was readable anywhere, so there is no partial view to show.
    throw (
      firstProviderError(results) ??
      new ProviderError('unavailable', 'aggregate', 'No chain could be read')
    );
  }

  const aggregate = buildAggregatePortfolio({
    address,
    chains: succeeded.map((result) => result.portfolio),
    failedChains: failed.map(({ chainId, chainName, message }) => ({
      chainId,
      chainName,
      message,
    })),
    fetchedAt: now().toISOString(),
  });

  logger.info('portfolio.aggregate_loaded', {
    address,
    chainsRequested: chains.length,
    chainsLoaded: succeeded.length,
    chainsFailed: failed.length,
    assetCount: aggregate.assetCount,
    durationMs: Date.now() - startedAt,
  });

  return {
    aggregate,
    // Only "cached" when nothing had to be fetched at all.
    cached: succeeded.every((result) => result.cached),
  };
}

type ChainOutcome =
  | { kind: 'ok'; portfolio: Portfolio; cached: boolean }
  | { kind: 'failed'; chainId: number; chainName: string; message: string; error: unknown };

/**
 * When every chain failed there is no partial view, so the request should fail
 * with a cause the API route can classify — a timeout should surface as a
 * timeout rather than as a generic outage.
 */
function firstProviderError(results: readonly ChainOutcome[]): ProviderError | undefined {
  for (const result of results) {
    if (result.kind === 'failed' && isProviderError(result.error)) {
      return result.error;
    }
  }
  return undefined;
}

/**
 * A sentence safe to render, never an upstream message. The wording is shared
 * with the browser's progressive aggregate, which classifies the same failures
 * from the other side of the wire — see `domain/chainFailure.ts`.
 */
function describeChainFailure(error: unknown): string {
  return chainFailureMessage(
    isProviderError(error) ? chainFailureKindFromProviderError(error.kind) : 'unknown',
  );
}

export { isProviderError };
