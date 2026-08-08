import { describe, expect, it } from 'vitest';

import { computeNetOfDebt } from './netOfDebt';
import type { PortfolioAsset } from './portfolio';
import type { ProtocolAccount } from './protocolAccount';
import type { ProtocolPosition } from './protocolPosition';

/**
 * ADR-026 refused this figure after working one example end to end, and no measurement
 * would have caught the error — the inputs were all correct and the arithmetic crossed
 * two scopes. So the examples come first here, and they are real ones.
 */

const AWETH = '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function asset(overrides: Partial<PortfolioAsset> = {}): PortfolioAsset {
  return {
    assetId: '1:native',
    chainId: 1,
    contractAddress: null,
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
    quantity: '1',
    rawQuantity: '1000000000000000000',
    priceUsd: '1929.69',
    valueUsd: '1929.69',
    portfolioSharePct: null,
    logoUrl: null,
    priceSource: 'defillama',
    priceUpdatedAt: null,
    priceQuality: 'ok',
    priceChange24h: null,
    priceChange7d: null,
    priceCheck: null,
    suspect: false,
    suspectReason: null,
    ...overrides,
  };
}

function position(overrides: Partial<ProtocolPosition> = {}): ProtocolPosition {
  return {
    asset: WETH,
    symbol: 'WETH',
    supplied: '9.083319214352582347',
    borrowed: '0',
    usedAsCollateral: true,
    aTokenAddress: AWETH,
    suppliedValueUsd: '17528.00',
    borrowedValueUsd: '0',
    ...overrides,
  };
}

function account(overrides: Partial<ProtocolAccount> = {}): ProtocolAccount {
  return {
    chainId: 1,
    protocol: 'aave-v3',
    marketId: '1:core',
    marketName: 'Aave v3 Core',
    status: 'ok',
    collateralValueUsd: '17528.00',
    borrowedValueUsd: '8064.46',
    healthFactor: '1.79',
    positions: [
      position(),
      position({
        asset: USDC,
        symbol: 'USDC',
        supplied: '0',
        suppliedValueUsd: '0',
        borrowed: '8064.46',
        borrowedValueUsd: '8064.46',
        aTokenAddress: '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c',
        usedAsCollateral: false,
      }),
    ],
    positionsStatus: 'ok',
    rewards: [],
    rewardsStatus: 'ok',
    ...overrides,
  };
}

describe('the worked example — the receipt token IS on the bundled list', () => {
  // The benchmark borrower on Ethereum. `AWETH` is one of the 53 Aave v3 receipts the
  // bundled lists carry, so the collateral is already inside `totalValueUsd`.
  const assets = [
    asset({ assetId: '1:aweth', contractAddress: AWETH, symbol: 'AWETH', valueUsd: '17527.18' }),
    asset({ valueUsd: '154.46' }),
    asset({ assetId: '1:weth', contractAddress: WETH, symbol: 'WETH', valueUsd: '3.10' }),
  ];
  const total = '17684.74';

  it('counts the position once and takes the debt off', () => {
    // 17684.74 − 17527.18 (the AWETH already counted) + 17528.00 (Aave's own figure)
    //          − 8064.46 (the debt) = 9621.10
    const net = computeNetOfDebt({ totalValueUsd: total, assets, accounts: [account()] });

    expect(net.valueUsd).toBe('9621.1');
    expect(net.reason).toBeNull();
  });

  it('lands within a dollar of the naive formula here, which is the point', () => {
    // `total − debt` gives 9620.28. It is nearly right *because* the receipt token is
    // listed, and the 82-cent gap is only the two price sources disagreeing about the
    // same WETH. This is the case ADR-026 said the old formula got right.
    const naive = Number(total) - 8064.46;
    const net = Number(
      computeNetOfDebt({ totalValueUsd: total, assets, accounts: [account()] }).valueUsd,
    );

    expect(Math.abs(net - naive)).toBeLessThan(1);
  });
});

describe('the worked example — the receipt token is NOT on the list', () => {
  // The same wallet, on a chain whose aToken no bundled list carries. This is where
  // ADR-026's formula reported $0 for a wallet worth $60,000.
  const assets = [asset({ valueUsd: '154.46' })];

  it('adds the collateral the asset list cannot see', () => {
    // 154.46 + 17528.00 − 8064.46 = 9618.00
    const net = computeNetOfDebt({ totalValueUsd: '154.46', assets, accounts: [account()] });

    expect(net.valueUsd).toBe('9618');
  });

  it('and the naive formula would have been wrong by the whole collateral', () => {
    // `total − debt` = 154.46 − 8064.46 = −7910.00. Negative, for a wallet holding
    // $9,618. That is the number ADR-026 refused, and the reason this file exists.
    const naive = Number('154.46') - 8064.46;
    const net = Number(
      computeNetOfDebt({ totalValueUsd: '154.46', assets, accounts: [account()] }).valueUsd,
    );

    expect(naive).toBeLessThan(0);
    expect(net - naive).toBeCloseTo(17528, 0);
  });
});

