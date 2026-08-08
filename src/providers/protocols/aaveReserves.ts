import 'server-only';

import { decodeAbiParameters, decodeFunctionResult, encodeFunctionData, type Hex } from 'viem';

import type { AaveMarket } from '@/config/aaveMarkets';
import type { WalletAddress } from '@/domain/address';
import { rayMulDebt, rayMulSupply } from '@/domain/rayMath';

import type { RpcRequester } from '../balances/jsonRpc';
import { ProviderError } from '../types';

import { aggregate3, decodeAddress, decodeSymbol } from './multicall';

/**
 * Which assets a wallet supplied and borrowed, per market, and what each is worth.
 *
 * M5-1 answers "how much"; this answers "of what". Two calls per market, unchanged
 * from the amounts-only version:
 *
 *  1. `UiPoolDataProvider.getUserReservesData` — every reserve in the market with the
 *     wallet's **scaled** balances — alongside `getPriceOracle()`. Fixed cost: the
 *     first returns all 67 reserves on Ethereum Core whether the wallet uses them or
 *     not, and the oracle rides along for free rather than being configured.
 *  2. One `Multicall3` batch covering **only the reserves with a balance** — usually a
 *     handful. Per reserve it asks for the two normalized indices that turn a scaled
 *     balance into a real one (see `domain/rayMath.ts`), plus `decimals()` and
 *     `symbol()`; and once for the whole set, `AaveOracle.getAssetsPrices`.
 *
 * **The price comes from the market's own oracle**, not from the app's price provider.
 * That is what makes a row reconcile with the market total beside it: measured on
 * 2026-08-07 across four blocks, the rows summed to `getUserAccountData`'s collateral
 * and debt to **zero base units**. Pricing rows with DefiLlama instead would put a
 * breakdown under a headline it cannot add up to, off by a different fraction of a
 * percent every block — see ADR-027.
 *
 * `decimals` and `symbol` are read from the token itself rather than joined against the
 * bundled list, so an unlisted underlying is shown properly instead of being assumed to
 * have 18 decimals.
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
/** `decimals()` */
const DECIMALS = '0x313ce567';
/** `symbol()` */
const SYMBOL = '0x95d89b41';
/** `getPriceOracle()` on the market's `PoolAddressesProvider`. */
const PRICE_ORACLE = '0xfca513a8';
/** `getReserveAToken(address)` — the receipt token, for spotting a double count. */
const RESERVE_ATOKEN = '0xcff027d9';

/**
 * Every selector above, keyed by the signature it claims to be.
 *
 * Exported only so a test can hash each signature and compare. That test exists because
 * this constant block shipped with an invented `getPriceOracle()` selector — hardcoding
 * four correct ones is no evidence at all about the fifth.
 */
export const SELECTORS: Readonly<Record<string, string>> = {
  'getReserveNormalizedIncome(address)': NORMALIZED_INCOME,
  'getReserveNormalizedVariableDebt(address)': NORMALIZED_DEBT,
  'decimals()': DECIMALS,
  'symbol()': SYMBOL,
  'getPriceOracle()': PRICE_ORACLE,
  'getReserveAToken(address)': RESERVE_ATOKEN,
};

/** Sub-calls per active reserve: income, debt, decimals, symbol, aToken. */
const CALLS_PER_RESERVE = 5;

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

const oracleAbi = [
  {
    type: 'function',
    name: 'getAssetsPrices',
    stateMutability: 'view',
    inputs: [{ name: 'assets', type: 'address[]' }],
    outputs: [{ type: 'uint256[]' }],
  },
] as const;

/** One asset a wallet has a position in, in base units of that asset. */
export type ReservePosition = {
  readonly underlyingAsset: string;
  /** The token's own symbol, or null when it has none that can be read. */
  readonly symbol: string | null;
  readonly decimals: number;
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
  /**
   * The receipt token this supply is held as. It is often in the wallet's own asset
   * list under a name like "Aave v3 WETH", where it is already counted in the
   * portfolio total — so netting debt against that total needs this address to know
   * what to subtract (ADR-029).
   */
  readonly aTokenAddress: string;
  /**
   * The market oracle's price, in the market's base-currency unit. Null when the
   * oracle answered zero — a broken feed, which must render as "no price" rather than
   * turn a collateral position into a worthless one.
   */
  readonly priceBase: bigint | null;
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

  const { reserves, priceOracle } = await readUserReserves({
    address,
    addressesProvider: market.addressesProvider,
    uiPoolDataProvider: market.detail.uiPoolDataProvider,
    multicallAddress,
    requester,
  });

  // Only reserves the wallet actually touches. On Ethereum Core that turns 67 into
  // a handful, and the batch below is sized by this rather than by the market.
  const active = reserves.filter(
    (reserve) => reserve.scaledATokenBalance > 0n || reserve.scaledVariableDebt > 0n,
  );

  if (active.length === 0) {
    return [];
  }

  const assets = active.map((reserve) => reserve.underlyingAsset);
  const details = await readReserveDetails({
    assets,
    poolAddress: market.poolAddress,
    priceOracle,
    multicallAddress,
    requester,
  });

  return active.map((reserve, position) => {
    const detail = details[position];
    if (detail === undefined) {
      throw new ProviderError(
        'invalid-response',
        PROVIDER_ID,
        `no detail for ${reserve.underlyingAsset}`,
      );
    }
    return {
      underlyingAsset: reserve.underlyingAsset,
      symbol: detail.symbol,
      decimals: detail.decimals,
      supplied: rayMulSupply(reserve.scaledATokenBalance, detail.income),
      borrowed: rayMulDebt(reserve.scaledVariableDebt, detail.debt),
      usedAsCollateral: reserve.usageAsCollateralEnabledOnUser,
      aTokenAddress: detail.aTokenAddress,
      priceBase: detail.priceBase,
    };
  });
}

