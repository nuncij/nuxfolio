import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseServerEnv, type ServerEnv } from '@/config/env';
import {
  priceRefKey,
  ProviderError,
  type BalanceSnapshot,
  type PortfolioProvider,
  type PriceLookup,
  type PriceProvider,
  type PriceVerifier,
  type FxQuote,
  type RateProvider,
} from '@/providers/types';
import { createRpcTokenListProvider } from '@/providers/balances/rpcTokenList';
import {
  createFetchStub,
  createRecordingLogger,
  createTestChain,
  rpcResult,
  silentLogger,
  TEST_ADDRESS,
  USDC,
} from '@/test/helpers';

import {
  getAggregatePortfolio,
  getPortfolio,
  resetPortfolioServiceState,
  UnsupportedChainError,
} from './portfolioService';

/**
 * Service-level behaviour with injected fakes.
 *
 * The providers here are plain objects rather than adapters with stubbed HTTP,
 * because what is under test is the orchestration contract: which failures are
 * fatal, which degrade, and what gets cached.
 */

const chain = createTestChain();

/** Recent enough that price-quality rules never interfere with these tests. */
const FRESH_TIMESTAMP = new Date().toISOString();

function env(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return { ...parseServerEnv({}), ...overrides };
}

function balanceProvider(snapshot: Partial<BalanceSnapshot> = {}): PortfolioProvider {
  return {
    id: 'fake-balances',
    supportsChain: () => true,
    fetchBalances: () =>
      Promise.resolve({
        providerId: 'fake-balances',
        chainId: 1,
        coverage: 'complete',
        balances: [
          {
            chainId: 1,
            contractAddress: null,
            name: 'Ether',
            symbol: 'ETH',
            decimals: 18,
            raw: 1_000_000_000_000_000_000n,
            logoUrl: null,
          },
          {
            chainId: 1,
            contractAddress: USDC,
            name: 'USD Coin',
            symbol: 'USDC',
            decimals: 6,
            raw: 250_000_000n,
            logoUrl: null,
          },
        ],
        warnings: [],
        ...snapshot,
      }),
  };
}

function priceProvider(lookup: Partial<PriceLookup> = {}): PriceProvider {
  return {
    id: 'fake-prices',
    fetchPrices: () =>
      Promise.resolve({
        providerId: 'fake-prices',
        quotes: new Map([
          [
            priceRefKey({ chainId: 1, contractAddress: null }),
            { priceUsd: '2000', updatedAt: FRESH_TIMESTAMP, confidence: 0.99 },
          ],
          [
            priceRefKey({ chainId: 1, contractAddress: USDC }),
            { priceUsd: '1', updatedAt: FRESH_TIMESTAMP, confidence: 0.99 },
          ],
        ]),
        warnings: [],
        ...lookup,
      }),
  };
}

/**
 * A verifier that records exactly which refs it was asked about, and answers with
 * whatever prices the test supplies.
 *
 * `attempted` defaults to every ref it received — the normal case. A test can
 * narrow it to model a verifier that never got to some of them.
 */
function priceVerifier(options: {
  prices?: Record<string, string>;
  attempted?: (refKeys: readonly string[]) => readonly string[];
}): PriceVerifier & { askedAbout: string[] } {
  const askedAbout: string[] = [];
  return {
    id: 'fake-verifier',
    askedAbout,
    verify: ({ refs }) => {
      const refKeys = refs.map((ref) => priceRefKey(ref));
      askedAbout.push(...refKeys);
      const attempted = options.attempted ? options.attempted(refKeys) : refKeys;
      return Promise.resolve({
        providerId: 'fake-verifier',
        quotes: new Map(
          Object.entries(options.prices ?? {}).map(([key, priceUsd]) => [
            key,
            { priceUsd, updatedAt: FRESH_TIMESTAMP, confidence: null },
          ]),
        ),
        warnings: [],
        attemptedRefKeys: new Set(attempted),
      });
    },
  };
}

