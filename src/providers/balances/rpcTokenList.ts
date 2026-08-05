import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';

import type { ChainConfig, TokenListEntry } from '@/config/chains';
import type { WalletAddress } from '@/domain/address';
import type { PortfolioCoverage, PortfolioWarning } from '@/domain/portfolio';
import { chunk, mapWithConcurrency } from '@/server/concurrency';
import { describeError } from '@/server/logger';

import {
  ProviderError,
  type BalanceSnapshot,
  type PortfolioProvider,
  type RawBalance,
} from '../types';

import { createRpcRequester, type RpcRequester } from './jsonRpc';

/**
 * Balance discovery over plain JSON-RPC, with no API key.
 *
 * A node cannot answer "which tokens does this address hold" — that needs an
 * index. So this adapter inverts the question: it asks `balanceOf` for every
 * token on a bundled list and keeps the non-zero answers, batched through
 * Multicall3 so 395 reads cost a handful of requests.
 *
 * The trade-off is explicit and permanent: tokens outside the list are
 * invisible. Every snapshot therefore reports `coverage: "token-list"` and
 * carries a warning, so the UI can say what was not checked instead of
 * implying a complete picture. See docs/DECISIONS.md, ADR-004.
 */

const PROVIDER_ID = 'rpc-token-list';

/**
 * Calls per `aggregate3`. 500 `balanceOf` reads is roughly 33 kB of calldata,
 * which public RPC endpoints accept without complaint — measured at ~130 ms per
 * batch, the same as a 100-call batch, because the cost is dominated by the
 * round trip rather than by the calls inside it.
 */
const CALLS_PER_MULTICALL = 500;

/**
 * Batches in flight at once. Sequential batching was fine for a 395-token list
 * but would take roughly ten seconds across 5000 tokens. Four is enough to make
 * a full sweep about one second while staying a considerate client of a shared
 * public endpoint.
 */
const BATCH_CONCURRENCY = 4;

const HEX_QUANTITY = /^0x[0-9a-fA-F]*$/;

const MS_PER_DAY = 86_400_000;

const balanceOfAbi = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
] as const;

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

export function createRpcTokenListProvider(): PortfolioProvider {
  return {
    id: PROVIDER_ID,

    supportsChain(chainId: number): boolean {
      return Number.isInteger(chainId) && chainId > 0;
    },

    async fetchBalances({ address, chain, context }): Promise<BalanceSnapshot> {
      const request = createRpcRequester({
        urls: chain.rpcUrls,
        providerId: PROVIDER_ID,
        context,
      });

      const warnings: PortfolioWarning[] = [];
      const balances: RawBalance[] = [];

      // The native balance is the one read that must succeed: without it there
      // is no portfolio at all, so a failure here is fatal.
      const nativeRaw = await readNativeBalance(request, address);
      if (nativeRaw > 0n) {
        balances.push({
          chainId: chain.chainId,
          contractAddress: null,
          name: chain.nativeAsset.name,
          symbol: chain.nativeAsset.symbol,
          decimals: chain.nativeAsset.decimals,
          raw: nativeRaw,
          logoUrl: null,
        });
      }

      if (chain.multicall3Address === null) {
        warnings.push({
          code: 'balances.no_multicall',
          message: `${chain.shortName} has no Multicall3 deployment configured, so only the native balance was read.`,
        });
        return snapshot(chain.chainId, 'token-list', balances, warnings);
      }

      const tokens = chain.tokenList.tokens;
      const chunks = chunk(tokens, CALLS_PER_MULTICALL);
      let failedChunks = 0;
      let undecodable = 0;
      let skippedChunks = 0;

      const multicallAddress = chain.multicall3Address;

      await mapWithConcurrency(chunks, BATCH_CONCURRENCY, async (tokenChunk, index) => {
        if (context.deadline.hasExpired()) {
          skippedChunks += 1;
          return;
        }

        try {
          const results = await readTokenBalances({
            request,
            multicallAddress,
            owner: address,
            tokens: tokenChunk,
          });

          for (const result of results) {
            if (result.raw === null) {
              undecodable += 1;
              continue;
            }
            if (result.raw > 0n) {
              balances.push({
                chainId: chain.chainId,
                contractAddress: result.token.address,
                name: result.token.name,
                symbol: result.token.symbol,
                decimals: result.token.decimals,
                raw: result.raw,
                logoUrl: result.token.logoUrl,
              });
            }
          }
        } catch (error) {
          // One bad batch must not discard the balances already collected —
          // partial data with a warning beats an error page.
          failedChunks += 1;
          context.logger.warn('balances.chunk_failed', {
            providerId: PROVIDER_ID,
            chainId: chain.chainId,
            chunkIndex: index,
            chunkSize: tokenChunk.length,
            ...describeError(error),
          });
        }
      });

      if (skippedChunks > 0) {
        warnings.push({
          code: 'balances.deadline',
          message: `The balance scan ran out of time with ${skippedChunks} of ${chunks.length} batches unchecked, so some tokens are not shown.`,
        });
      }

      if (failedChunks > 0) {
        warnings.push({
          code: 'balances.partial',
          message: `${failedChunks} of ${chunks.length} token batches could not be read, so some balances may be missing.`,
        });
      }
      if (undecodable > 0) {
        warnings.push({
          code: 'balances.undecodable',
          message: `${undecodable} token contracts returned a balance Nuxfolio could not decode and were skipped.`,
        });
      }

      warnings.push({
        code: 'coverage.token-list',
        message: `Without an indexer API key, Nuxfolio checks a fixed list of ${tokens.length.toLocaleString('en-US')} ${chain.shortName} tokens (${chain.tokenList.sourceName}). Tokens outside that list are not shown.`,
      });

      // A bundled list ages invisibly: nothing fails, the newest tokens simply
      // stop being checked. Saying so is the only way that gap reaches the user.
      const aged = tokenListAgeWarning({ chain, maxAgeDays: context.tokenListMaxAgeDays });
      if (aged !== null) {
        warnings.push(aged);
      }

      // Concurrent batches finish out of order, so impose a stable order here
      // rather than letting network timing decide the payload.
      const ordered = [
        ...balances.filter((balance) => balance.contractAddress === null),
        ...balances
          .filter((balance) => balance.contractAddress !== null)
          .sort((a, b) => (a.contractAddress ?? '').localeCompare(b.contractAddress ?? '')),
      ];

      return snapshot(chain.chainId, 'token-list', ordered, warnings);
    },
  };
}

