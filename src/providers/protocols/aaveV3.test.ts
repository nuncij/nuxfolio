import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import type { AaveMarket } from '@/config/aaveMarkets';
import type { WalletAddress } from '@/domain/address';
import { Deadline } from '@/server/deadline';
import { createTestContext, TEST_ADDRESS } from '@/test/helpers';

import type { RpcRequester } from '../balances/jsonRpc';

import { decodeAccountData, readAaveAccounts } from './aaveV3';

/**
 * The captured shape of a real `getUserAccountData` response, taken from Ethereum
 * mainnet on 2026-08-06 for a wallet with no Aave position. Six words, and the last
 * one is `uint256` max — the no-debt sentinel that would otherwise render as
 * 1.157e+59.
 */
const REAL_EMPTY_RESPONSE =
  '0x' +
  '0'.repeat(64) + // totalCollateralBase
  '0'.repeat(64) + // totalDebtBase
  '0'.repeat(64) + // availableBorrowsBase
  '0'.repeat(64) + // currentLiquidationThreshold
  '0'.repeat(64) + // ltv
  'f'.repeat(64); // healthFactor — uint256 max

/** The same shape with a live borrow: $100,000 collateral, $40,000 debt, HF 1.04. */
const BORROWING_RESPONSE =
  '0x' +
  10_000_000_000_000n.toString(16).padStart(64, '0') +
  4_000_000_000_000n.toString(16).padStart(64, '0') +
  '0'.repeat(64) +
  '0'.repeat(64) +
  '0'.repeat(64) +
  1_040_000_000_000_000_000n.toString(16).padStart(64, '0');

const MARKET: AaveMarket = {
  marketId: '1:core',
  name: 'Aave v3 Core',
  chainId: 1,
  poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2' as WalletAddress,
  baseCurrencyDecimals: 8,
  addressesProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e' as WalletAddress,
  verifiedOn: '2026-08-06',
};

const PRIME: AaveMarket = { ...MARKET, marketId: '1:prime', name: 'Aave v3 Prime' };

/** The same market, with the trio of addresses that make a breakdown possible. */
const WITH_DETAIL: AaveMarket = {
  ...MARKET,
  addressesProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e' as WalletAddress,
  detail: {
    uiPoolDataProvider: '0x3F78BBD206e4D3c504Eb854232EdA7e47E9Fd8FC' as WalletAddress,
  },
};

const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11' as WalletAddress;

/**
 * The requester is injected, so the context's `fetch` is never reached — the
 * network guard in `src/test/noNetwork.ts` proves that rather than this comment.
 */
function dependencies(requester: RpcRequester) {
  return { context: createTestContext(globalThis.fetch), requester };
}

/** A requester stub typed as the real seam, so a wrong shape fails to compile. */
function stubRequester(
  impl: (request: { method: string; params?: readonly unknown[] }) => Promise<unknown>,
) {
  return vi.fn(impl) as ReturnType<typeof vi.fn> & RpcRequester;
}

/**
 * Answers by what was asked rather than by how many times.
 *
 * The position read and the reward read run concurrently, so a stub that hands out
 * canned responses in order feeds each of them the other's answer. Routing on the
 * calldata makes the tests describe a market rather than a call sequence — and it is
 * what caught the interleaving when `Promise.all` arrived.
 */
function routingRequester(routes: readonly [match: string, response: string][]) {
  return stubRequester(async (request) => {
    const [params] = (request.params ?? []) as [{ data: string }];
    const hit = routes.find(([match]) => params.data.toLowerCase().includes(match.toLowerCase()));
    if (hit === undefined) {
      throw new Error(`no route for ${params.data.slice(0, 34)}`);
    }
    return hit[1];
  });
}

/** Fragments that identify each call this provider makes. */
const ASKS = {
  totals: '0xbf92857c',
  userReserves: '3F78BBD206e4D3c504Eb854232EdA7e47E9Fd8FC'.toLowerCase(),
  reserveDetails: 'd15e0053',
  rewardController: '21f8a721',
};

