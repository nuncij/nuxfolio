import { describe, expect, it } from 'vitest';

import type { ChainLoadResult } from '@/domain/progressiveAggregate';
import { abortError, createFetchStub, jsonResponse, TEST_ADDRESS } from '@/test/helpers';

import { ABORTED, fetchChainPortfolios, fetchPortfolioFromApi } from './portfolioClient';

const VALID_PORTFOLIO = {
  address: TEST_ADDRESS,
  chainId: 1,
  chainName: 'Ethereum Mainnet',
  protocolAccounts: [],
  totalValueUsd: '2000.00000000',
  netOfAaveDebtUsd: null,
  assetCount: 1,
  pricedAssetCount: 1,
  unpricedAssetCount: 0,
  suspectAssetCount: 0,
  suspectValueUsd: null,
  checkedAssetCount: 0,
  disputedAssetCount: 0,
  coverage: 'complete',
  balanceSource: 'rpc-token-list',
  priceSource: 'defillama',
  assets: [
    {
      assetId: '1:native',
      chainId: 1,
      contractAddress: null,
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      quantity: '1',
      rawQuantity: '1000000000000000000',
      priceUsd: '2000',
      valueUsd: '2000.00000000',
      portfolioSharePct: '100.0000',
      logoUrl: null,
      priceSource: 'defillama',
      priceUpdatedAt: null,
      priceQuality: 'ok',
      priceCheck: null,
      priceChange24h: null,
      priceChange7d: null,
      suspect: false,
      suspectReason: null,
    },
  ],
  fxRate: null,
  fetchedAt: '2026-07-30T12:00:00.000Z',
  warnings: [],
};

describe('fetchPortfolioFromApi', () => {
  it('returns a validated portfolio on success', async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({ portfolio: VALID_PORTFOLIO, cached: false }),
    );

    const result = await fetchPortfolioFromApi({
      address: TEST_ADDRESS,
      chainId: 1,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: true, cached: false, aggregate: null });
    expect(calls[0]?.url).toBe(`/api/portfolio?address=${TEST_ADDRESS}&chainId=1`);
  });

  it('surfaces the server error code and message verbatim', async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse(
        { error: { code: 'invalid-address', message: 'An EVM address must start with "0x".' } },
        { status: 400 },
      ),
    );

    const result = await fetchPortfolioFromApi({ address: 'nope', chainId: 1, fetchImpl });

    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid-address', message: 'An EVM address must start with "0x".' },
    });
  });

  it('falls back to a generic message when an error body is unrecognisable', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({ oops: true }, { status: 500 }));

    const result = await fetchPortfolioFromApi({ address: TEST_ADDRESS, chainId: 1, fetchImpl });

    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('rejects a success body that does not match the portfolio schema', async () => {
    // Better a clear failure than `undefined` rendered into the asset table.
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({ portfolio: { ...VALID_PORTFOLIO, totalValueUsd: 2000 }, cached: false }),
    );

    const result = await fetchPortfolioFromApi({ address: TEST_ADDRESS, chainId: 1, fetchImpl });

    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('reports a network failure as an unavailable upstream', async () => {
    const fetchImpl = (() =>
      Promise.reject(new TypeError('Failed to fetch'))) as typeof globalThis.fetch;

    const result = await fetchPortfolioFromApi({ address: TEST_ADDRESS, chainId: 1, fetchImpl });

    expect(result).toMatchObject({ ok: false, error: { code: 'upstream-unavailable' } });
  });

  it('reports a non-JSON body as unreadable rather than crashing', async () => {
    const { fetchImpl } = createFetchStub(() => new Response('<html>502</html>', { status: 200 }));

    const result = await fetchPortfolioFromApi({ address: TEST_ADDRESS, chainId: 1, fetchImpl });

    expect(result).toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('signals an abort distinctly, so the caller leaves state untouched', async () => {
    const fetchImpl = (() => Promise.reject(abortError())) as typeof globalThis.fetch;

    const result = await fetchPortfolioFromApi({ address: TEST_ADDRESS, chainId: 1, fetchImpl });

    expect(result).toBe(ABORTED);
  });

  it('encodes query parameters rather than interpolating them raw', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}, { status: 400 }));

    await fetchPortfolioFromApi({ address: 'a&b=c', chainId: 1, fetchImpl });

    expect(calls[0]?.url).toContain('address=a%26b%3Dc');
  });
});

const CHAIN_IDS = [1, 8453, 56] as const;

function portfolioFor(chainId: number) {
  return {
    ...VALID_PORTFOLIO,
    chainId,
    chainName: `Chain ${chainId}`,
    assets: [{ ...VALID_PORTFOLIO.assets[0], assetId: `${chainId}:native`, chainId }],
  };
}

