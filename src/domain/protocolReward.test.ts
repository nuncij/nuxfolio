import { describe, expect, it } from 'vitest';

import { isUnclaimed, toProtocolReward, type RawReward } from './protocolReward';

/**
 * Captured from Optimism on 2026-08-08. `0xB2289E…1bcf` is owed 1,185.243607 OP, which
 * the market oracle prices at $0.08777743 — the largest unclaimed balance found in a
 * forty-wallet sample, and the reason this feature is not merely decorative.
 */
const OP: RawReward = {
  token: '0x4200000000000000000000000000000000000042',
  symbol: 'OP',
  decimals: 18,
  amount: 1_185_243_607_000_000_000_000n,
  priceBase: 8_777_743n,
};

describe('toProtocolReward', () => {
  it('values a real unclaimed balance against the market oracle', () => {
    expect(toProtocolReward(OP)).toEqual({
      token: OP.token,
      symbol: 'OP',
      amount: '1185.243607',
      valueUsd: '104.03763774',
    });
  });

  it('reports no price as null, which on Ethereum is the usual case', () => {
    // Four of the five reward tokens Ethereum has configured are themselves aTokens,
    // and `getAssetPrice` reverts for every one of them. The amount has to stand alone.
    const reward = toProtocolReward({ ...OP, symbol: 'aEthUSDS', priceBase: null });

    expect(reward.valueUsd).toBeNull();
    expect(reward.amount).toBe('1185.243607');
  });

  it('rounds a value down, because a reward is a holding', () => {
    // 1 wei at $0.08777743 is worth a fraction of a base unit. Rounding it up would
    // promise a cent the protocol will not pay.
    expect(toProtocolReward({ ...OP, amount: 1n }).valueUsd).toBe('0');
  });

  it('keeps every digit of an amount past what a float holds', () => {
    const reward = toProtocolReward({ ...OP, amount: 123_456_789_012_345_678_901n });

    expect(reward.amount).toBe('123.456789012345678901');
  });

  it('renders a six-decimal reward at its own scale', () => {
    const reward = toProtocolReward({ ...OP, symbol: 'FDUSD', decimals: 6, amount: 1_500_000n });

    expect(reward.amount).toBe('1.5');
  });
});

describe('isUnclaimed', () => {
  it('drops the zero entries the controller always returns', () => {
    // `getAllUserRewards` answers for every reward the market ever configured — five on
    // Ethereum — so a wallet owed one thing gets four zeroes alongside it.
    expect(isUnclaimed({ ...OP, amount: 0n })).toBe(false);
    expect(isUnclaimed(OP)).toBe(true);
  });

  it('keeps dust, which is most of what wallets actually have', () => {
    // Measured: of eighteen Optimism wallets with something unclaimed, most held a few
    // hundred-thousandths of an OP. Hiding those would be a threshold nobody chose.
    expect(isUnclaimed({ ...OP, amount: 36_000_000_000_000n })).toBe(true);
  });
});