describe('decodeAccountData', () => {
  it('reads the three words it needs from a real response', () => {
    const decoded = decodeAccountData(BORROWING_RESPONSE);

    expect(decoded.totalCollateralBase).toBe('10000000000000');
    expect(decoded.totalDebtBase).toBe('4000000000000');
    expect(decoded.healthFactor).toBe('1040000000000000000');
  });

  it('carries the no-debt sentinel through untouched, from a captured response', () => {
    // Recognising this is the domain's job, not the decoder's — the decoder must not
    // clamp or reinterpret it on the way past.
    expect(decodeAccountData(REAL_EMPTY_RESPONSE).healthFactor).toBe((2n ** 256n - 1n).toString());
  });

  it('refuses an empty response instead of reading it as zero', () => {
    // `0x` is what an address with no contract returns. Decoding it as "no debt"
    // would report every wallet on a chain with a wrong pool address as debt-free.
    expect(() => decodeAccountData('0x')).toThrow(/expected 6 words/);
  });

  it('refuses a truncated response', () => {
    expect(() => decodeAccountData('0x' + '0'.repeat(64 * 4))).toThrow(/expected 6 words/);
  });

  it('refuses a response that is not hex at all', () => {
    expect(() => decodeAccountData({ result: 'oops' })).toThrow(/did not return hex/);
    expect(() => decodeAccountData(null)).toThrow(/did not return hex/);
  });
});

describe('readAaveAccounts', () => {
  it('asks the right pool, with the address padded to a word', async () => {
    const requester = stubRequester(async () => REAL_EMPTY_RESPONSE);

    await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [MARKET],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    const sent = requester.mock.calls[0]?.[0] as { method: string; params: unknown[] };
    expect(sent.method).toBe('eth_call');
    const [params] = sent.params as [{ to: string; data: string }];
    expect(params.to).toBe(MARKET.poolAddress);
    expect(params.data).toBe('0xbf92857c' + TEST_ADDRESS.slice(2).toLowerCase().padStart(64, '0'));
    // 4 bytes of selector + one 32-byte word.
    expect(params.data).toHaveLength(2 + 8 + 64);
  });

  it('reads every market on the chain, not just the first', async () => {
    // Ethereum runs three markets; reading one would report a wallet that borrows
    // on Prime as debt-free (round 12, F-04).
    const requester = routingRequester([[ASKS.totals, REAL_EMPTY_RESPONSE]]);

    const accounts = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [MARKET, PRIME],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(accounts.map((a) => a.marketId)).toEqual(['1:core', '1:prime']);
  });

  it('turns a live borrow into scaled figures', async () => {
    const requester = stubRequester(async () => BORROWING_RESPONSE);

    const [account] = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [MARKET],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(account).toMatchObject({
      status: 'ok',
      collateralValueUsd: '100000',
      borrowedValueUsd: '40000',
      healthFactor: '1.04',
      marketName: 'Aave v3 Core',
    });
  });

  it('reports a failed market as failed, and keeps reading the others', async () => {
    // The property that matters: one market failing must not erase the market that
    // answered, and must not be reported as "no debt".
    let call = 0;
    const requester = stubRequester(async () => {
      call += 1;
      if (call === 1) throw new Error('endpoint exploded');
      return BORROWING_RESPONSE;
    });

    const accounts = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [MARKET, PRIME],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(accounts[0]).toMatchObject({
      status: 'failed',
      borrowedValueUsd: null,
      healthFactor: null,
    });
    expect(accounts[1]).toMatchObject({ status: 'ok', borrowedValueUsd: '40000' });
  });

  it('never throws, whatever the endpoint does', async () => {
    // A page needs a sentence, not an exception to classify.
    const requester = stubRequester(async () => {
      throw new Error('everything is on fire');
    });

    const accounts = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [MARKET],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(accounts[0]?.status).toBe('failed');
  });

  it('does nothing at all on a chain with no Aave deployment', async () => {
    const requester = stubRequester(async () => REAL_EMPTY_RESPONSE);

    const accounts = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(accounts).toEqual([]);
    expect(requester).not.toHaveBeenCalled();
  });
});

/**
 * The two-call detail exchange, in the smallest form that decodes.
 *
 * Its contents are asserted properly in `aaveReserves.test.ts`; what these fixtures are
 * for is the question this file owns — what happens to the *totals* when the breakdown
 * succeeds, is skipped, or fails.
 */
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

