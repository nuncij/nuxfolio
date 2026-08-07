import 'server-only';

import { decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';

import type { AaveMarket } from '@/config/aaveMarkets';
import type { WalletAddress } from '@/domain/address';
import { rayMulDebt, rayMulSupply } from '@/domain/rayMath';

import type { RpcRequester } from '../balances/jsonRpc';
import { ProviderError } from '../types';

/**
 * Which assets a wallet supplied and borrowed, per market.
 *
 * M5-1 answers "how much"; this answers "of what". Two calls per market:
 *
 *  1. `UiPoolDataProvider.getUserReservesData` — every reserve in the market with the
 *     wallet's **scaled** balances. One call, fixed cost: it returns all 67 reserves
 *     on Ethereum Core whether the wallet uses them or not.
 *  2. A `Multicall3` batch of `getReserveNormalizedIncome` and
 *     `getReserveNormalizedVariableDebt` for **only the reserves with a balance** —
 *     usually a handful. Those are the indices that turn a scaled balance into a real
 *     one (see `domain/rayMath.ts` for why the *normalized* ones and not the stored).
 *
 * The struct in step 1 is Aave 3.2's four-field shape, confirmed against the deployed
 * contract. The 3.0 shape — with stable-rate fields — fails to decode, which is how
 * this milestone learned to verify an interface rather than recall it.
 */

const PROVIDER_ID = 'aave-v3-reserves';

/** `getReserveNormalizedIncome(address)` */
const NORMALIZED_INCOME = '0xd15e0053';
/** `getReserveNormalizedVariableDebt(address)` */
const NORMALIZED_DEBT = '0x386497fd';

const userReservesAbi = [
  {
    type: 'function',
    name: 'getUserReservesData',
    stateMutability: 'view',
    inputs: [
      { name: 'provider', type: 'address' },
      { name: 'user', type: 'address' },
    ],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          { name: 'underlyingAsset', type: 'address' },
          { name: 'scaledATokenBalance', type: 'uint256' },
          { name: 'usageAsCollateralEnabledOnUser', type: 'bool' },
          { name: 'scaledVariableDebt', type: 'uint256' },
        ],
      },
      { type: 'uint8' },
    ],
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

/** One asset a wallet has a position in, in base units of that asset. */
export type ReservePosition = {
  readonly underlyingAsset: string;
  /** Real supplied balance, or 0n. Rounded as the aToken rounds. */
  readonly supplied: bigint;
  /** Real variable debt, or 0n. Rounded as the debt token rounds. */
  readonly borrowed: bigint;
  /**
   * Whether this supply backs the wallet's borrowing. A supply with this off is
   * invisible to `getUserAccountData`'s collateral total, which is why the two
   * figures can legitimately disagree.
   */
  readonly usedAsCollateral: boolean;
};

/**
 * Reads one market's per-asset detail.
 *
 * Throws rather than degrading: the caller owns the decision about what a failed
 * detail read means, and it is not the same as a failed account read — totals can
 * be perfectly good while detail is missing.
 */
export async function readMarketReserves(input: {
  address: WalletAddress;
  market: AaveMarket;
  multicallAddress: WalletAddress;
  requester: RpcRequester;
}): Promise<readonly ReservePosition[]> {
  const { address, market, multicallAddress, requester } = input;

  if (market.detail === undefined) {
    throw new ProviderError(
      'misconfigured',
      PROVIDER_ID,
      `${market.marketId} has no verified detail provider`,
    );
  }

  const userData = await requester({
    method: 'eth_call',
    params: [
      {
        to: market.detail.uiPoolDataProvider,
        data: encodeFunctionData({
          abi: userReservesAbi,
          functionName: 'getUserReservesData',
          args: [market.detail.addressesProvider, address],
        }),
      },
      'latest',
    ],
  });

  const [reserves] = decodeFunctionResult({
    abi: userReservesAbi,
    functionName: 'getUserReservesData',
    data: assertHex(userData),
  });

  // Only reserves the wallet actually touches. On Ethereum Core that turns 67 into
  // a handful, and the index batch below is sized by this rather than by the market.
  const active = reserves.filter(
    (reserve) => reserve.scaledATokenBalance > 0n || reserve.scaledVariableDebt > 0n,
  );

  if (active.length === 0) {
    return [];
  }

  const indices = await readNormalizedIndices({
    assets: active.map((reserve) => reserve.underlyingAsset),
    poolAddress: market.poolAddress,
    multicallAddress,
    requester,
  });

  return active.map((reserve) => {
    const index = indices.get(reserve.underlyingAsset.toLowerCase());
    if (index === undefined) {
      // A reserve whose index could not be read cannot be scaled, and a scaled
      // balance shown as an amount would be wrong by orders of magnitude.
      throw new ProviderError(
        'invalid-response',
        PROVIDER_ID,
        `no normalized index for ${reserve.underlyingAsset}`,
      );
    }
    return {
      underlyingAsset: reserve.underlyingAsset,
      supplied: rayMulSupply(reserve.scaledATokenBalance, index.income),
      borrowed: rayMulDebt(reserve.scaledVariableDebt, index.debt),
      usedAsCollateral: reserve.usageAsCollateralEnabledOnUser,
    };
  });
}

/**
 * Both normalized indices for several assets, in one `aggregate3`.
 *
 * `allowFailure` is false: a missing index is not a partial answer, it is an
 * unscalable balance, and the caller needs to hear that as a failure rather than
 * receive a position with a silently wrong amount.
 */
async function readNormalizedIndices(input: {
  assets: readonly string[];
  poolAddress: string;
  multicallAddress: string;
  requester: RpcRequester;
}): Promise<ReadonlyMap<string, { income: bigint; debt: bigint }>> {
  const { assets, poolAddress, multicallAddress, requester } = input;

  const calls = assets.flatMap((asset) => {
    const padded = asset.slice(2).toLowerCase().padStart(64, '0');
    return [
      {
        target: poolAddress as Hex,
        allowFailure: false,
        callData: `${NORMALIZED_INCOME}${padded}` as Hex,
      },
      {
        target: poolAddress as Hex,
        allowFailure: false,
        callData: `${NORMALIZED_DEBT}${padded}` as Hex,
      },
    ];
  });

  const raw = await requester({
    method: 'eth_call',
    params: [
      {
        to: multicallAddress,
        data: encodeFunctionData({ abi: aggregate3Abi, functionName: 'aggregate3', args: [calls] }),
      },
      'latest',
    ],
  });

  const results = decodeFunctionResult({
    abi: aggregate3Abi,
    functionName: 'aggregate3',
    data: assertHex(raw),
  });

  if (results.length !== calls.length) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      `Multicall returned ${results.length} results for ${calls.length} calls`,
    );
  }

  const indices = new Map<string, { income: bigint; debt: bigint }>();
  for (const [position, asset] of assets.entries()) {
    const income = results[position * 2];
    const debt = results[position * 2 + 1];
    if (income?.success !== true || debt?.success !== true) {
      continue;
    }
    indices.set(asset.toLowerCase(), {
      income: BigInt(income.returnData),
      debt: BigInt(debt.returnData),
    });
  }
  return indices;
}

function assertHex(value: unknown): Hex {
  if (typeof value !== 'string' || !value.startsWith('0x')) {
    throw new ProviderError('unavailable', PROVIDER_ID, 'eth_call did not return hex');
  }
  return value as Hex;
}
