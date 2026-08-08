import { describe, expect, it } from 'vitest';

import { buildAggregatePortfolio } from '@/domain/normalize';
import type { Portfolio } from '@/domain/portfolio';
import { TEST_ADDRESS } from '@/test/helpers';

import { collectAggregateWarnings } from './PortfolioView';

/**
 * The aggregate view flattens five networks' warnings into one list, and the rule it
 * applies depends on what a warning is *about*. A warning about a network's data is
 * namespaced and prefixed with the network's name. A warning about the product is the
 * same sentence on all five, so exactly one must survive.
 */
const FETCHED_AT = '2026-08-08T00:00:00.000Z';

function chain(chainId: number, chainName: string, warnings: Portfolio['warnings']): Portfolio {
  return {
    address: TEST_ADDRESS,
    chainId,
    chainName,
    protocolAccounts: [],
    totalValueUsd: null,
    assetCount: 0,
    pricedAssetCount: 0,
    unpricedAssetCount: 0,
    suspectAssetCount: 0,
    suspectValueUsd: null,
    checkedAssetCount: 0,
    disputedAssetCount: 0,
    coverage: 'complete',
    balanceSource: 'rpc-token-list',
    priceSource: 'defillama',
    assets: [],
    fxRate: null,
    fetchedAt: FETCHED_AT,
    warnings,
  };
}

const COVERAGE = {
  code: 'protocols.coverage',
  message: 'Aave v3 is the only protocol whose own accounting is read.',
};

function aggregateOf(chains: readonly Portfolio[]) {
  return buildAggregatePortfolio({
    address: TEST_ADDRESS,
    chains: [...chains],
    failedChains: [],
    fetchedAt: FETCHED_AT,
  });
}

describe('collectAggregateWarnings', () => {
  it('states the protocol boundary once, not once per network', () => {
    const aggregate = aggregateOf([
      chain(1, 'Ethereum Mainnet', [COVERAGE]),
      chain(8453, 'Base', [COVERAGE]),
      chain(42161, 'Arbitrum One', [COVERAGE]),
      chain(10, 'OP Mainnet', [COVERAGE]),
      chain(56, 'BNB Smart Chain', [COVERAGE]),
    ]);

    const shown = collectAggregateWarnings(aggregate).filter((warning) =>
      warning.message.includes('Aave v3'),
    );

    expect(shown).toHaveLength(1);
  });

  it('does not prefix it with a network name, because it is not about one', () => {
    const aggregate = aggregateOf([
      chain(1, 'Ethereum Mainnet', [COVERAGE]),
      chain(8453, 'Base', [COVERAGE]),
    ]);

    const [shown] = collectAggregateWarnings(aggregate).filter((w) => w.code === COVERAGE.code);

    expect(shown?.message).toBe(COVERAGE.message);
    expect(shown?.message).not.toMatch(/Ethereum|Base/);
  });

  it('still namespaces a warning that really is about one network', () => {
    // The rule it is distinguished from: two networks failing to price is two facts.
    const aggregate = aggregateOf([
      chain(1, 'Ethereum Mainnet', [{ code: 'prices.unavailable', message: 'No prices.' }]),
      chain(8453, 'Base', [{ code: 'prices.unavailable', message: 'No prices.' }]),
    ]);

    const shown = collectAggregateWarnings(aggregate).filter((w) =>
      w.code.endsWith('prices.unavailable'),
    );

    expect(shown).toHaveLength(2);
    expect(shown.map((w) => w.message)).toEqual([
      'Ethereum Mainnet: No prices.',
      'Base: No prices.',
    ]);
  });
});
