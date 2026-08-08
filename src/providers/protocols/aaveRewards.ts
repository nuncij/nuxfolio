import 'server-only';

import { decodeAbiParameters, encodeFunctionData, type Hex } from 'viem';

import type { AaveMarket } from '@/config/aaveMarkets';
import type { WalletAddress } from '@/domain/address';
import type { RawReward } from '@/domain/protocolReward';

import type { RpcRequester } from '../balances/jsonRpc';
import { ProviderError } from '../types';

import { aggregate3, decodeAddress, decodeSymbol } from './multicall';

/**
 * What a lending market owes the wallet in unclaimed incentives.
 *
 * Three `Multicall3` batches, run alongside the position read rather than after it, so
 * the extra work costs round trips in parallel rather than in series:
 *
 *  1. the market's rewards controller, and its list of reserves;
 *  2. the aToken and variable-debt token of **every** reserve;
 *  3. `getAllUserRewards` over all of them, plus the name, decimals and price of each
 *     reward token the market has ever configured.
 *
 * **Every reserve, not only the ones the wallet is using.** That is the expensive part
 * and it is not optional: the controller banks accrued rewards *per asset*, so a wallet
 * that supplied, earned, and then withdrew in full keeps a balance the asset list has to
 * mention to find. Measured on Optimism on 2026-08-08 across forty wallets: eighteen had
 * unclaimed OP, and **fourteen of those would have reported zero** if asked only about
 * the tokens they still hold. One of the fourteen was owed 0.915 OP while holding
 * nothing at all. Passing an empty asset list returns zero, which is how the shortcut
 * was caught before it shipped rather than after.
 *
 * The controller is derived from the market's own `PoolAddressesProvider`, not
 * configured — same reasoning as the price oracle in ADR-027, and measured to match.
 *
 * **This works on all seven markets**, including the two that cannot report a position
 * breakdown. Nothing here touches the `UiPoolDataProvider` those two are missing, and
 * Optimism — one of the two — has the most active emissions of any market registered:
 * fourteen of its twenty-eight tokens were paying out on 2026-08-08.
 */

const PROVIDER_ID = 'aave-v3-rewards';

/** `getAddress(bytes32)` on the `PoolAddressesProvider`. */
const GET_ADDRESS = '0x21f8a721';
/** `keccak256("INCENTIVES_CONTROLLER")` — the id the provider files it under. */
const INCENTIVES_CONTROLLER_ID = '703c2c8634bed68d98c029c18f310e7f7ec0e5d6342c590190b3cb8b3ba54532';
/** `getReservesList()` */
const RESERVES_LIST = '0xd1946dbc';
/** `getReserveAToken(address)` */
const RESERVE_ATOKEN = '0xcff027d9';
/** `getReserveVariableDebtToken(address)` */
const RESERVE_DEBT_TOKEN = '0x365090a0';
/** `getPriceOracle()` on the `PoolAddressesProvider`. */
const PRICE_ORACLE = '0xfca513a8';
/** `getRewardsList()` */
const REWARDS_LIST = '0xb45ac1a9';
/** `getAssetPrice(address)` */
const ASSET_PRICE = '0xb3596f07';
/** `decimals()` */
const DECIMALS = '0x313ce567';
/** `symbol()` */
const SYMBOL = '0x95d89b41';

/** Signature to selector, so a test can hash each one rather than trust it. */
export const REWARD_SELECTORS: Readonly<Record<string, string>> = {
  'getAddress(bytes32)': GET_ADDRESS,
  'getReservesList()': RESERVES_LIST,
  'getReserveAToken(address)': RESERVE_ATOKEN,
  'getReserveVariableDebtToken(address)': RESERVE_DEBT_TOKEN,
  'getPriceOracle()': PRICE_ORACLE,
  'getRewardsList()': REWARDS_LIST,
  'getAssetPrice(address)': ASSET_PRICE,
  'decimals()': DECIMALS,
  'symbol()': SYMBOL,
};

const allUserRewardsAbi = [
  {
    type: 'function',
    name: 'getAllUserRewards',
    stateMutability: 'view',
    inputs: [
      { name: 'assets', type: 'address[]' },
      { name: 'user', type: 'address' },
    ],
    outputs: [{ type: 'address[]' }, { type: 'uint256[]' }],
  },
] as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Sub-calls per reward token in the last batch: symbol, decimals, price. */
const CALLS_PER_REWARD = 3;

/**
 * Reads one market's unclaimed rewards.
 *
 * Throws rather than degrading, like the position reader: the caller decides what a
 * failed reward read means, and it is not the same as "nothing unclaimed".
 */