/** Lets a test decide when each chain's request comes back, and in what order. */
function createGatedFetchStub(respond: (chainId: number) => Response) {
  const gates = new Map<number, () => void>();

  const fetchImpl = ((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'https://nuxfolio.test');
    const chainId = Number(url.searchParams.get('chainId'));
    return new Promise<Response>((resolve) => {
      gates.set(chainId, () => resolve(respond(chainId)));
    });
  }) as typeof globalThis.fetch;

  /** Releases one chain's response and lets its callbacks run to completion. */
  async function release(chainId: number): Promise<void> {
    gates.get(chainId)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { fetchImpl, release };
}

describe('fetchChainPortfolios', () => {
  it('requests one chain each, through the single-chain endpoint', async () => {
    const { fetchImpl, calls } = createFetchStub((url) =>
      jsonResponse({
        portfolio: portfolioFor(
          Number(new URL(url, 'https://nuxfolio.test').searchParams.get('chainId')),
        ),
        cached: false,
      }),
    );

    const results = await fetchChainPortfolios({
      address: TEST_ADDRESS,
      chainIds: CHAIN_IDS,
      fetchImpl,
    });

    expect(calls.map((call) => call.url)).toEqual(
      CHAIN_IDS.map((chainId) => `/api/portfolio?address=${TEST_ADDRESS}&chainId=${chainId}`),
    );
    expect(results.map((result) => result.chainId)).toEqual([...CHAIN_IDS]);
    expect(results.every((result) => result.ok)).toBe(true);
  });

  it('reports each chain as it settles, and returns them in request order', async () => {
    // The point of the fan-out: a fast network is not held up by a slow one, so
    // the callback order is the network order and the returned order is not.
    const { fetchImpl, release } = createGatedFetchStub((chainId) =>
      jsonResponse({ portfolio: portfolioFor(chainId), cached: false }),
    );

    const settled: number[] = [];
    const pending = fetchChainPortfolios({
      address: TEST_ADDRESS,
      chainIds: CHAIN_IDS,
      fetchImpl,
      onSettled: (result) => settled.push(result.chainId),
    });

    await release(56);
    expect(settled).toEqual([56]);
    await release(8453);
    await release(1);

    const results = await pending;
    expect(settled).toEqual([56, 8453, 1]);
    expect(results.map((result) => result.chainId)).toEqual([1, 8453, 56]);
  });

  it('keeps the other networks when one fails', async () => {
    const { fetchImpl } = createFetchStub((url) => {
      const chainId = Number(new URL(url, 'https://nuxfolio.test').searchParams.get('chainId'));
      return chainId === 56
        ? jsonResponse(
            { error: { code: 'timeout', message: 'The data provider took too long.' } },
            { status: 504 },
          )
        : jsonResponse({ portfolio: portfolioFor(chainId), cached: false });
    });

    const results = await fetchChainPortfolios({
      address: TEST_ADDRESS,
      chainIds: CHAIN_IDS,
      fetchImpl,
    });

    expect(results.filter((result) => result.ok)).toHaveLength(2);
    expect(results.find((result) => result.chainId === 56)).toEqual({
      chainId: 56,
      ok: false,
      error: { code: 'timeout', message: 'The data provider took too long.' },
    });
  });

  it('rejects a portfolio that belongs to a different chain', async () => {
    // Filing one network's assets under another's name would misreport the
    // breakdown, so an answer that does not match the question is unreadable.
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({ portfolio: portfolioFor(999), cached: false }),
    );

    const results = await fetchChainPortfolios({
      address: TEST_ADDRESS,
      chainIds: [1],
      fetchImpl,
    });

    expect(results[0]).toMatchObject({ chainId: 1, ok: false, error: { code: 'internal' } });
  });

  it('reports nothing for an aborted chain, and still reports the others', async () => {
    const { fetchImpl } = createFetchStub((url) => {
      const chainId = Number(new URL(url, 'https://nuxfolio.test').searchParams.get('chainId'));
      if (chainId === 1) {
        throw abortError();
      }
      return jsonResponse({ portfolio: portfolioFor(chainId), cached: false });
    });

    const settled: ChainLoadResult[] = [];
    const results = await fetchChainPortfolios({
      address: TEST_ADDRESS,
      chainIds: CHAIN_IDS,
      fetchImpl,
      onSettled: (result) => settled.push(result),
    });

    expect(results.map((result) => result.chainId)).toEqual([8453, 56]);
    expect(settled.map((result) => result.chainId).sort()).toEqual([56, 8453]);
  });
});
