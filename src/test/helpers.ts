import type { ChainConfig } from '@/config/chains';
import type { WalletAddress } from '@/domain/address';
import { Deadline } from '@/server/deadline';
import { createLogger, type Logger, type LogLevel } from '@/server/logger';
import type { ProviderContext } from '@/providers/types';

/**
 * Shared test fixtures.
 *
 * Adapters take their `fetch` from the provider context, so every test here
 * supplies its own. Nothing in this suite touches the network: a test that can
 * reach the internet is a test that fails for reasons unrelated to the code.
 */

export const TEST_ADDRESS: WalletAddress = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
export const USDC: WalletAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
export const WETH: WalletAddress = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

export function createTestChain(overrides: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chainId: 1,
    slug: 'ethereum',
    name: 'Ethereum Mainnet',
    shortName: 'Ethereum',
    nativeAsset: { symbol: 'ETH', name: 'Ether', decimals: 18 },
    rpcUrls: ['https://rpc.test.invalid'],
    multicall3Address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    explorerUrl: 'https://etherscan.io',
    tokenList: {
      source: 'https://tokens.test.invalid',
      sourceName: 'Test List',
      sourceVersion: '1.0.0',
      // Relative rather than fixed: a hard-coded date silently crosses the
      // token-list age threshold as the calendar moves, and every provider test
      // would start reporting an aged list. Tests about ageing set their own.
      generatedAt: new Date(Date.now() - 7 * 86_400_000).toISOString(),
      tokens: [
        { address: USDC, name: 'USD Coin', symbol: 'USDC', decimals: 6, logoUrl: null },
        { address: WETH, name: 'Wrapped Ether', symbol: 'WETH', decimals: 18, logoUrl: null },
      ],
    },
    ...overrides,
  };
}

/** A logger that records lines instead of writing them, so tests can assert on output. */
export function createRecordingLogger(level: LogLevel = 'debug', secrets: string[] = []) {
  const lines: string[] = [];
  const logger = createLogger({
    level,
    secrets,
    sink: (_level, line) => lines.push(line),
    now: () => '2026-01-01T00:00:00.000Z',
  });
  return { logger, lines };
}

export function silentLogger(): Logger {
  return createLogger({ level: 'error', sink: () => {} });
}

export function createTestContext(
  fetchImpl: typeof globalThis.fetch,
  overrides: Partial<ProviderContext> = {},
): ProviderContext {
  return {
    deadline: new Deadline(10_000),
    fetch: fetchImpl,
    logger: silentLogger(),
    maxAssets: 400,
    // Same value as the environment default, so adapter tests see the policy a
    // default deployment applies.
    tokenListMaxAgeDays: 60,
    ...overrides,
  };
}

/** Builds a `fetch` stub from a handler, and records every call it receives. */
export function createFetchStub(
  handler: (url: string, init: RequestInit | undefined, callIndex: number) => Response,
) {
  const calls: { url: string; body: unknown }[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    return handler(url, init, calls.length - 1);
  }) as typeof globalThis.fetch;

  return { fetchImpl, calls };
}

export function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** A JSON-RPC 2.0 success envelope. */
export function rpcResult(result: unknown, id = 1): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

/** A JSON-RPC 2.0 error envelope. */
export function rpcError(code: number, message: string, id = 1): Response {
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

/** An `AbortError`, as `fetch` raises when its signal fires. */
export function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}