export async function readMarketRewards(input: {
  address: WalletAddress;
  market: AaveMarket;
  multicallAddress: WalletAddress;
  requester: RpcRequester;
}): Promise<readonly RawReward[]> {
  const { address, market, multicallAddress, requester } = input;

  const call = (calls: Parameters<typeof aggregate3>[2]) =>
    aggregate3(requester, multicallAddress, calls, PROVIDER_ID);

  // 1. Where the incentives live, what prices them, and what the market is made of.
  const [controllerResult, oracleResult, reservesResult] = await call([
    {
      target: market.addressesProvider,
      allowFailure: false,
      callData: `${GET_ADDRESS}${INCENTIVES_CONTROLLER_ID}`,
    },
    { target: market.addressesProvider, allowFailure: false, callData: PRICE_ORACLE },
    { target: market.poolAddress, allowFailure: false, callData: RESERVES_LIST },
  ]);

  const controller = decodeAddress(controllerResult?.returnData, PROVIDER_ID);
  const oracle = decodeAddress(oracleResult?.returnData, PROVIDER_ID);
  if (controller === ZERO_ADDRESS) {
    // A market with no incentives controller has no rewards to owe. Distinct from a
    // read that failed, which throws above.
    return [];
  }

  if (reservesResult?.success !== true) {
    throw new ProviderError('invalid-response', PROVIDER_ID, 'the pool did not list its reserves');
  }
  const [reserves] = decodeAbiParameters([{ type: 'address[]' }], reservesResult.returnData);

  // 2. Every aToken and debt token, because accrued rewards are banked per asset.
  const tokenResults = await call([
    ...reserves.flatMap((reserve) => {
      const padded = reserve.slice(2).toLowerCase().padStart(64, '0');
      return [
        {
          target: market.poolAddress,
          allowFailure: false,
          callData: `${RESERVE_ATOKEN}${padded}`,
        },
        {
          target: market.poolAddress,
          allowFailure: false,
          callData: `${RESERVE_DEBT_TOKEN}${padded}`,
        },
      ];
    }),
    { target: controller, allowFailure: false, callData: REWARDS_LIST },
  ]);

  const rewardsListResult = tokenResults[tokenResults.length - 1];
  const assets = tokenResults.slice(0, -1).map((result) => {
    if (result.success !== true) {
      throw new ProviderError('invalid-response', PROVIDER_ID, 'a reserve token did not answer');
    }
    return `0x${result.returnData.slice(-40)}` as Hex;
  });

  if (rewardsListResult?.success !== true) {
    throw new ProviderError('invalid-response', PROVIDER_ID, 'the controller did not list rewards');
  }
  const [rewardTokens] = decodeAbiParameters([{ type: 'address[]' }], rewardsListResult.returnData);

  if (rewardTokens.length === 0 || assets.length === 0) {
    return [];
  }

  // 3. What is owed, and what each reward token is.
  const results = await call([
    {
      target: controller,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: allUserRewardsAbi,
        functionName: 'getAllUserRewards',
        args: [assets, address],
      }),
    },
    ...rewardTokens.flatMap((token) => [
      { target: token, allowFailure: true, callData: SYMBOL },
      { target: token, allowFailure: false, callData: DECIMALS },
      // Reverts for a reward token the oracle does not cover — four of Ethereum's five
      // are aTokens and none of those price. Allowed to fail, reported as no price.
      {
        target: oracle,
        allowFailure: true,
        callData: `${ASSET_PRICE}${token.slice(2).toLowerCase().padStart(64, '0')}`,
      },
    ]),
  ]);

  const owed = results[0];
  if (owed?.success !== true) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      'the rewards controller did not answer',
    );
  }
  const [claimable, amounts] = decodeAbiParameters(
    [{ type: 'address[]' }, { type: 'uint256[]' }],
    owed.returnData,
  );

  if (claimable.length !== rewardTokens.length || amounts.length !== claimable.length) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      `controller returned ${claimable.length} rewards for ${rewardTokens.length} configured`,
    );
  }

  return rewardTokens.map((token, position) => {
    const base = 1 + position * CALLS_PER_REWARD;
    const symbol = results[base];
    const decimals = results[base + 1];
    const price = results[base + 2];

    if (decimals?.success !== true) {
      throw new ProviderError('invalid-response', PROVIDER_ID, `no decimals for reward ${token}`);
    }

    const priceBase = price?.success === true ? BigInt(price.returnData) : 0n;

    return {
      token,
      symbol: symbol?.success === true ? decodeSymbol(symbol.returnData) : null,
      decimals: Number(BigInt(decimals.returnData)),
      amount: amounts[position] ?? 0n,
      priceBase: priceBase === 0n ? null : priceBase,
    };
  });
}