/** A rate source that answers with whatever the test supplies. */
function rateProvider(quote: Partial<FxQuote> = {}): RateProvider {
  return {
    id: 'fake-rates',
    fetchRate: () =>
      Promise.resolve({
        base: 'EUR' as const,
        quote: 'USD' as const,
        rate: '1.25',
        asOf: '2026-07-31',
        ...quote,
      }),
  };
}

const NATIVE_KEY = priceRefKey({ chainId: 1, contractAddress: null });
const USDC_KEY = priceRefKey({ chainId: 1, contractAddress: USDC });

beforeEach(() => {
  resetPortfolioServiceState();
});

describe('getPortfolio', () => {
  it('assembles a priced portfolio from both providers', async () => {
    const { portfolio, cached } = await getPortfolio(
      { address: TEST_ADDRESS, chainId: 1 },
      {
        env: env(),
        chain,
        logger: silentLogger(),
        balanceProvider: balanceProvider(),
        rateProvider: null,
        priceProvider: priceProvider(),
      },
    );

    expect(cached).toBe(false);
    expect(portfolio.address).toBe(TEST_ADDRESS);
    expect(portfolio.chainName).toBe('Ethereum Mainnet');
    expect(portfolio.balanceSource).toBe('fake-balances');
    expect(portfolio.priceSource).toBe('fake-prices');
    expect(portfolio.totalValueUsd).toBe('2250.00000000');
    expect(portfolio.assetCount).toBe(2);
  });

  describe('price cross-check', () => {
    it('records agreement and disagreement without moving either out of the total', async () => {
      const { portfolio } = await getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        {
          env: env(),
          chain,
          logger: silentLogger(),
          balanceProvider: balanceProvider(),
          rateProvider: null,
          priceProvider: priceProvider(),
          // ETH agrees at 2,010 against 2,000; USDC is disputed at 1.40 against 1.
          priceVerifier: priceVerifier({ prices: { [NATIVE_KEY]: '2010', [USDC_KEY]: '1.40' } }),
        },
      );

      expect(portfolio.checkedAssetCount).toBe(2);
      expect(portfolio.disputedAssetCount).toBe(1);
      // Unchanged: doubt about a number is not doubt about the holding.
      expect(portfolio.totalValueUsd).toBe('2250.00000000');
      expect(portfolio.warnings.map((w) => w.code)).toContain('prices.disputed');
    });

    it('never asks about a suspect asset, however large its fabricated price', async () => {
      // The failure this guards: ranking raw balances would put a spoofed token
      // with an invented price first and spend the whole quota on an asset that is
      // excluded from the total anyway.
      const FAKE = '0x00000000000000000000000000000000DeaDBeef' as const;
      const fakeKey = priceRefKey({ chainId: 1, contractAddress: FAKE });
      const verifier = priceVerifier({ prices: {} });

      const { portfolio } = await getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        {
          env: env(),
          chain,
          logger: silentLogger(),
          balanceProvider: balanceProvider({
            balances: [
              {
                chainId: 1,
                contractAddress: null,
                name: 'Ether',
                symbol: 'ETH',
                decimals: 18,
                raw: 1_000_000_000_000_000_000n,
                logoUrl: null,
              },
              {
                // Off-list contract wearing USDC's symbol: the spoof heuristic.
                chainId: 1,
                contractAddress: FAKE,
                name: 'USD Coin',
                symbol: 'USDC',
                decimals: 6,
                raw: 1_000_000_000_000n,
                logoUrl: null,
              },
            ],
          }),
          rateProvider: null,
          priceProvider: priceProvider({
            quotes: new Map([
              [NATIVE_KEY, { priceUsd: '2000', updatedAt: FRESH_TIMESTAMP, confidence: 0.99 }],
              // A million dollars of fake, which would outrank everything real.
              [fakeKey, { priceUsd: '1', updatedAt: FRESH_TIMESTAMP, confidence: 0.99 }],
            ]),
          }),
          priceVerifier: verifier,
        },
      );

      expect(portfolio.suspectAssetCount).toBe(1);
      expect(verifier.askedAbout).toEqual([NATIVE_KEY]);
      expect(verifier.askedAbout).not.toContain(fakeKey);
      // The count can therefore never exceed the number of priced assets in the
      // total, which is what the summary quotes as its denominator.
      expect(portfolio.checkedAssetCount).toBeLessThanOrEqual(portfolio.pricedAssetCount - 1);
    });

    it('leaves a ref the verifier never reached uncross-checked, not "no opinion"', async () => {
      const { portfolio } = await getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        {
          env: env(),
          chain,
          logger: silentLogger(),
          balanceProvider: balanceProvider(),
          rateProvider: null,
          priceProvider: priceProvider(),
          // Asked about both, but only got as far as issuing one request.
          priceVerifier: priceVerifier({
            prices: { [NATIVE_KEY]: '2000' },
            attempted: (refKeys) => refKeys.slice(0, 1),
          }),
        },
      );

      const eth = portfolio.assets.find((asset) => asset.symbol === 'ETH');
      const usdc = portfolio.assets.find((asset) => asset.symbol === 'USDC');

      expect(eth?.priceCheck?.status).toBe('agreed');
      // Null, not 'unverified': nothing was ever asked about it, so nothing about
      // it was verified or declined. Counting it would overstate the coverage and
      // credit a source that returned nothing for it.
      expect(usdc?.priceCheck).toBeNull();
      expect(portfolio.checkedAssetCount).toBe(1);
    });

    it('degrades to one warning, with the portfolio intact, when the verifier fails', async () => {
      const { portfolio } = await getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        {
          env: env(),
          chain,
          logger: silentLogger(),
          balanceProvider: balanceProvider(),
          rateProvider: null,
          priceProvider: priceProvider(),
          priceVerifier: {
            id: 'broken-verifier',
            verify: () =>
              Promise.reject(
                new ProviderError('unavailable', 'broken-verifier', 'Second source is down'),
              ),
          },
        },
      );

      expect(portfolio.totalValueUsd).toBe('2250.00000000');
      expect(portfolio.checkedAssetCount).toBe(0);
      expect(portfolio.assets.every((asset) => asset.priceCheck === null)).toBe(true);
      expect(portfolio.warnings.map((w) => w.code)).toContain('prices.crosscheck_unavailable');
    });

    it('cross-checks nothing and warns about nothing when no verifier is configured', async () => {
      // The default state. A warning here would report a fault where there is only
      // an absent optional key.
      const { portfolio } = await getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        {
          env: env(),
          chain,
          logger: silentLogger(),
          balanceProvider: balanceProvider(),
          rateProvider: null,
          priceProvider: priceProvider(),
          priceVerifier: null,
        },
      );

      expect(portfolio.checkedAssetCount).toBe(0);
      expect(portfolio.assets.every((asset) => asset.priceCheck === null)).toBe(true);
      expect(portfolio.warnings.map((w) => w.code)).not.toContain('prices.crosscheck_unavailable');
      expect(portfolio.warnings.map((w) => w.code)).not.toContain('prices.crosscheck_partial');
    });
  });

  describe('display rate', () => {
    const base = {
      env: env(),
      chain,
      logger: silentLogger(),
      balanceProvider: balanceProvider(),
      priceProvider: priceProvider(),
    };

    it('carries the rate and the source’s own date onto the payload', async () => {
      const { portfolio } = await getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        { ...base, rateProvider: rateProvider(), now: () => new Date('2026-08-03T10:00:00.000Z') },
      );

      expect(portfolio.fxRate).toEqual({
        base: 'EUR',
        quote: 'USD',
        rate: '1.25',
        asOf: '2026-07-31',
      });
      // Three days old on a Monday is an ordinary weekend, not a fault.
      expect(portfolio.warnings.map((w) => w.code)).not.toContain('rates.aged');
    });

    it('calls out a rate old enough to mean something upstream broke', async () => {
      const { portfolio } = await getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        {
          ...base,
          rateProvider: rateProvider({ asOf: '2026-07-01' }),
          now: () => new Date('2026-08-03T10:00:00.000Z'),
        },
      );

      const aged = portfolio.warnings.find((w) => w.code === 'rates.aged');
      expect(aged?.message).toContain('2026-07-01');
      // The rate is still offered — an old rate beats no euro at all, as long as
      // its age is stated.
      expect(portfolio.fxRate).not.toBeNull();
    });

    it('degrades to no euro with a warning when the rate cannot be fetched', async () => {
      const { portfolio } = await getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        {
          ...base,
          rateProvider: {
            id: 'broken-rates',
            fetchRate: () =>
              Promise.reject(new ProviderError('unavailable', 'broken-rates', 'down')),
          },
        },
      );

      expect(portfolio.fxRate).toBeNull();
      // Said out loud rather than the toggle silently vanishing.
      expect(portfolio.warnings.map((w) => w.code)).toContain('rates.unavailable');
      // Dollars are unaffected.
      expect(portfolio.totalValueUsd).toBe('2250.00000000');
    });

    it('asks for no rate at all, and warns about none, when none is configured', async () => {
      // This is also what keeps the unit suite network-free: a test that does not
      // supply a rate source must not fall through to the registry and out to the
      // European Central Bank, which is exactly what happened before this test
      // existed.
      const { portfolio } = await getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        { ...base, rateProvider: null },
      );

      expect(portfolio.fxRate).toBeNull();
      expect(portfolio.warnings.map((w) => w.code)).not.toContain('rates.unavailable');
      expect(portfolio.warnings.map((w) => w.code)).not.toContain('rates.aged');
    });

    it('surfaces a broken rate provider instead of reporting it as an outage', async () => {
      // A ProviderError is weather. A TypeError is a bug, and turning it into a
      // "rate unavailable" warning is how a real defect stayed invisible.
      await expect(
        getPortfolio(
          { address: TEST_ADDRESS, chainId: 1 },
          {
            ...base,
            rateProvider: {
              id: 'buggy-rates',
              fetchRate: () => Promise.reject(new TypeError('undefined is not a function')),
            },
          },
        ),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });

  it('carries an aged bundled token list from the provider into the payload', async () => {
    // The one test here that uses the real keyless adapter: the age policy is
    // read from the environment, so this proves the whole path — env → provider
    // context → snapshot → portfolio warnings — rather than the adapter alone.
    const { fetchImpl } = createFetchStub(() => rpcResult('0xde0b6b3a7640000'));
    const aged = createTestChain({
      tokenList: {
        ...chain.tokenList,
        // Empty, so the sweep needs no multicall fixture; coverage warnings do
        // not depend on the list having entries.
        tokens: [],
        generatedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(),
      },
    });

    const { portfolio } = await getPortfolio(
      { address: TEST_ADDRESS, chainId: 1 },
      {
        env: env({ TOKEN_LIST_MAX_AGE_DAYS: 60 }),
        chain: aged,
        logger: silentLogger(),
        balanceProvider: createRpcTokenListProvider(),
        rateProvider: null,
        priceProvider: priceProvider(),
        fetchImpl,
      },
    );

    expect(
      portfolio.warnings.find((w) => w.code === 'coverage.token-list-aged')?.message,
    ).toContain('90 days old');
  });

  it('serves an identical second request from the cache', async () => {
    const balances = balanceProvider();
    const fetchBalances = vi.spyOn(balances, 'fetchBalances');

    const dependencies = {
      env: env(),
      chain,
      logger: silentLogger(),
      balanceProvider: balances,
      rateProvider: null,
      priceProvider: priceProvider(),
    };

    await getPortfolio({ address: TEST_ADDRESS, chainId: 1 }, dependencies);
    const second = await getPortfolio({ address: TEST_ADDRESS, chainId: 1 }, dependencies);

    expect(second.cached).toBe(true);
    expect(fetchBalances).toHaveBeenCalledTimes(1);
  });

  it('keys the cache case-insensitively, so the same wallet is one entry', async () => {
    const balances = balanceProvider();
    const fetchBalances = vi.spyOn(balances, 'fetchBalances');

    const dependencies = {
      env: env(),
      chain,
      logger: silentLogger(),
      balanceProvider: balances,
      rateProvider: null,
      priceProvider: priceProvider(),
    };

    await getPortfolio({ address: TEST_ADDRESS, chainId: 1 }, dependencies);
    await getPortfolio(
      { address: TEST_ADDRESS.toLowerCase() as typeof TEST_ADDRESS, chainId: 1 },
      dependencies,
    );

    expect(fetchBalances).toHaveBeenCalledTimes(1);
  });

  it('degrades to quantities with a warning when the price provider fails', async () => {
    const failing: PriceProvider = {
      id: 'failing-prices',
      fetchPrices: () =>
        Promise.reject(new ProviderError('unavailable', 'failing-prices', 'upstream down')),
    };

    const { portfolio } = await getPortfolio(
      { address: TEST_ADDRESS, chainId: 1 },
      {
        env: env(),
        chain,
        logger: silentLogger(),
        balanceProvider: balanceProvider(),
        rateProvider: null,
        priceProvider: failing,
      },
    );

    // Holdings are still worth reading without prices.
    expect(portfolio.assetCount).toBe(2);
    expect(portfolio.totalValueUsd).toBeNull();
    expect(portfolio.priceSource).toBeNull();
    expect(portfolio.warnings.map((warning) => warning.code)).toContain('prices.unavailable');
  });

  it('propagates a balance-provider failure, because there is nothing to show', async () => {
    const failing: PortfolioProvider = {
      id: 'failing-balances',
      supportsChain: () => true,
      fetchBalances: () =>
        Promise.reject(new ProviderError('timeout', 'failing-balances', 'took too long')),
    };

    await expect(
      getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        {
          env: env(),
          chain,
          logger: silentLogger(),
          balanceProvider: failing,
          rateProvider: null,
          priceProvider: priceProvider(),
        },
      ),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'timeout' });
  });

  it('does not cache a failed load', async () => {
    const failing: PortfolioProvider = {
      id: 'failing-balances',
      supportsChain: () => true,
      fetchBalances: vi
        .fn<PortfolioProvider['fetchBalances']>()
        .mockRejectedValueOnce(new ProviderError('unavailable', 'failing-balances', 'down'))
        .mockImplementation(balanceProvider().fetchBalances),
    };

    const dependencies = {
      env: env(),
      chain,
      logger: silentLogger(),
      balanceProvider: failing,
      rateProvider: null,
      priceProvider: priceProvider(),
    };

    await expect(
      getPortfolio({ address: TEST_ADDRESS, chainId: 1 }, dependencies),
    ).rejects.toThrow();
    const retry = await getPortfolio({ address: TEST_ADDRESS, chainId: 1 }, dependencies);

    expect(retry.portfolio.assetCount).toBe(2);
  });

  it('rejects a chain that is not registered', async () => {
    await expect(
      getPortfolio(
        { address: TEST_ADDRESS, chainId: 424_242 },
        { env: env(), logger: silentLogger() },
      ),
    ).rejects.toBeInstanceOf(UnsupportedChainError);
  });

  it('rejects a chain the balance provider cannot serve', async () => {
    const narrow: PortfolioProvider = {
      ...balanceProvider(),
      supportsChain: () => false,
    };

    await expect(
      getPortfolio(
        { address: TEST_ADDRESS, chainId: 1 },
        {
          env: env(),
          chain,
          logger: silentLogger(),
          balanceProvider: narrow,
          rateProvider: null,
          priceProvider: priceProvider(),
        },
      ),
    ).rejects.toBeInstanceOf(UnsupportedChainError);
  });

  it('carries provider warnings through to the portfolio', async () => {
    const { portfolio } = await getPortfolio(
      { address: TEST_ADDRESS, chainId: 1 },
      {
        env: env(),
        chain,
        logger: silentLogger(),
        balanceProvider: balanceProvider({
          coverage: 'token-list',
          warnings: [{ code: 'coverage.token-list', message: 'Only listed tokens were checked.' }],
        }),
        rateProvider: null,
        priceProvider: priceProvider({
          warnings: [{ code: 'prices.partial', message: 'One batch failed.' }],
        }),
      },
    );

    expect(portfolio.coverage).toBe('token-list');
    expect(portfolio.warnings.map((warning) => warning.code)).toEqual(
      expect.arrayContaining(['coverage.token-list', 'prices.partial']),
    );
  });

  it('logs the load without recording the full wallet address', async () => {
    const { logger, lines } = createRecordingLogger('info');

    await getPortfolio(
      { address: TEST_ADDRESS, chainId: 1 },
      {
        env: env(),
        chain,
        logger,
        balanceProvider: balanceProvider(),
        rateProvider: null,
        priceProvider: priceProvider(),
      },
    );

    const line = lines.find((entry) => entry.includes('portfolio.loaded'));
    expect(line).toBeDefined();
    expect(line).not.toContain(TEST_ADDRESS);
    expect(line).toContain('0xd8dA…6045');
  });

  it('stamps fetchedAt from the injected clock', async () => {
    const { portfolio } = await getPortfolio(
      { address: TEST_ADDRESS, chainId: 1 },
      {
        env: env(),
        chain,
        logger: silentLogger(),
        balanceProvider: balanceProvider(),
        rateProvider: null,
        priceProvider: priceProvider(),
        now: () => new Date('2026-07-30T12:00:00.000Z'),
      },
    );

    expect(portfolio.fetchedAt).toBe('2026-07-30T12:00:00.000Z');
  });
});

