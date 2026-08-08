import 'server-only';

import { decodeAbiParameters, type Hex } from 'viem';

import type { ConvexDeployment } from '@/config/convex';
import type { WalletAddress } from '@/domain/address';
import type { RawStakedPosition } from '@/domain/stakedPosition';

import type { RpcRequester } from '../balances/jsonRpc';
import { ProviderError } from '../types';

import { aggregate3, decodeSymbol, type Call } from './multicall';

/**
 * What Convex is holding for the wallet.
 *
 * Convex's `Booster` owns a registry of pools; each pool has a `BaseRewardPool` holding
 * the staked Curve LP on the depositor's behalf. So a position is found by asking every
 * reward pool for the wallet's balance — 437 live pools on Ethereum, measured at **75 ms
 * for the whole sweep** in one `Multicall3`.
 *
 * **The registry is cached because it is the same for every wallet.** Reading `poolInfo`
 * per request would double that cost for information that changes only when Convex adds
 * a pool. `poolLength()` rides along in the balance sweep as one extra sub-call, and a
 * change to it invalidates the cache — so a new pool is picked up on the next request
 * rather than at a redeploy, and nothing is stale for longer than one read.
 *
 * **Shut-down pools are skipped.** Convex retires a pool by marking it rather than
 * removing it; 144 of Ethereum's 581 are in that state. A wallet cannot stake into one,
 * and a balance left in one is an unfinished withdrawal rather than a position.
 *
 * **Unclaimed rewards are not read.** A Convex staker earns CRV, CVX and sometimes a
 * third token; CVX is minted on a schedule rather than held, so reporting only what the
 * pool contracts can answer would understate — the shape of mistake M5-4 measured and
 * refused. v1 reports the position and says nothing about rewards; the whole figure is
 * a later piece of work, not a partial one.
 */

const PROVIDER_ID = 'convex';

/** `poolLength()` */
const POOL_LENGTH = '0x081e3eda';
/** `poolInfo(uint256)` */
const POOL_INFO = '0x1526fe27';
/** `balanceOf(address)` */
const BALANCE_OF = '0x70a08231';
/** `decimals()` */
const DECIMALS = '0x313ce567';
/** `symbol()` */
const SYMBOL = '0x95d89b41';

/** Signature to selector, so a test can hash each rather than trust it. */
export const CONVEX_SELECTORS: Readonly<Record<string, string>> = {
  'poolLength()': POOL_LENGTH,
  'poolInfo(uint256)': POOL_INFO,
  'balanceOf(address)': BALANCE_OF,
  'decimals()': DECIMALS,
  'symbol()': SYMBOL,
};

/** Sub-calls per held pool: symbol, decimals. */
const CALLS_PER_HELD = 2;

/** One registry entry, reduced to the parts a position needs. */
type ConvexPool = {
  readonly stakedToken: string;
  readonly rewardPool: string;
};

type Registry = {
  readonly poolLength: bigint;
  readonly pools: readonly ConvexPool[];
};

/**
 * Per chain, and deliberately module-level.
 *
 * The registry is a property of Convex, not of the wallet being looked at, so caching it
 * anywhere narrower would refetch it for every visitor. It is invalidated by
 * `poolLength` rather than by a clock, because the only thing that changes it is a new
 * pool.
 */
const registries = new Map<number, Registry>();

/** Visible for tests: drops the cached pool registries. */
export function resetConvexRegistry(): void {
  registries.clear();
}

const addressWord = (value: string) => value.slice(2).toLowerCase().padStart(64, '0');

/**
 * Reads every Convex position a wallet has on one chain.
 *
 * Throws rather than degrading, like the Aave readers: "Convex could not be read" and
 * "this wallet stakes nothing" are different answers, and the caller decides how each
 * reaches the page.
 */
