import 'server-only';

import { convexForChain } from '@/config/convex';
import type { WalletAddress } from '@/domain/address';
import type { ProtocolReadStatus } from '@/domain/portfolio';
import type { RawStakedPosition } from '@/domain/stakedPosition';
import { isStaked } from '@/domain/stakedPosition';

import { createRpcRequester } from '../balances/jsonRpc';
import { ProviderError, type ProviderContext } from '../types';

import { readConvexPositions } from './convex';

/**
 * The chain-level entry point, mirroring `readAaveAccounts`.
 *
 * Never throws. A staking read that fails must not cost the page its balances, and
 * "Convex could not be read" reaches the user as a sentence rather than an exception —
 * the same rule every provider in this codebase follows.
 */
export type StakedRead = {
  readonly positions: readonly RawStakedPosition[];
  /**
   * `ok` — read, and an empty list is a confirmed absence.
   * `failed` — asked, no answer.
   * `unavailable` — Convex is not deployed on this chain, or it has no Multicall3.
   */
  readonly status: ProtocolReadStatus;
};

export async function readStakedPositions(input: {
  address: WalletAddress;
  chainId: number;
  multicallAddress: WalletAddress | null;
  rpcUrls: readonly string[];
  context: ProviderContext;
}): Promise<StakedRead> {
  const { address, chainId, multicallAddress, rpcUrls, context } = input;

  const deployment = convexForChain(chainId);
  if (deployment === undefined || multicallAddress === null) {
    return { positions: [], status: 'unavailable' };
  }
  if (context.deadline.hasExpired()) {
    return { positions: [], status: 'failed' };
  }

  try {
    const positions = await readConvexPositions({
      address,
      deployment,
      multicallAddress,
      requester: createRpcRequester({ urls: rpcUrls, providerId: 'convex', context }),
    });
    return { positions: positions.filter(isStaked), status: 'ok' };
  } catch (error) {
    context.logger?.warn('convex.read_failed', {
      chainId,
      errorName: error instanceof Error ? error.name : 'NonError',
      kind: error instanceof ProviderError ? error.kind : 'unknown',
    });
    return { positions: [], status: 'failed' };
  }
}