/**
 * The wallet's scaled balances, and the address of the oracle that prices them.
 *
 * Both in one `aggregate3`, so deriving the oracle costs no extra round trip. It is
 * derived rather than configured on purpose: a pool address that goes stale stops
 * answering and the read fails loudly, but a stale *oracle* keeps returning plausible
 * prices from a market nobody is using any more — the rows would still look right and
 * would quietly stop adding up to the headline (review round 13). Asking the market's
 * own addresses provider makes that impossible instead of merely unlikely.
 */
async function readUserReserves(input: {
  address: WalletAddress;
  addressesProvider: WalletAddress;
  uiPoolDataProvider: WalletAddress;
  multicallAddress: string;
  requester: RpcRequester;
}): Promise<{
  reserves: readonly {
    underlyingAsset: string;
    scaledATokenBalance: bigint;
    usageAsCollateralEnabledOnUser: boolean;
    scaledVariableDebt: bigint;
  }[];
  priceOracle: string;
}> {
  const { address, addressesProvider, uiPoolDataProvider, multicallAddress, requester } = input;

  const results = await aggregate3(
    requester,
    multicallAddress,
    [
      {
        target: uiPoolDataProvider,
        allowFailure: false,
        callData: encodeFunctionData({
          abi: userReservesAbi,
          functionName: 'getUserReservesData',
          args: [addressesProvider, address],
        }),
      },
      { target: addressesProvider, allowFailure: false, callData: PRICE_ORACLE },
    ],
    PROVIDER_ID,
  );

  const [userData, oracle] = results;
  if (userData?.success !== true || oracle?.success !== true) {
    throw new ProviderError('unavailable', PROVIDER_ID, 'the market did not answer');
  }

  const [reserves] = decodeFunctionResult({
    abi: userReservesAbi,
    functionName: 'getUserReservesData',
    data: userData.returnData,
  });

  return { reserves, priceOracle: decodeAddress(oracle.returnData, PROVIDER_ID) };
}

type ReserveDetail = {
  readonly income: bigint;
  readonly debt: bigint;
  readonly decimals: number;
  readonly symbol: string | null;
  readonly aTokenAddress: string;
  readonly priceBase: bigint | null;
};

/**
 * Everything a row needs beyond the scaled balances, in one `aggregate3`.
 *
 * `allowFailure` is false for all of it except `symbol()`. An index that did not
 * answer leaves a balance unscalable and a missing `decimals` leaves it unrenderable —
 * both are wrong-by-orders-of-magnitude rather than partial, so the caller must hear a
 * failure. A name is the one part a row can do without: MKR, one of the 80 Ethereum
 * reserves, returns `bytes32` rather than a string, so insisting on a name would fail
 * an entire market for any wallet holding it.
 */
async function readReserveDetails(input: {
  assets: readonly string[];
  poolAddress: string;
  priceOracle: string;
  multicallAddress: string;
  requester: RpcRequester;
}): Promise<readonly ReserveDetail[]> {
  const { assets, poolAddress, priceOracle, multicallAddress, requester } = input;

  const calls = [
    {
      target: priceOracle as Hex,
      allowFailure: false,
      callData: encodeFunctionData({
        abi: oracleAbi,
        functionName: 'getAssetsPrices',
        args: [assets as readonly Hex[]],
      }),
    },
    ...assets.flatMap((asset) => {
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
        { target: asset as Hex, allowFailure: false, callData: DECIMALS as Hex },
        { target: asset as Hex, allowFailure: true, callData: SYMBOL as Hex },
        {
          target: poolAddress as Hex,
          allowFailure: false,
          callData: `${RESERVE_ATOKEN}${padded}` as Hex,
        },
      ];
    }),
  ];

  const results = await aggregate3(requester, multicallAddress, calls, PROVIDER_ID);

  const priceResult = results[0];
  if (priceResult?.success !== true) {
    throw new ProviderError('invalid-response', PROVIDER_ID, 'the market oracle did not answer');
  }
  const [prices] = decodeAbiParameters([{ type: 'uint256[]' }], priceResult.returnData);
  if (prices.length !== assets.length) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      `oracle returned ${prices.length} prices for ${assets.length} assets`,
    );
  }

  return assets.map((asset, position) => {
    const base = 1 + position * CALLS_PER_RESERVE;
    const income = results[base];
    const debt = results[base + 1];
    const decimals = results[base + 2];
    const symbol = results[base + 3];
    const aToken = results[base + 4];

    if (
      income?.success !== true ||
      debt?.success !== true ||
      decimals?.success !== true ||
      aToken?.success !== true
    ) {
      throw new ProviderError(
        'invalid-response',
        PROVIDER_ID,
        `incomplete reserve detail for ${asset}`,
      );
    }

    const price = prices[position] ?? 0n;
    return {
      income: BigInt(income.returnData),
      debt: BigInt(debt.returnData),
      decimals: Number(BigInt(decimals.returnData)),
      symbol: symbol?.success === true ? decodeSymbol(symbol.returnData) : null,
      aTokenAddress: decodeAddress(aToken.returnData, PROVIDER_ID),
      // Zero is the oracle saying it has no opinion, not a token worth nothing.
      priceBase: price === 0n ? null : price,
    };
  });
}
