import { encodeAbiParameters, parseAbiParameters, toFunctionSelector } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConvexDeployment } from '@/config/convex';
import type { WalletAddress } from '@/domain/address';
import { TEST_ADDRESS } from '@/test/helpers';

import type { RpcRequester } from '../balances/jsonRpc';

import { CONVEX_SELECTORS, readConvexPositions, resetConvexRegistry } from './convex';

/**
 * Shapes checked against Ethereum on 2026-08-08: the Booster reports 581 pools, of which
 * 437 are live and 144 shut down, every live one with a distinct reward contract. The
 * "wallet holds something" path is covered here rather than live because no free
 * endpoint available to this project will answer `eth_getLogs`, so a real staker could
 * not be found to point the reader at.
 */

const DEPLOYMENT: ConvexDeployment = {
  chainId: 1,
  booster: '0xF403C135812408BFbE8713b5A23a04b3D48AAE31' as WalletAddress,
  verifiedOn: '2026-08-08',
};

const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11' as WalletAddress;

const STE_CRV = '0x06325440D014e39736583c165C2963BA99fAf14E';
const STE_REWARDS = '0x0A760466E1B4621579a82a39CB56Dda2F4E70f03';
const THREE_CRV = '0x9fC689CCaDa600B6DF723D9E47D84d76664a1F23';
const THREE_REWARDS = '0x8B55351ea358e5Eda371575B031ee24F462d503e';
const RETIRED_REWARDS = '0xf34DFF761145FF0B05e917811d488B441F33a968';