export async function readConvexPositions(input: {
  address: WalletAddress;
  deployment: ConvexDeployment;
  multicallAddress: WalletAddress;
  requester: RpcRequester;
}): Promise<readonly RawStakedPosition[]> {
  const { address, deployment, multicallAddress, requester } = input;

  const call = (calls: readonly Call[]) =>
    aggregate3(requester, multicallAddress, calls, PROVIDER_ID);

  const balanceCall = (pool: ConvexPool): Call => ({
    target: pool.rewardPool,
    allowFailure: true,
    callData: `${BALANCE_OF}${addressWord(address)}`,
  });

  const cached = registries.get(deployment.chainId);

  // One batch asks the wallet's balance in every known pool *and* whether the registry
  // has grown. On the common path — nothing added since the last read — that is the
  // entire cost of finding a position.
  const sweep = await call([
    { target: deployment.booster, allowFailure: false, callData: POOL_LENGTH },
    ...(cached?.pools ?? []).map(balanceCall),
  ]);

  const poolLength = BigInt(assertSuccess(sweep[0], 'poolLength').returnData);

  let registry = cached;
  let balances: readonly { success: boolean; returnData: Hex }[] = sweep.slice(1);

  if (registry === undefined || registry.poolLength !== poolLength) {
    registry = await readRegistry({ deployment, poolLength, call });
    registries.set(deployment.chainId, registry);
    balances = await call(registry.pools.map(balanceCall));
  }

  const held = registry.pools.flatMap((pool, index) => {
    const balance = balances[index];
    if (balance?.success !== true) {
      return [];
    }
    const amount = BigInt(balance.returnData);
    return amount > 0n ? [{ pool, amount }] : [];
  });

  if (held.length === 0) {
    return [];
  }

  const meta = await call(
    held.flatMap(({ pool }) => [
      { target: pool.stakedToken, allowFailure: true, callData: SYMBOL },
      { target: pool.stakedToken, allowFailure: false, callData: DECIMALS },
    ]),
  );

  return held.map(({ pool, amount }, index) => {
    const symbol = meta[index * CALLS_PER_HELD];
    const decimals = assertSuccess(
      meta[index * CALLS_PER_HELD + 1],
      `decimals for ${pool.stakedToken}`,
    );

    return {
      chainId: deployment.chainId,
      rewardPool: pool.rewardPool,
      stakedToken: pool.stakedToken,
      symbol: symbol?.success === true ? decodeSymbol(symbol.returnData) : null,
      decimals: Number(BigInt(decimals.returnData)),
      amount,
      rewards: [],
    };
  });
}

/**
 * The Booster's registry, minus the pools that are shut down.
 *
 * `allowFailure` is true per entry: one malformed row should cost that pool, not every
 * position the wallet has.
 */
async function readRegistry(input: {
  deployment: ConvexDeployment;
  poolLength: bigint;
  call: (calls: readonly Call[]) => Promise<readonly { success: boolean; returnData: Hex }[]>;
}): Promise<Registry> {
  const results = await input.call(
    Array.from({ length: Number(input.poolLength) }, (_, index) => ({
      target: input.deployment.booster,
      allowFailure: true,
      callData: `${POOL_INFO}${index.toString(16).padStart(64, '0')}`,
    })),
  );

  const pools: ConvexPool[] = [];
  for (const result of results) {
    if (result.success !== true) {
      continue;
    }
    // (lptoken, token, gauge, crvRewards, stash, shutdown)
    const [stakedToken, , , rewardPool, , shutdown] = decodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bool' },
      ],
      result.returnData,
    );
    if (!shutdown) {
      pools.push({ stakedToken, rewardPool });
    }
  }

  return { poolLength: input.poolLength, pools };
}

function assertSuccess(
  result: { success: boolean; returnData: Hex } | undefined,
  what: string,
): { success: boolean; returnData: Hex } {
  if (result?.success !== true) {
    throw new ProviderError('invalid-response', PROVIDER_ID, `no answer for ${what}`);
  }
  return result;
}
