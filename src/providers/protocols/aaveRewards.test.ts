import {
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toFunctionSelector,
  toHex,
} from 'viem';
import { describe, expect, it, vi } from 'vitest';

import type { AaveMarket } from '@/config/aaveMarkets';
import type { WalletAddress } from '@/domain/address';
import { TEST_ADDRESS } from '@/test/helpers';

import type { RpcRequester } from '../balances/jsonRpc';

import { readMarketRewards, REWARD_SELECTORS } from './aaveRewards';

const MARKET: AaveMarket = {
  marketId: '10:optimism',
  name: 'Aave v3',
  chainId: 10,
  poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD' as WalletAddress,
  baseCurrencyDecimals: 8,
  addressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb' as WalletAddress,
  detail: {
    uiPoolDataProvider: '0x5c5228aC8BC1528482514aF3e27E692495148717' as WalletAddress,
  },
  verifiedOn: '2026-08-08',
};

const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11' as WalletAddress;
const CONTROLLER = '0x929EC64c34a17401F460460D4B9390518E5B473e';
const ORACLE = '0xD81eb3728a631871a7eBBaD631b5f424909f0c77';
const OP = '0x4200000000000000000000000000000000000042';
const USDC = '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85';
const WETH = '0x4200000000000000000000000000000000000006';

const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`;
const addressWord = (a: string) => word(BigInt(a));

function batch(results: readonly (readonly [boolean, `0x${string}`])[]): string {
  return encodeAbiParameters(parseAbiParameters('(bool,bytes)[]'), [results]);
}

const addressList = (items: readonly string[]) =>
  encodeAbiParameters(parseAbiParameters('address[]'), [items as readonly `0x${string}`[]]);

/** The three batches the reader sends, answered in order. */
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

/** Two reserves, so the asset list the reader builds is four tokens. */
const RESERVES = [USDC, WETH];
const ROUND_1 = batch([
  [true, addressWord(CONTROLLER)],
  [true, addressWord(ORACLE)],
  [true, addressList(RESERVES) as `0x${string}`],
]);
const ROUND_2 = batch([
  [true, addressWord('0x1111111111111111111111111111111111111111')],
  [true, addressWord('0x2222222222222222222222222222222222222222')],
  [true, addressWord('0x3333333333333333333333333333333333333333')],
  [true, addressWord('0x4444444444444444444444444444444444444444')],
  [true, addressList([OP]) as `0x${string}`],
]);

function round3(amount: bigint, price: readonly [boolean, `0x${string}`]) {
  return batch([
    [
      true,
      encodeAbiParameters(parseAbiParameters('address[], uint256[]'), [
        [OP as `0x${string}`],
        [amount],
      ]),
    ],
    [true, encodeAbiParameters(parseAbiParameters('string'), ['OP'])],
    [true, word(18n)],
    price,
  ]);
}

describe('readMarketRewards', () => {
  it('reads what the market owes, priced by its own oracle', async () => {
    const requester = stubRequester([
      ROUND_1,
      ROUND_2,
      round3(1_185_243_607_000_000_000_000n, [true, word(8_777_743n)]),
    ]);

    const rewards = await readMarketRewards({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    expect(rewards).toEqual([
      {
        token: OP,
        symbol: 'OP',
        decimals: 18,
        amount: 1_185_243_607_000_000_000_000n,
        priceBase: 8_777_743n,
      },
    ]);
  });

  it('asks about every token in the market, not only the ones the wallet holds', async () => {
    // The measurement this exists for: of eighteen Optimism wallets with unclaimed OP,
    // fourteen would have reported zero from a held-tokens-only list, because accrued
    // rewards are banked per asset and survive a full withdrawal.
    const requester = stubRequester([ROUND_1, ROUND_2, round3(1n, [true, word(1n)])]);

    await readMarketRewards({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    const third = requester.mock.calls[2]?.[0] as { params: [{ data: string }] };
    for (const token of ['1111111111', '2222222222', '3333333333', '4444444444']) {
      expect(third.params[0].data).toContain(token);
    }
  });

  it('reports a reward the oracle cannot price as unpriced, not as worthless', async () => {
    // Four of Ethereum's five reward tokens are aTokens and `getAssetPrice` reverts for
    // every one, so this is the common path rather than the exceptional one.
    const requester = stubRequester([ROUND_1, ROUND_2, round3(5n, [false, '0x'])]);

    const [reward] = await readMarketRewards({
      address: TEST_ADDRESS,
      market: MARKET,
      multicallAddress: MULTICALL,
      requester,
    });

    expect(reward?.priceBase).toBeNull();
    expect(reward?.amount).toBe(5n);
  });

  it('treats a market with no incentives controller as owing nothing', async () => {
    const requester = stubRequester([
      batch([
        [true, word(0n)],
        [true, addressWord(ORACLE)],
        [true, addressList(RESERVES) as `0x${string}`],
      ]),
    ]);

    await expect(
      readMarketRewards({
        address: TEST_ADDRESS,
        market: MARKET,
        multicallAddress: MULTICALL,
        requester,
      }),
    ).resolves.toEqual([]);
    expect(requester.mock.calls).toHaveLength(1);
  });

  it('works on a market that cannot report a position breakdown', async () => {
    // Optimism and BNB have no `UiPoolDataProvider`, and nothing here needs one. Gating
    // rewards on it — which the first version of this did — denied them to the market
    // with the most assets actually emitting: fourteen of Optimism's twenty-eight.
    const { detail: _dropped, ...withoutDetail } = MARKET;

    const rewards = await readMarketRewards({
      address: TEST_ADDRESS,
      market: withoutDetail,
      multicallAddress: MULTICALL,
      requester: stubRequester([ROUND_1, ROUND_2, round3(7n, [true, word(1n)])]),
    });

    expect(rewards).toHaveLength(1);
    expect(rewards[0]?.amount).toBe(7n);
  });

  it('rejects a controller that answers about different rewards than it listed', async () => {
    // Amounts are matched to reward tokens by position, so a mismatched answer would
    // attribute one token's balance to another.
    const requester = stubRequester([
      ROUND_1,
      ROUND_2,
      batch([
        [
          true,
          encodeAbiParameters(parseAbiParameters('address[], uint256[]'), [
            [OP as `0x${string}`, WETH as `0x${string}`],
            [1n, 2n],
          ]),
        ],
        [true, encodeAbiParameters(parseAbiParameters('string'), ['OP'])],
        [true, word(18n)],
        [true, word(1n)],
      ]),
    ]);

    await expect(
      readMarketRewards({
        address: TEST_ADDRESS,
        market: MARKET,
        multicallAddress: MULTICALL,
        requester,
      }),
    ).rejects.toThrow(/2 rewards for 1 configured/);
  });
});

describe('the hardcoded selectors and ids', () => {
  it('are the hash of the signature each one claims to be', () => {
    for (const [signature, selector] of Object.entries(REWARD_SELECTORS)) {
      expect(toFunctionSelector(signature)).toBe(selector);
    }
  });

  it('files the controller under the id the provider really uses', () => {
    // Derived, because the last invented constant in this codebase was a selector that
    // sat among four correct ones and looked fine.
    expect(keccak256(toHex('INCENTIVES_CONTROLLER'))).toBe(
      '0x703c2c8634bed68d98c029c18f310e7f7ec0e5d6342c590190b3cb8b3ba54532',
    );
  });
});
