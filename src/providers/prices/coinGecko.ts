import { z } from 'zod';

import { numberToDecimalString } from '@/domain/money';
import type { PortfolioWarning } from '@/domain/portfolio';
import { chunk } from '@/server/concurrency';
import { fetchJson } from '@/server/http';
import { describeError } from '@/server/logger';

import {
  priceRefKey,
  ProviderError,
  type PriceQuote,
  type PriceVerification,
  type PriceVerifier,
} from '../types';

/**
 * A second opinion on prices, from CoinGecko's Demo API.
 *
 * Deliberately a *verifier*, not a `PriceProvider`. Swapping DefiLlama out for
 * this would lose the per-quote confidence scores and timestamps that the
 * staleness flags depend on; layering it on top adds disagreement detection
 * without giving anything up. See ADR-019.
 *
 * Everything below was measured against the live API on 2026-07-31 rather than
 * taken from documentation:
 *
 *  - Keyless, the endpoint accepts **one** contract address per call
 *    (`error_code 10012`), which is why a key is required for this to be viable
 *    at all — 55 assets would otherwise be 55 requests.
 *  - With the Demo key, 175 addresses in one call succeeded.
 *  - 200 addresses returned **HTTP 414 with an HTML body**. That is nginx's URI
 *    length limit, not an API rule, so it fails as an unparseable response rather
 *    than an error code this adapter could branch on. Hence the conservative
 *    chunk size below: sitting near a limit that belongs to someone else's web
 *    server configuration is not a plan.
 */

const PROVIDER_ID = 'coingecko';
const BASE_URL = 'https://api.coingecko.com/api/v3/simple/token_price';
/** Native assets are priced by coin id, not by contract address. */
const NATIVE_URL = 'https://api.coingecko.com/api/v3/simple/price';

/**
 * Addresses per request. 100 is verified working and roughly 4 kB of URL — half
 * the observed 8 kB ceiling.
 */
const ADDRESSES_PER_REQUEST = 100;

/** CoinGecko's asset-platform ids, keyed by chain. Vendor naming stays in here. */
const PLATFORM_BY_CHAIN_ID: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum-one',
  10: 'optimistic-ethereum',
  56: 'binance-smart-chain',
  137: 'polygon-pos',
  43114: 'avalanche',
  100: 'xdai',
};

/**
 * CoinGecko coin ids for the chains' native assets.
 *
 * These need a different endpoint — `/simple/price` by coin id, rather than by
 * contract address — so supporting them costs one extra call per chain.
 *
 * The M2-2 spec originally skipped natives on exactly that reasoning: "a second
 * slice of quota for one asset per chain". A live run disproved it. On Base,
 * Arbitrum and OP Mainnet the native asset is effectively the entire holding, so
 * skipping it left the single most material price on three of five chains
 * permanently unverifiable — which defeats the point of cross-checking at all.
 */
const NATIVE_COIN_ID_BY_CHAIN_ID: Record<number, string> = {
  1: 'ethereum',
  8453: 'ethereum',
  42161: 'ethereum',
  10: 'ethereum',
  56: 'binancecoin',
  // POL, not MATIC — the 2024 migration renamed the coin id too.
  137: 'polygon-ecosystem-token',
  43114: 'avalanche-2',
  100: 'xdai',
};

const coinSchema = z.object({
  usd: z.number().finite().optional(),
  last_updated_at: z.number().finite().optional(),
});

/** Keys are lowercased contract addresses, or coin ids on the native endpoint. */
const responseSchema = z.record(z.string(), coinSchema);