const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`;

function batch(results: readonly (readonly [boolean, `0x${string}`])[]): string {
  return encodeAbiParameters(parseAbiParameters('(bool,bytes)[]'), [results]);
}

function poolInfo(lp: string, rewards: string, shutdown: boolean): `0x${string}` {
  return encodeAbiParameters(
    parseAbiParameters('address, address, address, address, address, bool'),
    [
      lp as `0x${string}`,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      rewards as `0x${string}`,
      '0x0000000000000000000000000000000000000000',
      shutdown,
    ],
  );
}

const REGISTRY = batch([
  [true, poolInfo(THREE_CRV, THREE_REWARDS, false)],
  [true, poolInfo(STE_CRV, STE_REWARDS, false)],
  [true, poolInfo(THREE_CRV, RETIRED_REWARDS, true)],
]);

/** The same registry after Convex added a fourth pool. */
const REGISTRY_GROWN = batch([
  [true, poolInfo(THREE_CRV, THREE_REWARDS, false)],
  [true, poolInfo(STE_CRV, STE_REWARDS, false)],
  [true, poolInfo(THREE_CRV, RETIRED_REWARDS, true)],
  [true, poolInfo(STE_CRV, '0x1111111111111111111111111111111111111111', false)],
]);

const text = (value: string) => encodeAbiParameters(parseAbiParameters('string'), [value]);

function stubRequester(responses: readonly string[]) {
  let index = 0;
  return vi.fn(async () => {
    const response = responses[index];
    index += 1;
    if (response === undefined) {
      throw new Error(`unexpected call ${index}`);
    }
    return response;
  }) as ReturnType<typeof vi.fn> & RpcRequester;
}

const read = (requester: RpcRequester) =>
  readConvexPositions({
    address: TEST_ADDRESS,
    deployment: DEPLOYMENT,
    multicallAddress: MULTICALL,
    requester,
  });

beforeEach(() => {
  resetConvexRegistry();
});

describe('readConvexPositions', () => {
  it('finds a position no balance-based read could see', async () => {
    // The whole reason the milestone exists: the LP is owned by Convex's reward
    // contract, so the wallet's own token balances contain nothing at all.
    const requester = stubRequester([
      batch([[true, word(3n)]]),
      REGISTRY,
      batch([
        [true, word(0n)],
        [true, word(12_500_000_000_000_000_000n)],
      ]),
      batch([
        [true, text('steCRV')],
        [true, word(18n)],
      ]),
    ]);

    await expect(read(requester)).resolves.toEqual([
      {
        chainId: 1,
        rewardPool: STE_REWARDS,
        stakedToken: STE_CRV,
        symbol: 'steCRV',
        decimals: 18,
        amount: 12_500_000_000_000_000_000n,
        rewards: [],
      },
    ]);
  });

  it('never sweeps a shut-down pool', async () => {
    // Convex retires a pool by marking it; 144 of Ethereum's 581 are in that state. A
    // balance left in one is an unfinished withdrawal, not a position.
    const requester = stubRequester([
      batch([[true, word(3n)]]),
      REGISTRY,
      batch([
        [true, word(0n)],
        [true, word(0n)],
      ]),
    ]);

    await expect(read(requester)).resolves.toEqual([]);

    const sweep = requester.mock.calls[2]?.[0] as { params: [{ data: string }] };
    expect(sweep.params[0].data.toLowerCase()).not.toContain(
      RETIRED_REWARDS.slice(2).toLowerCase(),
    );
  });

  it('reuses the registry for the next wallet, and still checks it is current', async () => {
    // The registry is Convex's, not the wallet's. Refetching it per visitor would double
    // the cost of the feature for information that changes only when a pool is added.
    const first = stubRequester([
      batch([[true, word(3n)]]),
      REGISTRY,
      batch([
        [true, word(0n)],
        [true, word(0n)],
      ]),
    ]);
    await read(first);

    const second = stubRequester([
      // poolLength rides along with the sweep, so a warm read is one call.
      batch([
        [true, word(3n)],
        [true, word(0n)],
        [true, word(0n)],
      ]),
    ]);
    await expect(read(second)).resolves.toEqual([]);
    expect(second.mock.calls).toHaveLength(1);
  });

  it('refetches the registry when Convex has added a pool', async () => {
    const first = stubRequester([
      batch([[true, word(3n)]]),
      REGISTRY,
      batch([
        [true, word(0n)],
        [true, word(0n)],
      ]),
    ]);
    await read(first);

    const second = stubRequester([
      batch([
        [true, word(4n)],
        [true, word(0n)],
        [true, word(0n)],
      ]),
      REGISTRY_GROWN,
      batch([
        [true, word(0n)],
        [true, word(0n)],
        [true, word(0n)],
      ]),
    ]);
    await read(second);

    // Asked again rather than trusting a length it had already seen change, and the
    // sweep that follows covers the new pool.
    expect(second.mock.calls).toHaveLength(3);
    const sweep = second.mock.calls[2]?.[0] as { params: [{ data: string }] };
    expect(sweep.params[0].data.toLowerCase()).toContain('1111111111111111');
  });

  it('keeps a position whose staked token has no readable symbol', async () => {
    const requester = stubRequester([
      batch([[true, word(3n)]]),
      REGISTRY,
      batch([
        [true, word(0n)],
        [true, word(5n)],
      ]),
      batch([
        [false, '0x'],
        [true, word(18n)],
      ]),
    ]);

    const [position] = await read(requester);

    expect(position).toMatchObject({ symbol: null, amount: 5n });
  });

  it('drops a pool that would not answer, rather than failing the wallet', async () => {
    // One broken reward contract must not cost a staker every other position.
    const requester = stubRequester([
      batch([[true, word(3n)]]),
      REGISTRY,
      batch([
        [false, '0x'],
        [true, word(7n)],
      ]),
      batch([
        [true, text('steCRV')],
        [true, word(18n)],
      ]),
    ]);

    const positions = await read(requester);

    expect(positions).toHaveLength(1);
    expect(positions[0]?.rewardPool).toBe(STE_REWARDS);
  });

  it('fails rather than reporting an amount at the wrong scale', async () => {
    // Without decimals the amount cannot be rendered at all, and guessing 18 would be
    // wrong by a factor of a trillion for a six-decimal LP.
    const requester = stubRequester([
      batch([[true, word(3n)]]),
      REGISTRY,
      batch([
        [true, word(0n)],
        [true, word(5n)],
      ]),
      batch([
        [true, text('steCRV')],
        [false, '0x'],
      ]),
    ]);

    await expect(read(requester)).rejects.toThrow(/no answer for decimals/);
  });
});

describe('the hardcoded selectors', () => {
  it('are the hash of the signature each one claims to be', () => {
    for (const [signature, selector] of Object.entries(CONVEX_SELECTORS)) {
      expect(toFunctionSelector(signature)).toBe(selector);
    }
  });
});