describe('when it refuses to answer', () => {
  const assets = [asset({ valueUsd: '154.46' })];

  it('says nothing when the wallet owes nothing', () => {
    // A "net" equal to the total is a second copy of a number, inviting a reader to
    // hunt for a difference that is not there.
    const net = computeNetOfDebt({
      totalValueUsd: '154.46',
      assets,
      accounts: [account({ borrowedValueUsd: '0', positions: [position()] })],
    });

    expect(net).toEqual({ valueUsd: null, reason: 'no-debt' });
  });

  it('refuses when a market could not be read at all', () => {
    // Its debt is unknown, so any figure would be a guess dressed as a net worth.
    const net = computeNetOfDebt({
      totalValueUsd: '154.46',
      assets,
      accounts: [
        account(),
        account({
          marketId: '1:prime',
          status: 'failed',
          collateralValueUsd: null,
          borrowedValueUsd: null,
          healthFactor: null,
          positions: [],
          positionsStatus: 'failed',
        }),
      ],
    });

    expect(net).toEqual({ valueUsd: null, reason: 'market-unreadable' });
  });

  it('refuses when a market cannot say what its totals are made of', () => {
    // Optimism and BNB. Without the breakdown the double count is undetectable:
    // adding the collateral may count a listed receipt twice, and not adding it drops
    // the collateral. Both are wrong by thousands.
    const net = computeNetOfDebt({
      totalValueUsd: '154.46',
      assets,
      accounts: [account({ positions: [], positionsStatus: 'unavailable' })],
    });

    expect(net).toEqual({ valueUsd: null, reason: 'market-unreadable' });
  });

  it('refuses when the market oracle could not price a position', () => {
    const net = computeNetOfDebt({
      totalValueUsd: '154.46',
      assets,
      accounts: [account({ positions: [position({ suppliedValueUsd: null })] })],
    });

    expect(net).toEqual({ valueUsd: null, reason: 'position-unpriced' });
  });

  it('refuses when nothing could be priced', () => {
    const net = computeNetOfDebt({ totalValueUsd: null, assets: [], accounts: [account()] });

    expect(net).toEqual({ valueUsd: null, reason: 'nothing-priced' });
  });

  it('refuses when any market failed, because a failed read may be hiding debt', () => {
    // The conservative direction, and the only defensible one: a market that did not
    // answer might hold a position, so a net figure computed without it could be short
    // by any amount. "It probably had nothing" is not something to put in a headline.
    const net = computeNetOfDebt({
      totalValueUsd: '154.46',
      assets,
      accounts: [
        account(),
        {
          ...account({ marketId: '1:etherfi' }),
          status: 'failed',
          collateralValueUsd: null,
          borrowedValueUsd: null,
          healthFactor: null,
          positions: [],
          positionsStatus: 'failed',
        },
      ],
    });

    expect(net.reason).toBe('market-unreadable');
  });
});

describe('what must never be subtracted', () => {
  it('leaves a suspect receipt token alone, because it was never in the total', () => {
    // Spam is already outside `totalValueUsd` (ADR-014). Subtracting it would take off
    // money the subtotal never contained.
    const assets = [
      asset({ valueUsd: '154.46' }),
      asset({ assetId: '1:aweth', contractAddress: AWETH, valueUsd: '17527.18', suspect: true }),
    ];

    // 154.46 + 17528.00 − 8064.46 = 9618.00, with no subtraction for the suspect row.
    expect(
      computeNetOfDebt({ totalValueUsd: '154.46', assets, accounts: [account()] }).valueUsd,
    ).toBe('9618');
  });

  it('leaves an unpriced receipt token alone, for the same reason', () => {
    const assets = [
      asset({ valueUsd: '154.46' }),
      asset({ assetId: '1:aweth', contractAddress: AWETH, valueUsd: null }),
    ];

    expect(
      computeNetOfDebt({ totalValueUsd: '154.46', assets, accounts: [account()] }).valueUsd,
    ).toBe('9618');
  });

  it('matches the receipt token case-insensitively', () => {
    // Addresses arrive checksummed from one source and lowercased from another; a
    // case-sensitive match would miss the double count and overstate by the collateral.
    const assets = [
      asset({ assetId: '1:aweth', contractAddress: AWETH.toLowerCase(), valueUsd: '17527.18' }),
    ];

    expect(
      computeNetOfDebt({ totalValueUsd: '17527.18', assets, accounts: [account()] }).valueUsd,
    ).toBe('9463.54');
  });

  it('does not subtract a receipt token held on a different chain', () => {
    // Same address, different network: Aave deploys aTokens at unrelated addresses per
    // chain, but a collision must not silently cancel a position.
    const assets = [
      asset({ assetId: '8453:aweth', chainId: 8453, contractAddress: AWETH, valueUsd: '17527.18' }),
    ];

    // Nothing subtracted: 17527.18 + 17528.00 − 8064.46
    expect(
      computeNetOfDebt({ totalValueUsd: '17527.18', assets, accounts: [account()] }).valueUsd,
    ).toBe('26990.72');
  });
});
