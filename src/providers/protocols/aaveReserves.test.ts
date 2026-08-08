import { encodeAbiParameters, parseAbiParameters, stringToHex, toFunctionSelector } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import type { AaveMarket } from '@/config/aaveMarkets';
import type { WalletAddress } from '@/domain/address';
import { TEST_ADDRESS } from '@/test/helpers';

import type { RpcRequester } from '../balances/jsonRpc';

import { readMarketReserves, SELECTORS } from './aaveReserves';

/**
 * Shapes captured from Ethereum mainnet at block 25703367 for the borrower
 * `0xF635aaEE…7054`, whose real position — WETH supplied as collateral, three
 * stablecoins borrowed — is what these fixtures reproduce.
 */
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const UNUSED = '0x6B175474E89094C44Da98b954EedeAC495271d0F';

const LIVE = {
  wethScaledSupply: 8_496_366_850_973_757_592n,
  wethNormalizedIncome: 1_069_082_747_211_127_648_702_419_695n,
  wethActualBalance: 9_083_319_214_352_582_347n,
  wethPrice: 192_969_208_343n,
  usdcScaledDebt: 540_434_395n,
  usdcNormalizedDebt: 1_243_162_740_365_591_651_132_069_410n,
  usdcActualDebt: 671_847_904n,
  usdcPrice: 99_982_000n,
};

const MARKET: AaveMarket = {
  marketId: '1:core',
  name: 'Aave v3 Core',
  chainId: 1,
  poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as WalletAddress,
  baseCurrencyDecimals: 8,
  addressesProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e' as WalletAddress,
  detail: {
    uiPoolDataProvider: '0x3F78BBD206e4D3c504Eb854232EdA7e47E9Fd8FC' as WalletAddress,
  },
  verifiedOn: '2026-08-07',
};

const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11' as WalletAddress;
const ORACLE = '0x54586bE62E3c3580375aE3723C145253060Ca0C2';

type Reserve = {
  asset: string;
  scaledSupply: bigint;
  collateral: boolean;
  scaledDebt: bigint;
};

/** One reserve's four sub-calls, in the order the reader lays them out. */
type Detail = {
  income: bigint;
  debt: bigint;
  decimals: number;
  /** A string encodes as an ABI string; a `Hex` goes on the wire verbatim. */
  symbol: string | `0x${string}` | null;
};

/** The first call: the wallet's scaled balances and the market's own oracle address. */
function encodeUserReserves(reserves: readonly Reserve[], oracle: string = ORACLE): string {
  const userData = encodeAbiParameters(
    parseAbiParameters('(address,uint256,bool,uint256)[], uint8'),
    [
      reserves.map(
        (r) => [r.asset as `0x${string}`, r.scaledSupply, r.collateral, r.scaledDebt] as const,
      ),
      0,
    ],
  );

  return encodeAbiParameters(parseAbiParameters('(bool,bytes)[]'), [
    [
      [true, userData] as const,
      [true, `0x${oracle.slice(2).toLowerCase().padStart(64, '0')}`] as const,
    ],
  ]);
}

