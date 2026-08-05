import { encodeAbiParameters, encodeFunctionResult, parseAbiParameters } from 'viem';
import { describe, expect, it } from 'vitest';

import { Deadline } from '@/server/deadline';
import {
  createFetchStub,
  createRecordingLogger,
  createTestChain,
  createTestContext,
  jsonResponse,
  rpcError,
  rpcResult,
  TEST_ADDRESS,
  USDC,
  WETH,
} from '@/test/helpers';

import { ProviderError } from '../types';

import { createRpcTokenListProvider, tokenListAgeWarning } from './rpcTokenList';

/**
 * The aggregate3 signature is restated here rather than imported, so these
 * tests assert the wire format independently of the adapter's own constant. If
 * the adapter's ABI drifts, the encoded fixture stops matching and the tests
 * fail — which is the point.
 */
const aggregate3Abi = [
  {
    type: 'function',
    name: 'aggregate3',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/** Encodes a `uint256` the way an ERC-20 `balanceOf` return value looks. */
function encodeBalance(value: bigint): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters('uint256'), [value]);
}

function encodeMulticall(results: readonly { success: boolean; returnData: `0x${string}` }[]) {
  // aggregate3 has a single output, so `result` is the value itself rather than
  // an array of output values.
  return encodeFunctionResult({
    abi: aggregate3Abi,
    functionName: 'aggregate3',
    result: results.map((result) => ({ ...result })),
  });
}

const ONE_ETH = 1_000_000_000_000_000_000n;
const MS_PER_DAY = 86_400_000;