/**
 * Reports a bundled token list that is older than the configured maximum age.
 *
 * Pure, and exported for its own tests. Two decisions worth stating:
 *
 *  - the age is floored to whole days before the comparison, so a list generated
 *    exactly `maxAgeDays` ago does not warn. The threshold means "older than",
 *    and a few milliseconds of clock drift must not be what decides it;
 *  - a `generatedAt` that is not a parseable timestamp yields no warning. That is
 *    a defect in the generator, not something a visitor can act on, and it must
 *    not be reported as if the list were merely old.
 */
export function tokenListAgeWarning(input: {
  chain: Pick<ChainConfig, 'shortName' | 'tokenList'>;
  maxAgeDays: number;
  now?: number;
}): PortfolioWarning | null {
  const generatedAt = Date.parse(input.chain.tokenList.generatedAt);
  if (Number.isNaN(generatedAt)) {
    return null;
  }

  const ageDays = Math.floor(((input.now ?? Date.now()) - generatedAt) / MS_PER_DAY);
  if (ageDays <= input.maxAgeDays) {
    return null;
  }

  return {
    code: 'coverage.token-list-aged',
    message: `The ${input.chain.shortName} token list bundled with this deployment is ${ageDays} days old; recently listed tokens may be missing.`,
  };
}

async function readNativeBalance(request: RpcRequester, address: WalletAddress): Promise<bigint> {
  const result = await request({ method: 'eth_getBalance', params: [address, 'latest'] });
  return parseHexQuantity(result, 'eth_getBalance');
}

type TokenBalanceResult = { token: TokenListEntry; raw: bigint | null };

async function readTokenBalances(input: {
  request: RpcRequester;
  multicallAddress: WalletAddress;
  owner: WalletAddress;
  tokens: readonly TokenListEntry[];
}): Promise<TokenBalanceResult[]> {
  const { request, multicallAddress, owner, tokens } = input;

  const calls = tokens.map((token) => ({
    target: token.address,
    // Non-standard and self-destructed contracts revert on `balanceOf`; letting
    // them fail individually is the whole point of aggregate3.
    allowFailure: true,
    callData: encodeFunctionData({
      abi: balanceOfAbi,
      functionName: 'balanceOf',
      args: [owner],
    }),
  }));

  const data = encodeFunctionData({
    abi: aggregate3Abi,
    functionName: 'aggregate3',
    args: [calls],
  });

  const raw = await request({
    method: 'eth_call',
    params: [{ to: multicallAddress, data }, 'latest'],
  });

  const decoded = decodeFunctionResult({
    abi: aggregate3Abi,
    functionName: 'aggregate3',
    data: assertHex(raw, 'eth_call'),
  });

  if (decoded.length !== tokens.length) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      `Multicall returned ${decoded.length} results for ${tokens.length} calls`,
    );
  }

  return tokens.map((token, index) => {
    const result = decoded[index];
    if (!result || !result.success) {
      return { token, raw: null };
    }
    try {
      const balance = decodeFunctionResult({
        abi: balanceOfAbi,
        functionName: 'balanceOf',
        data: result.returnData,
      });
      return { token, raw: balance };
    } catch {
      return { token, raw: null };
    }
  });
}

function snapshot(
  chainId: number,
  coverage: PortfolioCoverage,
  balances: readonly RawBalance[],
  warnings: readonly PortfolioWarning[],
): BalanceSnapshot {
  return { providerId: PROVIDER_ID, chainId, coverage, balances, warnings };
}

function assertHex(value: unknown, method: string): Hex {
  if (typeof value !== 'string' || !HEX_QUANTITY.test(value)) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      `${method} did not return a hex string`,
    );
  }
  return value as Hex;
}

function parseHexQuantity(value: unknown, method: string): bigint {
  const hex = assertHex(value, method);
  if (hex === '0x') {
    return 0n;
  }
  return BigInt(hex);
}
