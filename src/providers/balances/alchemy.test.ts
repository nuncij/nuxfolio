import { describe, expect, it } from 'vitest';

import { Deadline } from '@/server/deadline';
import {
  createFetchStub,
  createTestChain,
  createTestContext,
  jsonResponse,
  rpcError,
  rpcResult,
  TEST_ADDRESS,
  USDC,
  WETH,
} from '@/test/helpers';

import { createAlchemyProvider } from './alchemy';

const API_KEY = 'alchemy-test-key-value';

/** An address not present in the test chain's bundled token list. */
const UNLISTED = '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984';

function provider() {
  return createAlchemyProvider({ apiKey: API_KEY });
}

function balancesPage(
  entries: { contractAddress: string; tokenBalance: string | null; error?: string }[],
  pageKey?: string,
) {
  return rpcResult({
    address: TEST_ADDRESS,
    tokenBalances: entries,
    ...(pageKey === undefined ? {} : { pageKey }),
  });
}

const ONE_ETH_HEX = '0xde0b6b3a7640000';

describe('alchemy balance provider', () => {
  it('reads the native balance and indexed token balances', async () => {
    const { fetchImpl, calls } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult(ONE_ETH_HEX)
        : balancesPage([{ contractAddress: USDC, tokenBalance: '0x59682f00' }]),
    );

    const snapshot = await provider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.providerId).toBe('alchemy');
    expect(snapshot.coverage).toBe('complete');
    expect(snapshot.balances).toHaveLength(2);
    expect(snapshot.balances[1]).toMatchObject({
      contractAddress: USDC,
      symbol: 'USDC',
      decimals: 6,
      raw: 1_500_000_000n,
    });
    // Native read + one balances page. No metadata call: USDC is on the list.
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ method: 'alchemy_getTokenBalances' });
  });

  it('sends the key in the URL and never in a header or body', async () => {
    const { fetchImpl, calls } = createFetchStub((_url, _init, index) =>
      index === 0 ? rpcResult('0x0') : balancesPage([]),
    );

    await provider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(calls[0]?.url).toBe(`https://eth-mainnet.g.alchemy.com/v2/${API_KEY}`);
    expect(JSON.stringify(calls[0]?.body)).not.toContain(API_KEY);
  });

  it('takes metadata from the bundled list, so known tokens cost no extra call', async () => {
    const { fetchImpl, calls } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x0')
        : balancesPage([
            { contractAddress: USDC, tokenBalance: '0x1' },
            { contractAddress: WETH, tokenBalance: '0x1' },
          ]),
    );

    await provider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(calls.filter((call) => call.body !== undefined)).toHaveLength(2);
    expect(
      calls.some(
        (call) =>
          typeof call.body === 'object' &&
          call.body !== null &&
          (call.body as { method?: string }).method === 'alchemy_getTokenMetadata',
      ),
    ).toBe(false);
  });

  it('looks up metadata only for tokens it does not recognise', async () => {
    const { fetchImpl, calls } = createFetchStub((_url, _init, index) => {
      if (index === 0) return rpcResult('0x0');
      if (index === 1) {
        return balancesPage([
          { contractAddress: USDC, tokenBalance: '0x1' },
          { contractAddress: UNLISTED, tokenBalance: '0xde0b6b3a7640000' },
        ]);
      }
      return rpcResult({ name: 'Uniswap', symbol: 'UNI', decimals: 18, logo: null });
    });

    const snapshot = await provider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(calls).toHaveLength(3);
    expect(calls[2]?.body).toMatchObject({ method: 'alchemy_getTokenMetadata' });
    expect(snapshot.balances.find((balance) => balance.symbol === 'UNI')).toMatchObject({
      decimals: 18,
      raw: 1_000_000_000_000_000_000n,
    });
  });

  it('skips a token whose decimals cannot be resolved rather than guessing', async () => {
    // A guessed exponent would fabricate a quantity, which is worse than an
    // acknowledged omission.
    const { fetchImpl } = createFetchStub((_url, _init, index) => {
      if (index === 0) return rpcResult('0x0');
      if (index === 1) return balancesPage([{ contractAddress: UNLISTED, tokenBalance: '0x1' }]);
      return rpcResult({ name: 'Mystery', symbol: 'MYST', decimals: null, logo: null });
    });

    const snapshot = await provider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.balances).toHaveLength(0);
    expect(snapshot.warnings.map((warning) => warning.code)).toContain(
      'balances.metadata_incomplete',
    );
    expect(snapshot.coverage).toBe('truncated');
  });

  it('keeps going when a metadata lookup fails outright', async () => {
    const { fetchImpl } = createFetchStub((_url, _init, index) => {
      if (index === 0) return rpcResult(ONE_ETH_HEX);
      if (index === 1) return balancesPage([{ contractAddress: UNLISTED, tokenBalance: '0x1' }]);
      return jsonResponse({}, { status: 500 });
    });

    const snapshot = await provider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    // The native balance survives a failed token metadata lookup.
    expect(snapshot.balances.map((balance) => balance.symbol)).toEqual(['ETH']);
  });

  it('treats a zero balance as simply not a holding, and still reports complete', async () => {
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x0')
        : balancesPage([{ contractAddress: USDC, tokenBalance: '0x0' }]),
    );

    const snapshot = await provider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.balances).toHaveLength(0);
    expect(snapshot.coverage).toBe('complete');
    expect(snapshot.warnings).toHaveLength(0);
  });

  it('reports an entry the indexer could not read as a gap, not as absence', async () => {
    // The token exists and is not shown, so coverage must not claim `complete`.
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x0')
        : balancesPage([{ contractAddress: WETH, tokenBalance: null, error: 'could not read' }]),
    );

    const snapshot = await provider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.balances).toHaveLength(0);
    expect(snapshot.coverage).toBe('truncated');
    expect(
      snapshot.warnings.find((w) => w.code === 'balances.unreadable_entries')?.message,
    ).toContain('1 token could not be read');
  });

  it('counts an entry with an unusable contract address as unreadable', async () => {
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x0')
        : balancesPage([{ contractAddress: 'not-an-address', tokenBalance: '0x1' }]),
    );

    const snapshot = await provider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.balances).toHaveLength(0);
    expect(snapshot.coverage).toBe('truncated');
    expect(snapshot.warnings.map((w) => w.code)).toContain('balances.unreadable_entries');
  });

  it('rejects a response whose address field is not an address at all', async () => {
    // Failing open here would attribute unattributed balances to this wallet,
    // which is the worst outcome this adapter has available.
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x0')
        : rpcResult({
            address: 'not-an-address',
            tokenBalances: [{ contractAddress: USDC, tokenBalance: '0x1' }],
          }),
    );

    await expect(
      provider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl),
      }),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('accepts a response whose address differs only in casing', async () => {
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x0')
        : rpcResult({
            address: TEST_ADDRESS.toLowerCase(),
            tokenBalances: [{ contractAddress: USDC, tokenBalance: '0x1' }],
          }),
    );

    const snapshot = await provider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.balances).toHaveLength(1);
  });

  it('rejects a response that answers for a different address', async () => {
    // Otherwise a mismatched response would be rendered as this wallet's holdings.
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x0')
        : rpcResult({
            address: '0x0000000000000000000000000000000000000001',
            tokenBalances: [{ contractAddress: USDC, tokenBalance: '0x1' }],
          }),
    );

    await expect(
      provider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl),
      }),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  describe('pagination', () => {
    it('follows page keys and merges the pages', async () => {
      const { fetchImpl, calls } = createFetchStub((_url, _init, index) => {
        if (index === 0) return rpcResult('0x0');
        if (index === 1)
          return balancesPage([{ contractAddress: USDC, tokenBalance: '0x1' }], 'page-2');
        return balancesPage([{ contractAddress: WETH, tokenBalance: '0x1' }]);
      });

      const snapshot = await provider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl),
      });

      expect(snapshot.balances.map((balance) => balance.symbol)).toEqual(['USDC', 'WETH']);
      expect(snapshot.coverage).toBe('complete');
      expect(calls[2]?.body).toMatchObject({
        method: 'alchemy_getTokenBalances',
        params: [TEST_ADDRESS, 'erc20', { pageKey: 'page-2' }],
      });
    });

    it('stops after the page ceiling and reports truncation', async () => {
      // An endless pageKey must not become an endless request loop.
      const { fetchImpl, calls } = createFetchStub((_url, _init, index) =>
        index === 0
          ? rpcResult('0x0')
          : balancesPage([{ contractAddress: USDC, tokenBalance: '0x1' }], 'always-more'),
      );

      const snapshot = await provider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl),
      });

      expect(calls).toHaveLength(6); // 1 native + 5 pages
      expect(snapshot.coverage).toBe('truncated');
      expect(snapshot.warnings.find((w) => w.code === 'coverage.truncated')?.message).toContain(
        '5 pages',
      );
    });

    it('stops paging when the deadline is spent', async () => {
      const { fetchImpl, calls } = createFetchStub((_url, _init, index) =>
        index === 0
          ? rpcResult('0x0')
          : balancesPage([{ contractAddress: USDC, tokenBalance: '0x1' }], 'always-more'),
      );

      const spentDeadline = Object.assign(Object.create(Deadline.prototype) as Deadline, {
        remainingMs: () => 5_000,
        timeoutForAttempt: () => 5_000,
        hasExpired: () => true,
      });

      const snapshot = await provider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl, { deadline: spentDeadline }),
      });

      expect(calls).toHaveLength(2);
      expect(snapshot.coverage).toBe('truncated');
      expect(snapshot.warnings.find((w) => w.code === 'coverage.truncated')?.message).toContain(
        'ran out of time',
      );
    });

    it('caps the asset count and says how the list was limited', async () => {
      const many = Array.from({ length: 5 }, (_, index) => ({
        contractAddress: `0x${index.toString(16).padStart(40, '0')}`,
        tokenBalance: '0x1',
      }));

      const { fetchImpl } = createFetchStub((_url, _init, index) =>
        index === 0 ? rpcResult('0x0') : balancesPage(many),
      );

      const snapshot = await provider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl, { maxAssets: 2 }),
      });

      expect(snapshot.coverage).toBe('truncated');
      expect(snapshot.warnings.find((w) => w.code === 'coverage.truncated')?.message).toContain(
        'more than 2 tokens',
      );
    });

    it('does not claim truncation when the holdings land exactly on the cap', async () => {
      const { fetchImpl } = createFetchStub((_url, _init, index) =>
        index === 0
          ? rpcResult('0x0')
          : balancesPage([
              { contractAddress: USDC, tokenBalance: '0x1' },
              { contractAddress: WETH, tokenBalance: '0x1' },
            ]),
      );

      const snapshot = await provider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl, { maxAssets: 2 }),
      });

      // Nothing was dropped, so nothing should be reported as missing.
      expect(snapshot.coverage).toBe('complete');
      expect(snapshot.warnings).toHaveLength(0);
    });
  });

  describe('failures', () => {
    it('fails when the native balance cannot be read', async () => {
      const { fetchImpl } = createFetchStub(() => rpcError(-32000, 'upstream error'));

      await expect(
        provider().fetchBalances({
          address: TEST_ADDRESS,
          chain: createTestChain(),
          context: createTestContext(fetchImpl),
        }),
      ).rejects.toMatchObject({ name: 'ProviderError', kind: 'invalid-response' });
    });

    it('rejects a balances payload of an unexpected shape', async () => {
      const { fetchImpl } = createFetchStub((_url, _init, index) =>
        index === 0 ? rpcResult('0x0') : rpcResult({ unexpected: true }),
      );

      await expect(
        provider().fetchBalances({
          address: TEST_ADDRESS,
          chain: createTestChain(),
          context: createTestContext(fetchImpl),
        }),
      ).rejects.toMatchObject({ kind: 'invalid-response' });
    });

    it('reports a misconfiguration for a chain with no Alchemy network', async () => {
      const { fetchImpl } = createFetchStub(() => rpcResult('0x0'));

      await expect(
        provider().fetchBalances({
          address: TEST_ADDRESS,
          chain: createTestChain({ chainId: 999_999 }),
          context: createTestContext(fetchImpl),
        }),
      ).rejects.toMatchObject({ kind: 'misconfigured' });
    });

    it('reports support only for chains it has a network mapping for', () => {
      expect(provider().supportsChain(1)).toBe(true);
      expect(provider().supportsChain(8453)).toBe(true);
      // Polygon is not in the registry, so no Alchemy network is mapped for it.
      expect(provider().supportsChain(137)).toBe(false);
    });
  });
});
