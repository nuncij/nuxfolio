import { describe, expect, it, vi } from 'vitest';

import type { AaveMarket } from '@/config/aaveMarkets';
import type { WalletAddress } from '@/domain/address';
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
  verifiedOn: '2026-08-06',
};

const PRIME: AaveMarket = { ...MARKET, marketId: '1:prime', name: 'Aave v3 Prime' };

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
    const requester = stubRequester(async () => REAL_EMPTY_RESPONSE);

    const accounts = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [MARKET, PRIME],
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(requester).toHaveBeenCalledTimes(2);
    expect(accounts.map((a) => a.marketId)).toEqual(['1:core', '1:prime']);
  });

  it('turns a live borrow into scaled figures', async () => {
    const requester = stubRequester(async () => BORROWING_RESPONSE);

    const [account] = await readAaveAccounts({
      address: TEST_ADDRESS,
      markets: [MARKET],
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
      rpcUrls: [],
      dependencies: dependencies(requester),
    });

    expect(accounts).toEqual([]);
    expect(requester).not.toHaveBeenCalled();
  });
});
