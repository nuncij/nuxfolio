import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import type { AaveMarket } from '@/config/aaveMarkets';
import type { WalletAddress } from '@/domain/address';
import { TEST_ADDRESS } from '@/test/helpers';

import type { RpcRequester } from '../balances/jsonRpc';

import { readMarketReserves } from './aaveReserves';

/**
 * Shapes captured from Ethereum mainnet on 2026-08-07 for the borrower
 * `0xF635aaEE…7054`, whose real position — WETH supplied as collateral, three
 * stablecoins borrowed — is what these fixtures reproduce.
 */
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const UNUSED = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

const LIVE = {
  wethScaledSupply: 8_496_366_850_973_757_592n,
  wethNormalizedIncome: 1_069_080_262_391_984_523_210_524_747n,
  wethActualBalance: 9_083_298_102_417_584_030n,
  usdcScaledDebt: 540_434_395n,
  usdcNormalizedDebt: 1_243_154_843_239_071_624_484_283_260n,
  usdcActualDebt: 671_843_636n,
};

const MARKET: AaveMarket = {
  marketId: '1:core',
  name: 'Aave v3 Core',
  chainId: 1,
  poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as WalletAddress,
  baseCurrencyDecimals: 8,
  detail: {
    addressesProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e' as WalletAddress,
    uiPoolDataProvider: '0x3F78BBD206e4D3c504Eb854232EdA7e47E9Fd8FC' as WalletAddress,
  },
  verifiedOn: '2026-08-06',
};

const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11' as WalletAddress;

type Reserve = {
  asset: string;
  scaledSupply: bigint;
  collateral: boolean;
  scaledDebt: bigint;
};

function encodeUserReserves(reserves: readonly Reserve[]): string {
  return encodeAbiParameters(parseAbiParameters('(address,uint256,bool,uint256)[], uint8'), [
    reserves.map(
      (r) => [r.asset as `0x${string}`, r.scaledSupply, r.collateral, r.scaledDebt] as const,
    ),
    0,
  ]);
}

function encodeIndexBatch(pairs: readonly (readonly [bigint, bigint])[]): string {
  const results = pairs.flatMap(([income, debt]) => [
    { success: true, returnData: `0x${income.toString(16).padStart(64, '0')}` as `0x${string}` },
    { success: true, returnData: `0x${debt.toString(16).padStart(64, '0')}` as `0x${string}` },
  ]);
  return encodeAbiParameters(parseAbiParameters('(bool,bytes)[]'), [
    results.map((r) => [r.success, r.returnData] as const),
  ]);
}

/**
 * Answers the calls the reader makes, in order.
 *
 * Returns the mock itself so a test can read `mock.calls.length` — an earlier
 * version exposed a `calls` getter through `Object.assign`, which copies the
 * getter's *value* at assignment and therefore always reported zero.
 */
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

describe('readMarketReserves', () => {
  it('turns scaled balances into the amounts the protocol reports', async () => {
    const requester = stubRequester([
      encodeUserReserves([
        { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: true, scaledDebt: 0n },
        { asset: USDC, scaledSupply: 0n, collateral: false, scaledDebt: LIVE.usdcScaledDebt },
      ]),
      encodeIndexBatch([
        [LIVE.wethNormalizedIncome, 0n],
        [0n, LIVE.usdcNormalizedDebt],
      ]),
    ]);

    const positions = await readMarketReserves({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    // The amounts a cross-check against the aToken and debt token confirmed live.
    expect(positions).toEqual([
      {
        underlyingAsset: WETH,
        supplied: LIVE.wethActualBalance,
        borrowed: 0n,
        usedAsCollateral: true,
      },
      {
        underlyingAsset: USDC,
        supplied: 0n,
        borrowed: LIVE.usdcActualDebt,
        usedAsCollateral: false,
      },
    ]);
  });

  it('takes two calls, never one per reserve', async () => {
    const requester = stubRequester([
      encodeUserReserves([
        { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: true, scaledDebt: 0n },
        { asset: USDC, scaledSupply: 0n, collateral: false, scaledDebt: LIVE.usdcScaledDebt },
      ]),
      encodeIndexBatch([
        [LIVE.wethNormalizedIncome, 0n],
        [0n, LIVE.usdcNormalizedDebt],
      ]),
    ]);

    await readMarketReserves({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    expect(requester.mock.calls).toHaveLength(2);
  });

  it('ignores the reserves the wallet has never touched', async () => {
    // Ethereum Core returns all 67 reserves whether or not the wallet uses them.
    // Sizing the index batch by the market rather than by the position would make
    // the second call 34 times larger for no gain.
    const requester = stubRequester([
      encodeUserReserves([
        { asset: UNUSED, scaledSupply: 0n, collateral: false, scaledDebt: 0n },
        { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: true, scaledDebt: 0n },
      ]),
      encodeIndexBatch([[LIVE.wethNormalizedIncome, 0n]]),
    ]);

    const positions = await readMarketReserves({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    expect(positions.map((p) => p.underlyingAsset)).toEqual([WETH]);
  });

  it('makes no second call at all when the wallet uses the market for nothing', async () => {
    const requester = stubRequester([
      encodeUserReserves([{ asset: UNUSED, scaledSupply: 0n, collateral: false, scaledDebt: 0n }]),
    ]);

    const positions = await readMarketReserves({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    expect(positions).toEqual([]);
    expect(requester.mock.calls).toHaveLength(1);
  });

  it('keeps a supply whose collateral switch is off', async () => {
    // This is the position `getUserAccountData` cannot see, and the reason the
    // account total and the summed supplies can legitimately disagree.
    const requester = stubRequester([
      encodeUserReserves([
        { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: false, scaledDebt: 0n },
      ]),
      encodeIndexBatch([[LIVE.wethNormalizedIncome, 0n]]),
    ]);

    const [position] = await readMarketReserves({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    expect(position).toMatchObject({ supplied: LIVE.wethActualBalance, usedAsCollateral: false });
  });

  it('refuses a market with no verified detail provider', async () => {
    // Optimism and BNB are in this state. Reading them through a guessed provider
    // would decode into plausible rubbish; refusing says the true thing.
    const { detail: _dropped, ...withoutDetail } = MARKET;

    await expect(
      readMarketReserves({
        address: TEST_ADDRESS,
        market: withoutDetail,
        multicallAddress: MULTICALL,
        requester: stubRequester([]),
      }),
    ).rejects.toThrow(/no verified detail provider/);
  });

  it('fails rather than reporting an unscalable balance', async () => {
    // A missing index cannot be worked around: a scaled balance shown as an amount
    // is wrong by orders of magnitude, not by a rounding unit.
    const requester = stubRequester([
      encodeUserReserves([
        { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: true, scaledDebt: 0n },
      ]),
      encodeAbiParameters(parseAbiParameters('(bool,bytes)[]'), [
        [[false, '0x'] as const, [false, '0x'] as const],
      ]),
    ]);

    await expect(
      readMarketReserves({
        address: TEST_ADDRESS,
        market: MARKET,
        multicallAddress: MULTICALL,
        requester,
      }),
    ).rejects.toThrow(/no normalized index/);
  });

  it('rejects a batch whose length does not match what it asked for', async () => {
    const requester = stubRequester([
      encodeUserReserves([
        { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: true, scaledDebt: 0n },
      ]),
      encodeIndexBatch([]),
    ]);

    await expect(
      readMarketReserves({
        address: TEST_ADDRESS,
        market: MARKET,
        multicallAddress: MULTICALL,
        requester,
      }),
    ).rejects.toThrow(/results for/);
  });
});