describe('rpc-token-list balance provider', () => {
  it('reads the native balance and non-zero token balances', async () => {
    const { fetchImpl, calls } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x1bc16d674ec80000') // 2 ETH
        : rpcResult(
            encodeMulticall([
              { success: true, returnData: encodeBalance(1_500_000_000n) }, // 1500 USDC
              { success: true, returnData: encodeBalance(0n) }, // WETH: skipped
            ]),
          ),
    );

    const snapshot = await createRpcTokenListProvider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.balances).toHaveLength(2);
    expect(snapshot.balances[0]).toMatchObject({
      contractAddress: null,
      symbol: 'ETH',
      raw: 2n * ONE_ETH,
    });
    expect(snapshot.balances[1]).toMatchObject({
      contractAddress: USDC,
      symbol: 'USDC',
      decimals: 6,
      raw: 1_500_000_000n,
    });

    // One eth_getBalance plus one aggregate3 for a two-token list.
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body).toMatchObject({ method: 'eth_getBalance' });
    expect(calls[1]?.body).toMatchObject({ method: 'eth_call' });
  });

  it('always reports token-list coverage and says what was not checked', async () => {
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x0')
        : rpcResult(
            encodeMulticall([
              { success: true, returnData: encodeBalance(0n) },
              { success: true, returnData: encodeBalance(0n) },
            ]),
          ),
    );

    const snapshot = await createRpcTokenListProvider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.coverage).toBe('token-list');
    const warning = snapshot.warnings.find((w) => w.code === 'coverage.token-list');
    expect(warning?.message).toContain('2 Ethereum tokens');
    expect(warning?.message).toContain('Test List');
  });

  it('omits a zero native balance rather than listing a 0 ETH holding', async () => {
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x0')
        : rpcResult(
            encodeMulticall([
              { success: true, returnData: encodeBalance(5n) },
              { success: true, returnData: encodeBalance(0n) },
            ]),
          ),
    );

    const snapshot = await createRpcTokenListProvider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.balances.map((balance) => balance.symbol)).toEqual(['USDC']);
  });

  it('treats an empty hex result as zero', async () => {
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x')
        : rpcResult(
            encodeMulticall([
              { success: true, returnData: encodeBalance(0n) },
              { success: true, returnData: encodeBalance(0n) },
            ]),
          ),
    );

    const snapshot = await createRpcTokenListProvider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.balances).toHaveLength(0);
  });

  describe('partial failure', () => {
    it('skips a token whose balanceOf reverted, and keeps the rest', async () => {
      const { fetchImpl } = createFetchStub((_url, _init, index) =>
        index === 0
          ? rpcResult('0x0')
          : rpcResult(
              encodeMulticall([
                { success: false, returnData: '0x' }, // reverting contract
                { success: true, returnData: encodeBalance(ONE_ETH) },
              ]),
            ),
      );

      const snapshot = await createRpcTokenListProvider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl),
      });

      expect(snapshot.balances.map((balance) => balance.symbol)).toEqual(['WETH']);
      expect(snapshot.warnings.map((w) => w.code)).toContain('balances.undecodable');
    });

    it('skips a token that returned undecodable data', async () => {
      const { fetchImpl } = createFetchStub((_url, _init, index) =>
        index === 0
          ? rpcResult('0x0')
          : rpcResult(
              encodeMulticall([
                { success: true, returnData: '0xabcd' }, // too short for a uint256
                { success: true, returnData: encodeBalance(ONE_ETH) },
              ]),
            ),
      );

      const snapshot = await createRpcTokenListProvider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl),
      });

      expect(snapshot.balances.map((balance) => balance.symbol)).toEqual(['WETH']);
      expect(snapshot.warnings.map((w) => w.code)).toContain('balances.undecodable');
    });

    it('keeps the native balance when the whole token batch fails', async () => {
      // A batch failure must degrade to partial data, not to an error page.
      const { fetchImpl } = createFetchStub((_url, _init, index) =>
        index === 0 ? rpcResult('0xde0b6b3a7640000') : jsonResponse({}, { status: 500 }),
      );

      const snapshot = await createRpcTokenListProvider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl),
      });

      expect(snapshot.balances).toHaveLength(1);
      expect(snapshot.balances[0]?.symbol).toBe('ETH');
      expect(snapshot.warnings.find((w) => w.code === 'balances.partial')?.message).toContain(
        '1 of 1 token batches',
      );
    });

    it('fails the request when the native balance cannot be read', async () => {
      // Without the native balance there is no portfolio to show at all.
      const { fetchImpl } = createFetchStub(() => rpcError(-32000, 'node unavailable'));

      await expect(
        createRpcTokenListProvider().fetchBalances({
          address: TEST_ADDRESS,
          chain: createTestChain(),
          context: createTestContext(fetchImpl),
        }),
      ).rejects.toBeInstanceOf(ProviderError);
    });

    it('rejects a multicall result whose length does not match the request', async () => {
      const { fetchImpl } = createFetchStub((_url, _init, index) =>
        index === 0
          ? rpcResult('0x0')
          : rpcResult(encodeMulticall([{ success: true, returnData: encodeBalance(1n) }])),
      );

      const snapshot = await createRpcTokenListProvider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain(),
        context: createTestContext(fetchImpl),
      });

      // Surfaces as a failed batch rather than as a silently short result set.
      expect(snapshot.warnings.map((w) => w.code)).toContain('balances.partial');
    });
  });

  describe('endpoint fallback', () => {
    it('tries the next endpoint when the first is unreachable', async () => {
      const { fetchImpl, calls } = createFetchStub((url) =>
        url.includes('primary')
          ? jsonResponse({}, { status: 502 })
          : rpcResult('0xde0b6b3a7640000'),
      );

      const chain = createTestChain({
        rpcUrls: ['https://primary.invalid', 'https://secondary.invalid'],
        tokenList: { ...createTestChain().tokenList, tokens: [] },
      });

      const snapshot = await createRpcTokenListProvider().fetchBalances({
        address: TEST_ADDRESS,
        chain,
        context: createTestContext(fetchImpl),
      });

      expect(snapshot.balances).toHaveLength(1);
      expect(calls.some((call) => call.url.includes('secondary'))).toBe(true);
    });

    it('falls over to the next endpoint when the first returns a malformed body', async () => {
      // A captive portal or proxy error page is specific to one endpoint, so the
      // healthy secondary must still be tried.
      const { fetchImpl, calls } = createFetchStub((url) =>
        url.includes('primary')
          ? new Response('<html>proxy error</html>', { status: 200 })
          : rpcResult('0xde0b6b3a7640000'),
      );

      const snapshot = await createRpcTokenListProvider().fetchBalances({
        address: TEST_ADDRESS,
        chain: createTestChain({
          rpcUrls: ['https://primary.invalid', 'https://secondary.invalid'],
          tokenList: { ...createTestChain().tokenList, tokens: [] },
        }),
        context: createTestContext(fetchImpl),
      });

      expect(snapshot.balances).toHaveLength(1);
      expect(calls.some((call) => call.url.includes('secondary'))).toBe(true);
    });

    it('does not retry a JSON-RPC-level rejection against another endpoint', async () => {
      // Every node would answer identically, so a second call is pure waste.
      const { fetchImpl, calls } = createFetchStub(() => rpcError(-32602, 'invalid params'));

      await expect(
        createRpcTokenListProvider().fetchBalances({
          address: TEST_ADDRESS,
          chain: createTestChain({
            rpcUrls: ['https://a.invalid', 'https://b.invalid'],
          }),
          context: createTestContext(fetchImpl),
        }),
      ).rejects.toMatchObject({ kind: 'invalid-response' });

      expect(calls).toHaveLength(1);
    });

    it('never names a configured endpoint URL in an error or a log line', async () => {
      // A keyed RPC URL carries its credential in the path, where redaction
      // cannot tell a secret from a route segment. So URLs are not logged at all.
      const CREDENTIAL = 'super-secret-rpc-credential';
      const { fetchImpl } = createFetchStub(() => jsonResponse({}, { status: 500 }));
      const { logger, lines } = createRecordingLogger('debug');

      const error = await createRpcTokenListProvider()
        .fetchBalances({
          address: TEST_ADDRESS,
          chain: createTestChain({
            rpcUrls: [`https://rpc.example.invalid/v2/${CREDENTIAL}`],
          }),
          context: createTestContext(fetchImpl, { logger }),
        })
        .then(
          () => {
            throw new Error('Expected the request to fail');
          },
          (caught: unknown) => caught as Error,
        );

      expect(error.message).not.toContain(CREDENTIAL);
      expect(error.message).not.toContain('rpc.example.invalid');
      expect(error.message).toContain('endpoint 1');
      expect(lines.join('\n')).not.toContain(CREDENTIAL);
      expect(lines.join('\n')).not.toContain('rpc.example.invalid');
    });

    it('reports a misconfiguration when no endpoint is configured', async () => {
      const { fetchImpl } = createFetchStub(() => rpcResult('0x0'));

      await expect(
        createRpcTokenListProvider().fetchBalances({
          address: TEST_ADDRESS,
          chain: createTestChain({ rpcUrls: [] }),
          context: createTestContext(fetchImpl),
        }),
      ).rejects.toMatchObject({ kind: 'misconfigured' });
    });
  });

  it('stops scanning batches once the deadline is spent, keeping what it has', async () => {
    const { fetchImpl, calls } = createFetchStub(() => rpcResult('0xde0b6b3a7640000'));

    // A deadline that still permits an individual attempt but reports itself as
    // spent: exactly the state the scan loop must notice between batches.
    const spentDeadline = Object.assign(Object.create(Deadline.prototype) as Deadline, {
      remainingMs: () => 5_000,
      timeoutForAttempt: () => 5_000,
      hasExpired: () => true,
    });

    const snapshot = await createRpcTokenListProvider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl, { deadline: spentDeadline }),
    });

    // The native read happened; the token batch was abandoned before its call.
    expect(calls).toHaveLength(1);
    expect(snapshot.balances[0]?.symbol).toBe('ETH');
    expect(snapshot.warnings.find((w) => w.code === 'balances.deadline')?.message).toContain(
      '1 of 1 batches unchecked',
    );
  });

  it('reads only the native balance when the chain has no Multicall3', async () => {
    const { fetchImpl, calls } = createFetchStub(() => rpcResult('0xde0b6b3a7640000'));

    const snapshot = await createRpcTokenListProvider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain({ multicall3Address: null }),
      context: createTestContext(fetchImpl),
    });

    expect(calls).toHaveLength(1);
    expect(snapshot.warnings.map((w) => w.code)).toContain('balances.no_multicall');
  });

  describe('token-list freshness', () => {
    /** A chain whose bundled list was generated `ageDays` ago. */
    function agedChain(ageDays: number) {
      const base = createTestChain();
      return createTestChain({
        tokenList: {
          ...base.tokenList,
          generatedAt: new Date(Date.now() - ageDays * MS_PER_DAY).toISOString(),
        },
      });
    }

    function scan(chain: ReturnType<typeof createTestChain>, maxAgeDays?: number) {
      const { fetchImpl } = createFetchStub((_url, _init, index) =>
        index === 0
          ? rpcResult('0x0')
          : rpcResult(
              encodeMulticall([
                { success: true, returnData: encodeBalance(0n) },
                { success: true, returnData: encodeBalance(0n) },
              ]),
            ),
      );

      return createRpcTokenListProvider().fetchBalances({
        address: TEST_ADDRESS,
        chain,
        context: createTestContext(
          fetchImpl,
          maxAgeDays === undefined ? {} : { tokenListMaxAgeDays: maxAgeDays },
        ),
      });
    }

    it('says nothing about a list generated within the maximum age', async () => {
      const snapshot = await scan(agedChain(10));
      expect(snapshot.warnings.map((w) => w.code)).not.toContain('coverage.token-list-aged');
    });

    it('says nothing at exactly the maximum age, which is not yet older than it', async () => {
      const snapshot = await scan(agedChain(60), 60);
      expect(snapshot.warnings.map((w) => w.code)).not.toContain('coverage.token-list-aged');
    });

    it('warns one day past the maximum age, naming the network and the age', async () => {
      const snapshot = await scan(agedChain(61), 60);
      const warning = snapshot.warnings.find((w) => w.code === 'coverage.token-list-aged');

      expect(warning?.message).toBe(
        'The Ethereum token list bundled with this deployment is 61 days old; recently listed tokens may be missing.',
      );
    });

    it('follows the configured maximum rather than a constant of its own', async () => {
      const chain = agedChain(20);

      expect((await scan(chain, 10)).warnings.map((w) => w.code)).toContain(
        'coverage.token-list-aged',
      );
      expect((await scan(chain, 30)).warnings.map((w) => w.code)).not.toContain(
        'coverage.token-list-aged',
      );
    });

    it('keeps the aged warning separate from the coverage warning', async () => {
      // The aggregate view merges `coverage.token-list` across chains and passes
      // everything else through, so the two must not share a code.
      const codes = (await scan(agedChain(100), 60)).warnings.map((w) => w.code);
      expect(codes).toContain('coverage.token-list');
      expect(codes).toContain('coverage.token-list-aged');
    });
  });

  describe('tokenListAgeWarning', () => {
    const NOW = Date.parse('2026-07-30T00:00:00.000Z');

    function chainWith(generatedAt: string) {
      return { shortName: 'Base', tokenList: { ...createTestChain().tokenList, generatedAt } };
    }

    it('reports whole days, ignoring the hours either side of the boundary', () => {
      const warning = tokenListAgeWarning({
        chain: chainWith('2026-05-01T23:00:00.000Z'),
        maxAgeDays: 60,
        now: NOW,
      });

      expect(warning?.message).toContain('Base token list');
      expect(warning?.message).toContain('89 days old');
    });

    it('stays silent for a list generated in the future, rather than reporting a negative age', () => {
      // Clock skew between build and deployment host, not something to report.
      expect(
        tokenListAgeWarning({
          chain: chainWith('2026-08-30T00:00:00.000Z'),
          maxAgeDays: 60,
          now: NOW,
        }),
      ).toBeNull();
    });

    it('stays silent when the timestamp is not parseable, since that is a generator defect', () => {
      expect(
        tokenListAgeWarning({ chain: chainWith('whenever'), maxAgeDays: 60, now: NOW }),
      ).toBeNull();
    });
  });

  it('accepts every positive chain id, so a new chain needs no code change', () => {
    const provider = createRpcTokenListProvider();
    expect(provider.supportsChain(1)).toBe(true);
    expect(provider.supportsChain(8453)).toBe(true);
    expect(provider.supportsChain(0)).toBe(false);
    expect(provider.supportsChain(-1)).toBe(false);
  });

  it('exposes WETH metadata from the token list, not from the chain', async () => {
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? rpcResult('0x0')
        : rpcResult(
            encodeMulticall([
              { success: true, returnData: encodeBalance(0n) },
              { success: true, returnData: encodeBalance(ONE_ETH / 2n) },
            ]),
          ),
    );

    const snapshot = await createRpcTokenListProvider().fetchBalances({
      address: TEST_ADDRESS,
      chain: createTestChain(),
      context: createTestContext(fetchImpl),
    });

    expect(snapshot.balances[0]).toMatchObject({
      contractAddress: WETH,
      name: 'Wrapped Ether',
      decimals: 18,
    });
  });
});