const DETAIL_RESERVES = encodeAbiParameters(parseAbiParameters('(bool,bytes)[]'), [
  [
    [
      true,
      encodeAbiParameters(parseAbiParameters('(address,uint256,bool,uint256)[], uint8'), [
        [[WETH, 8_496_366_850_973_757_592n, true, 0n]],
        0,
      ]),
    ] as const,
    [true, `0x${'54586bE62E3c3580375aE3723C145253060Ca0C2'.padStart(64, '0')}`] as const,
  ],
]);

const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}` as `0x${string}`;

const DETAIL_BATCH = encodeAbiParameters(parseAbiParameters('(bool,bytes)[]'), [
  [
    [true, encodeAbiParameters(parseAbiParameters('uint256[]'), [[192_969_208_343n]])],
    [true, word(1_069_082_747_211_127_648_702_419_695n)],
    [true, word(0n)],
    [true, word(18n)],
    [true, encodeAbiParameters(parseAbiParameters('string'), ['WETH'])],
  ],
]);

describe('the breakdown, beside the totals rather than in front of them', () => {
  it('reads it when the market reports something to break down', async () => {
    const requester = routingRequester([
      [ASKS.totals, BORROWING_RESPONSE],
      [ASKS.userReserves, DETAIL_RESERVES],
      [ASKS.reserveDetails, DETAIL_BATCH],
    ]);

    const [account] = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [WITH_DETAIL],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(account?.positionsStatus).toBe('ok');
    expect(account?.positions).toEqual([
      {
        asset: WETH,
        symbol: 'WETH',
        supplied: '9.083319214352582347',
        borrowed: '0',
        usedAsCollateral: true,
        suppliedValueUsd: '17528.0091792',
        borrowedValueUsd: '0',
      },
    ]);
  });

  it('keeps the totals when only the breakdown fails', async () => {
    // The property the split exists for (review round 13, F5): a health factor is not
    // worth throwing away because a second call timed out.
    let call = 0;
    const requester = stubRequester(async () => {
      call += 1;
      if (call === 1) return BORROWING_RESPONSE;
      throw new Error('the detail provider is down');
    });

    const [account] = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [WITH_DETAIL],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(account).toMatchObject({
      status: 'ok',
      borrowedValueUsd: '40000',
      healthFactor: '1.04',
      positionsStatus: 'failed',
      positions: [],
    });
  });

  it('still asks when both totals are zero, because that is where a hidden supply is', async () => {
    // A supply with collateral switched off contributes to neither total. Skipping the
    // read here — which an earlier version did, to save a call measured at 134 ms
    // across all three Ethereum markets — hid exactly the position only this can show.
    const requester = routingRequester([
      [ASKS.totals, REAL_EMPTY_RESPONSE],
      [ASKS.userReserves, DETAIL_RESERVES],
      [ASKS.reserveDetails, DETAIL_BATCH],
    ]);

    const [account] = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [WITH_DETAIL],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(account).toMatchObject({ collateralValueUsd: '0', positionsStatus: 'ok' });
    expect(account?.positions).toHaveLength(1);
  });

  it('reports a market with no verified provider as unavailable, not as failed', async () => {
    // Optimism and BNB. The breakdown is permanently absent there, which is a
    // different sentence from "could not be read this time".
    const requester = routingRequester([[ASKS.totals, BORROWING_RESPONSE]]);

    const [account] = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [MARKET],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    // The breakdown is permanently absent; the rewards were attempted and did not
    // answer. Two different sentences, and the whole reason they are separate fields.
    expect(account?.positionsStatus).toBe('unavailable');
    expect(account?.rewardsStatus).toBe('failed');
  });

  it('reports a chain with no Multicall3 as unavailable too', async () => {
    const requester = stubRequester(async () => BORROWING_RESPONSE);

    const [account] = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [WITH_DETAIL],
      multicallAddress: null,
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(account?.positionsStatus).toBe('unavailable');
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it('spends nothing on a breakdown once the request budget is gone', async () => {
    // The totals are already in hand. Asking anyway trades a page that renders for one
    // that times out.
    const requester = stubRequester(async () => BORROWING_RESPONSE);
    const context = createTestContext(globalThis.fetch, {
      deadline: new Deadline(1, Date.now() - 1000),
    });

    const [account] = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [WITH_DETAIL],
      multicallAddress: MULTICALL,
      rpcUrls: [],
      dependencies: { context, requester },
    });

    expect(account).toMatchObject({ status: 'ok', positionsStatus: 'failed' });
    expect(requester).toHaveBeenCalledTimes(1);
  });
});
