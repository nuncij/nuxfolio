import 'server-only';

import { getServerEnv, type ServerEnv } from '@/config/env';

import { createAlchemyProvider } from './balances/alchemy';
import { createRpcTokenListProvider } from './balances/rpcTokenList';
import { createCoinGeckoVerifier } from './prices/coinGecko';
import { createDefiLlamaPriceProvider } from './prices/defiLlama';
import { createEcbRateProvider } from './rates/ecb';
import type { PortfolioProvider, PriceProvider, PriceVerifier, RateProvider } from './types';

/**
 * Provider selection.
 *
 * Resolution is by capability, not by a mode switch: an indexer is strictly
 * better than a token-list sweep, so if a key is present it wins. That keeps a
 * fresh clone working with no configuration while making the upgrade path a
 * single environment variable.
 *
 * Tests never call this — they construct adapters directly or inject fakes, so
 * no test-only branch exists in production code.
 */

export function selectBalanceProvider(env: ServerEnv = getServerEnv()): PortfolioProvider {
  if (env.ALCHEMY_API_KEY !== undefined) {
    return createAlchemyProvider({ apiKey: env.ALCHEMY_API_KEY });
  }
  return createRpcTokenListProvider();
}

export function selectPriceProvider(_env: ServerEnv = getServerEnv()): PriceProvider {
  return createDefiLlamaPriceProvider();
}

/**
 * The second price source, or none.
 *
 * Absent by default and that is not a fault: without a key there is nothing to
 * cross-check with, and the portfolio reports `priceCheck: null` rather than
 * pretending agreement.
 */
export function selectPriceVerifier(env: ServerEnv = getServerEnv()): PriceVerifier | null {
  if (env.COINGECKO_API_KEY === undefined) {
    return null;
  }
  return createCoinGeckoVerifier({ apiKey: env.COINGECKO_API_KEY });
}

/**
 * The display-currency rate source.
 *
 * Keyless and unconditional: unlike the verifier, there is no configuration that
 * turns this off, because a EUR display is a formatting choice rather than an
 * enrichment that costs quota.
 */
export function selectRateProvider(_env: ServerEnv = getServerEnv()): RateProvider {
  return createEcbRateProvider();
}