export function createCoinGeckoVerifier(input: { apiKey: string }): PriceVerifier {
  const { apiKey } = input;

  return {
    id: PROVIDER_ID,

    async verify({ chain, refs, context }): Promise<PriceVerification> {
      const quotes = new Map<string, PriceQuote>();
      const warnings: PortfolioWarning[] = [];
      /**
       * Refs a request was actually issued for. A ref that never made it into a
       * request — deadline expired, or an unmapped chain — must not come back
       * looking like one the source declined to price.
       */
      const attemptedRefKeys = new Set<string>();

      const platform = PLATFORM_BY_CHAIN_ID[chain.chainId];
      if (platform === undefined) {
        // Not an error: a chain this verifier does not know simply goes
        // unchecked, and the portfolio says so by leaving priceCheck null.
        return { providerId: PROVIDER_ID, quotes, warnings, attemptedRefKeys };
      }

      const tokenRefs = refs.filter((ref) => ref.contractAddress !== null);
      const nativeRef = refs.find((ref) => ref.contractAddress === null);

      if (tokenRefs.length === 0 && nativeRef === undefined) {
        return { providerId: PROVIDER_ID, quotes, warnings, attemptedRefKeys };
      }

      const byAddress = new Map<string, string>();
      for (const ref of tokenRefs) {
        byAddress.set((ref.contractAddress as string).toLowerCase(), priceRefKey(ref));
      }

      const batches = chunk([...byAddress.keys()], ADDRESSES_PER_REQUEST);
      const nativeCoinId =
        nativeRef === undefined ? undefined : NATIVE_COIN_ID_BY_CHAIN_ID[chain.chainId];

      /**
       * Requests this call intends to make, counted before any of them runs. The
       * warning quotes it as a denominator, so it cannot be built up as requests
       * happen: a deadline that expires early would then shrink the denominator
       * and make a total failure read as a small one.
       */
      const plannedRequests = batches.length + (nativeCoinId === undefined ? 0 : 1);
      let failedRequests = 0;
      let succeededRequests = 0;

      for (const [index, batch] of batches.entries()) {
        if (context.deadline.hasExpired()) {
          // Not counted as failures: these refs were never asked about, and
          // `attemptedRefKeys` is what tells the caller so. Counting them would
          // claim requests were made that were not.
          break;
        }

        for (const address of batch) {
          const key = byAddress.get(address);
          if (key !== undefined) {
            attemptedRefKeys.add(key);
          }
        }

        try {
          const query = new URLSearchParams({
            contract_addresses: batch.join(','),
            vs_currencies: 'usd',
            include_last_updated_at: 'true',
          });

          const response = await fetchJson({
            url: `${BASE_URL}/${platform}?${query.toString()}`,
            // The key travels as a header, never in the URL: a URL reaches error
            // messages, proxy logs and referrers, and this one is a credential.
            headers: { 'x-cg-demo-api-key': apiKey },
            // Fixed label, so neither the key nor the wallet's contract addresses
            // can reach a log line through the request URL.
            label: BASE_URL,
            schema: responseSchema,
            providerId: PROVIDER_ID,
            context,
          });
          succeededRequests += 1;

          for (const [address, coin] of Object.entries(response)) {
            const domainKey = byAddress.get(address.toLowerCase());
            if (domainKey === undefined || coin.usd === undefined || coin.usd <= 0) {
              continue;
            }
            quotes.set(domainKey, {
              priceUsd: numberToDecimalString(coin.usd),
              updatedAt: toIsoTimestamp(coin.last_updated_at),
              // CoinGecko reports no confidence score. Null says "not reported",
              // which is the honest value; inventing 1.0 would claim certainty
              // the source never offered.
              confidence: null,
            });
          }
        } catch (error) {
          // A rejected key is an operator's problem, not an outage, and every
          // remaining request would fail the same way. Stopping immediately says
          // so instead of burning the rest of the batches to reach the same place.
          if (isAuthFailure(error)) {
            context.logger.error('prices.crosscheck_misconfigured', {
              providerId: PROVIDER_ID,
              chainId: chain.chainId,
              ...describeError(error),
            });
            throw error;
          }
          failedRequests += 1;
          context.logger.warn('prices.crosscheck_batch_failed', {
            providerId: PROVIDER_ID,
            chainId: chain.chainId,
            batchIndex: index,
            // Recorded because a 414 is diagnosable only from the batch size.
            batchSize: batch.length,
            ...describeError(error),
          });
        }
      }

      // The native asset, on its own endpoint. Failure here is counted with the
      // rest: one unconfirmed price is one unconfirmed price, whichever call it
      // came from.
      if (nativeRef !== undefined && nativeCoinId !== undefined && !context.deadline.hasExpired()) {
        attemptedRefKeys.add(priceRefKey(nativeRef));
        try {
          const query = new URLSearchParams({
            ids: nativeCoinId,
            vs_currencies: 'usd',
            include_last_updated_at: 'true',
          });
          const response = await fetchJson({
            url: `${NATIVE_URL}?${query.toString()}`,
            headers: { 'x-cg-demo-api-key': apiKey },
            label: NATIVE_URL,
            schema: responseSchema,
            providerId: PROVIDER_ID,
            context,
          });
          succeededRequests += 1;

          const coin = response[nativeCoinId];
          if (coin?.usd !== undefined && coin.usd > 0) {
            quotes.set(priceRefKey(nativeRef), {
              priceUsd: numberToDecimalString(coin.usd),
              updatedAt: toIsoTimestamp(coin.last_updated_at),
              confidence: null,
            });
          }
        } catch (error) {
          if (isAuthFailure(error)) {
            context.logger.error('prices.crosscheck_misconfigured', {
              providerId: PROVIDER_ID,
              chainId: chain.chainId,
              ...describeError(error),
            });
            throw error;
          }
          failedRequests += 1;
          context.logger.warn('prices.crosscheck_native_failed', {
            providerId: PROVIDER_ID,
            chainId: chain.chainId,
            ...describeError(error),
          });
        }
      }

      // Nothing got through at all. That is an unavailable second source, not a
      // partial one, so it is raised rather than reported as a degraded success —
      // the caller turns it into the single `crosscheck_unavailable` warning.
      if (succeededRequests === 0 && failedRequests > 0) {
        throw new ProviderError(
          'unavailable',
          PROVIDER_ID,
          `All ${failedRequests} price cross-check requests failed`,
        );
      }

      if (failedRequests > 0) {
        warnings.push({
          code: 'prices.crosscheck_partial',
          message: `${failedRequests} of ${plannedRequests} price cross-check requests could not be loaded, so some prices were not independently confirmed.`,
        });
      }

      return { providerId: PROVIDER_ID, quotes, warnings, attemptedRefKeys };
    },
  };
}

/** Null rather than "now": an absent timestamp is unknown age, not freshness. */
function toIsoTimestamp(unixSeconds: number | undefined): string | null {
  if (unixSeconds === undefined || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return null;
  }
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * A rejected key is an operator problem, not an outage.
 *
 * Used above to stop early and log at `error` rather than `warn`: degrading
 * quietly through every remaining batch would leave "no cross-check" looking like
 * a provider having a bad day, when the fix is a configuration change.
 */
function isAuthFailure(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 401;
}