const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`;

function encodeBatch(prices: readonly bigint[], details: readonly Detail[]): string {
  const results: (readonly [boolean, `0x${string}`])[] = [
    [true, encodeAbiParameters(parseAbiParameters('uint256[]'), [[...prices]])],
  ];

  for (const detail of details) {
    results.push([true, word(detail.income)]);
    results.push([true, word(detail.debt)]);
    results.push([true, word(BigInt(detail.decimals))]);
    results.push(
      detail.symbol === null
        ? [false, '0x']
        : [
            true,
            detail.symbol.startsWith('0x')
              ? (detail.symbol as `0x${string}`)
              : encodeAbiParameters(parseAbiParameters('string'), [detail.symbol]),
          ],
    );
  }

  return encodeAbiParameters(parseAbiParameters('(bool,bytes)[]'), [results]);
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

const BORROWER_RESERVES = encodeUserReserves([
  { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: true, scaledDebt: 0n },
  { asset: USDC, scaledSupply: 0n, collateral: false, scaledDebt: LIVE.usdcScaledDebt },
]);

const BORROWER_BATCH = encodeBatch(
  [LIVE.wethPrice, LIVE.usdcPrice],
  [
    { income: LIVE.wethNormalizedIncome, debt: 0n, decimals: 18, symbol: 'WETH' },
    { income: 0n, debt: LIVE.usdcNormalizedDebt, decimals: 6, symbol: 'USDC' },
  ],
);

describe('readMarketReserves', () => {
  it('turns scaled balances into the amounts the protocol reports', async () => {
    const requester = stubRequester([BORROWER_RESERVES, BORROWER_BATCH]);

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
        symbol: 'WETH',
        decimals: 18,
        supplied: LIVE.wethActualBalance,
        borrowed: 0n,
        usedAsCollateral: true,
        priceBase: LIVE.wethPrice,
      },
      {
        underlyingAsset: USDC,
        symbol: 'USDC',
        decimals: 6,
        supplied: 0n,
        borrowed: LIVE.usdcActualDebt,
        usedAsCollateral: false,
        priceBase: LIVE.usdcPrice,
      },
    ]);
  });

  it('takes two calls, never one per reserve', async () => {
    const requester = stubRequester([BORROWER_RESERVES, BORROWER_BATCH]);

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
    // Sizing the batch by the market rather than by the position would make the
    // second call 34 times larger for no gain.
    const requester = stubRequester([
      encodeUserReserves([
        { asset: UNUSED, scaledSupply: 0n, collateral: false, scaledDebt: 0n },
        { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: true, scaledDebt: 0n },
      ]),
      encodeBatch(
        [LIVE.wethPrice],
        [{ income: LIVE.wethNormalizedIncome, debt: 0n, decimals: 18, symbol: 'WETH' }],
      ),
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
      encodeBatch(
        [LIVE.wethPrice],
        [{ income: LIVE.wethNormalizedIncome, debt: 0n, decimals: 18, symbol: 'WETH' }],
      ),
    ]);

    const [position] = await readMarketReserves({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    expect(position).toMatchObject({ supplied: LIVE.wethActualBalance, usedAsCollateral: false });
  });

  it('reads a bytes32 symbol, which is what MKR returns', async () => {
    // One of the 80 Ethereum reserves answers `symbol()` with a bytes32 rather than
    // a string. Insisting on the string shape would fail an entire market's
    // breakdown for any wallet holding it.
    const requester = stubRequester([
      encodeUserReserves([
        { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: true, scaledDebt: 0n },
      ]),
      encodeBatch(
        [LIVE.wethPrice],
        [
          {
            income: LIVE.wethNormalizedIncome,
            debt: 0n,
            decimals: 18,
            symbol: stringToHex('MKR', { size: 32 }),
          },
        ],
      ),
    ]);

    const [position] = await readMarketReserves({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    expect(position?.symbol).toBe('MKR');
  });

  it('keeps the position when the name is the only thing missing', async () => {
    // A row can be shown by address. It cannot be shown without decimals or an
    // index, which is why only this one sub-call is allowed to fail.
    const requester = stubRequester([
      encodeUserReserves([
        { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: true, scaledDebt: 0n },
      ]),
      encodeBatch(
        [LIVE.wethPrice],
        [{ income: LIVE.wethNormalizedIncome, debt: 0n, decimals: 18, symbol: null }],
      ),
    ]);

    const [position] = await readMarketReserves({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    expect(position).toMatchObject({ symbol: null, supplied: LIVE.wethActualBalance });
  });

  it('reports an oracle price of zero as no price, not as worthless', async () => {
    // Aave's oracle answers 0 when a feed is missing. Carrying that through as a
    // price would turn a $17,000 collateral position into a $0 one.
    const requester = stubRequester([
      encodeUserReserves([
        { asset: WETH, scaledSupply: LIVE.wethScaledSupply, collateral: true, scaledDebt: 0n },
      ]),
      encodeBatch(
        [0n],
        [{ income: LIVE.wethNormalizedIncome, debt: 0n, decimals: 18, symbol: 'WETH' }],
      ),
    ]);

    const [position] = await readMarketReserves({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    expect(position).toMatchObject({ priceBase: null, supplied: LIVE.wethActualBalance });
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
        [
          [true, encodeAbiParameters(parseAbiParameters('uint256[]'), [[LIVE.wethPrice]])] as const,
          [false, '0x'] as const,
          [false, '0x'] as const,
          [false, '0x'] as const,
          [false, '0x'] as const,
        ],
      ]),
    ]);

    await expect(
      readMarketReserves({
        address: TEST_ADDRESS,
        market: MARKET,
        multicallAddress: MULTICALL,
        requester,
      }),
    ).rejects.toThrow(/incomplete reserve detail/);
  });

  it('refuses a price list that does not line up with the assets it asked about', async () => {
    // Prices are matched to assets by position. One short, and every row after the
    // gap would be valued with its neighbour's price.
    const requester = stubRequester([
      BORROWER_RESERVES,
      encodeBatch(
        [LIVE.wethPrice],
        [
          { income: LIVE.wethNormalizedIncome, debt: 0n, decimals: 18, symbol: 'WETH' },
          { income: 0n, debt: LIVE.usdcNormalizedDebt, decimals: 6, symbol: 'USDC' },
        ],
      ),
    ]);

    await expect(
      readMarketReserves({
        address: TEST_ADDRESS,
        market: MARKET,
        multicallAddress: MULTICALL,
        requester,
      }),
    ).rejects.toThrow(/1 prices for 2 assets/);
  });

  it('rejects a batch whose length does not match what it asked for', async () => {
    const requester = stubRequester([
      BORROWER_RESERVES,
      encodeAbiParameters(parseAbiParameters('(bool,bytes)[]'), [[]]),
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

describe('the hardcoded selectors', () => {
  it('are the hash of the signature each one claims to be', () => {
    // This file shipped with an invented `getPriceOracle()` selector, sitting in a block
    // where the other four were correct. A call to the wrong selector on a live proxy
    // does not throw a helpful error — it reverts, or worse, hits a fallback.
    for (const [signature, selector] of Object.entries(SELECTORS)) {
      expect(toFunctionSelector(signature)).toBe(selector);
    }
  });
});