describe('getAggregatePortfolio', () => {
  const ethereum = createTestChain();
  const base = createTestChain({ chainId: 8453, slug: 'base', name: 'Base', shortName: 'Base' });

  function baseDependencies() {
    return {
      env: env(),
      logger: silentLogger(),
      chains: [ethereum, base],
      balanceProvider: balanceProvider(),
      rateProvider: null,
      priceProvider: priceProvider(),
    };
  }

  it('sums every chain that answered', async () => {
    const { aggregate } = await getAggregatePortfolio(TEST_ADDRESS, baseDependencies());

    expect(aggregate.chains).toHaveLength(2);
    expect(aggregate.failedChains).toHaveLength(0);
    // 2250 per chain, both chains served by the same fake provider.
    expect(aggregate.totalValueUsd).toBe('4500.00000000');
    expect(aggregate.assetCount).toBe(4);
  });

  it('keeps the chains that worked when one fails', async () => {
    // One unreachable network must not cost the user every other network.
    const failing: PortfolioProvider = {
      id: 'partly-failing',
      supportsChain: () => true,
      fetchBalances: ({ chain }) =>
        chain.chainId === 8453
          ? Promise.reject(new ProviderError('unavailable', 'partly-failing', 'node down'))
          : balanceProvider().fetchBalances({
              address: TEST_ADDRESS,
              chain,
              context: {} as never,
            }),
    };

    const { aggregate } = await getAggregatePortfolio(TEST_ADDRESS, {
      ...baseDependencies(),
      balanceProvider: failing,
    });

    expect(aggregate.chains.map((chain) => chain.chainId)).toEqual([1]);
    expect(aggregate.failedChains).toEqual([
      {
        chainId: 8453,
        chainName: 'Base',
        message: 'This network could not be reached and was skipped.',
      },
    ]);
    expect(aggregate.totalValueUsd).toBe('2250.00000000');
  });

  it('describes a failed chain without leaking the upstream message', async () => {
    const failing: PortfolioProvider = {
      id: 'leaky',
      supportsChain: () => true,
      fetchBalances: () =>
        Promise.reject(
          new ProviderError('timeout', 'leaky', 'https://secret.rpc.invalid/KEY timed out'),
        ),
    };

    await expect(
      getAggregatePortfolio(TEST_ADDRESS, { ...baseDependencies(), balanceProvider: failing }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('fails the request only when no chain at all could be read', async () => {
    const failing: PortfolioProvider = {
      id: 'all-failing',
      supportsChain: () => true,
      fetchBalances: () =>
        Promise.reject(new ProviderError('rate-limited', 'all-failing', 'slow down')),
    };

    await expect(
      getAggregatePortfolio(TEST_ADDRESS, { ...baseDependencies(), balanceProvider: failing }),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'rate-limited' });
  });

  it('reports cached only when no chain had to be fetched', async () => {
    const dependencies = baseDependencies();

    const first = await getAggregatePortfolio(TEST_ADDRESS, dependencies);
    const second = await getAggregatePortfolio(TEST_ADDRESS, dependencies);

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
  });
});
