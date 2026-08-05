import { z } from 'zod';

import type { PortfolioWarning } from '@/domain/portfolio';
import { numberToDecimalString } from '@/domain/money';
import { chunk } from '@/server/concurrency';
import { fetchJson } from '@/server/http';
import { describeError } from '@/server/logger';

import {
  priceRefKey,
  ProviderError,
  type PriceLookup,
  type PriceProvider,
  type PriceQuote,
  type PriceRef,
} from '../types';

/**
 * Prices from the DefiLlama Coins API.
 *
 * Chosen over CoinGecko's keyless tier because it accepts a batched list of
 * assets in one request, where CoinGecko's free tier accepts exactly one
 * contract address per call. It also returns a per-asset timestamp and
 * confidence score, which is what makes honest staleness labelling possible at
 * all. See docs/DECISIONS.md, ADR-005.
 */

const PROVIDER_ID = 'defillama';
const BASE_URL = 'https://coins.llama.fi/prices/current';
/** Prices at an instant. Same response shape as the current-price endpoint. */
const HISTORICAL_URL = 'https://coins.llama.fi/prices/historical';

/**
 * Refs per request. Each ref is ~50 characters, so 60 keeps the URL near 3 kB —
 * well inside every practical URL limit while still collapsing a large
 * portfolio into a couple of calls.
 */
const REFS_PER_REQUEST = 60;

/** DefiLlama's chain namespace, keyed by chain ID. Vendor naming stays here. */
const CHAIN_NAMESPACE_BY_ID: Record<number, string> = {
  1: 'ethereum',
  8453: 'base',
  42161: 'arbitrum',
  10: 'optimism',
  56: 'bsc',
};

/**
 * Native assets have no contract address, so they are priced through
 * DefiLlama's CoinGecko passthrough namespace. The L2s below settle in ether,
 * so they share its identifier.
 */
const NATIVE_REF_BY_CHAIN_ID: Record<number, string> = {
  1: 'coingecko:ethereum',
  8453: 'coingecko:ethereum',
  42161: 'coingecko:ethereum',
  10: 'coingecko:ethereum',
  56: 'coingecko:binancecoin',
};

const coinSchema = z.object({
  price: z.number().finite(),
  symbol: z.string().optional(),
  decimals: z.number().optional(),
  /** Unix seconds. */
  timestamp: z.number().finite().optional(),
  confidence: z.number().optional(),
});

const responseSchema = z.object({
  coins: z.record(z.string(), coinSchema),
});

export function createDefiLlamaPriceProvider(): PriceProvider {
  return {
    id: PROVIDER_ID,

    async fetchPrices({ chain, refs, context }): Promise<PriceLookup> {
      const quotes = new Map<string, PriceQuote>();
      const warnings: PortfolioWarning[] = [];

      if (refs.length === 0) {
        return { providerId: PROVIDER_ID, quotes, warnings };
      }

      const namespace = CHAIN_NAMESPACE_BY_ID[chain.chainId];
      if (namespace === undefined) {
        throw new ProviderError(
          'misconfigured',
          PROVIDER_ID,
          `Chain ${chain.chainId} has no DefiLlama namespace mapping`,
        );
      }

      // Vendor key -> domain key, so the response can be mapped back without
      // depending on how DefiLlama echoes casing.
      const vendorToDomain = new Map<string, string>();
      for (const ref of refs) {
        const vendorKey = toVendorKey(ref, namespace);
        if (vendorKey === null) {
          continue;
        }
        vendorToDomain.set(vendorKey.toLowerCase(), priceRefKey(ref));
      }

      const vendorKeys = [...vendorToDomain.keys()];
      const batches = chunk(vendorKeys, REFS_PER_REQUEST);
      let failedBatches = 0;

      for (const [index, batch] of batches.entries()) {
        if (context.deadline.hasExpired()) {
          failedBatches += batches.length - index;
          break;
        }

        try {
          const response = await fetchJson({
            url: `${BASE_URL}/${batch.map(encodeURIComponent).join(',')}`,
            // The URL carries no credential, but it does carry the wallet's
            // contract addresses. A fixed label keeps them out of logs.
            label: BASE_URL,
            schema: responseSchema,
            providerId: PROVIDER_ID,
            context,
          });

          for (const [vendorKey, coin] of Object.entries(response.coins)) {
            const domainKey = vendorToDomain.get(vendorKey.toLowerCase());
            if (domainKey === undefined || coin.price <= 0) {
              continue;
            }
            quotes.set(domainKey, {
              priceUsd: numberToDecimalString(coin.price),
              updatedAt: toIsoTimestamp(coin.timestamp),
              confidence: typeof coin.confidence === 'number' ? coin.confidence : null,
            });
          }
        } catch (error) {
          failedBatches += 1;
          context.logger.warn('prices.batch_failed', {
            providerId: PROVIDER_ID,
            batchIndex: index,
            batchSize: batch.length,
            ...describeError(error),
          });
        }
      }

      if (failedBatches > 0) {
        warnings.push({
          code: 'prices.partial',
          message: `${failedBatches} of ${batches.length} price batches could not be loaded, so some assets are shown without a value.`,
        });
      }

      return { providerId: PROVIDER_ID, quotes, warnings };
    },

    /**
     * Prices at an instant, from `/prices/historical/{ts}/{refs}`.
     *
     * Deliberately not `/percentage`, which answers the whole question in one
     * call. That endpoint returns a bare number with **no timestamp and no
     * confidence**, so there is no way to know whether the figure rests on a
     * usable observation — and this endpoint returns the same `timestamp` and
     * `confidence` fields the staleness rules already depend on. The change is
     * therefore computed here from two prices that can both be seen and labelled.
     *
     * DefiLlama answers with the nearest price it holds, which can be hours from
     * the instant requested. Each quote carries its real `updatedAt` for that
     * reason; the caller decides whether the drift is acceptable.
     */
    async fetchHistoricalPrices({ chain, refs, atUnixSeconds, context }) {
      const quotes = new Map<string, PriceQuote>();
      const warnings: PortfolioWarning[] = [];
      /** Refs a request was actually issued for — never asked ≠ no answer. */
      const attemptedRefKeys = new Set<string>();

      const namespace = CHAIN_NAMESPACE_BY_ID[chain.chainId];
      if (namespace === undefined) {
        return { providerId: PROVIDER_ID, quotes, warnings, attemptedRefKeys };
      }

      const vendorToDomain = new Map<string, string>();
      for (const ref of refs) {
        const vendorKey = toVendorKey(ref, namespace);
        if (vendorKey !== null) {
          vendorToDomain.set(vendorKey.toLowerCase(), priceRefKey(ref));
        }
      }

      const batches = chunk([...vendorToDomain.keys()], REFS_PER_REQUEST);
      let failedBatches = 0;
      let succeededBatches = 0;

      for (const [index, batch] of batches.entries()) {
        if (context.deadline.hasExpired()) {
          // Not counted as failures: these refs were never asked about, and the
          // absence from `attemptedRefKeys` is what tells the caller so.
          break;
        }

        for (const vendorKey of batch) {
          const domainKey = vendorToDomain.get(vendorKey);
          if (domainKey !== undefined) {
            attemptedRefKeys.add(domainKey);
          }
        }

        try {
          const response = await fetchJson({
            url: `${HISTORICAL_URL}/${atUnixSeconds}/${batch.map(encodeURIComponent).join(',')}`,
            // Carries the wallet's contract addresses; a fixed label keeps them
            // out of every log line.
            label: HISTORICAL_URL,
            schema: responseSchema,
            providerId: PROVIDER_ID,
            context,
          });
          succeededBatches += 1;

          for (const [vendorKey, coin] of Object.entries(response.coins)) {
            const domainKey = vendorToDomain.get(vendorKey.toLowerCase());
            if (domainKey === undefined || coin.price <= 0) {
              continue;
            }
            quotes.set(domainKey, {
              priceUsd: numberToDecimalString(coin.price),
              // The observation's own instant, not the one requested. The whole
              // point of preferring this endpoint.
              updatedAt: toIsoTimestamp(coin.timestamp),
              confidence: typeof coin.confidence === 'number' ? coin.confidence : null,
            });
          }
        } catch (error) {
          failedBatches += 1;
          context.logger.warn('prices.history_batch_failed', {
            providerId: PROVIDER_ID,
            batchIndex: index,
            batchSize: batch.length,
            atUnixSeconds,
            ...describeError(error),
          });
        }
      }

      // Nothing got through. Raised rather than reported as a degraded success,
      // so the caller emits one "no history" warning instead of implying that
      // some changes were established — the ADR-019 rule, applied here too.
      if (succeededBatches === 0 && failedBatches > 0) {
        throw new ProviderError(
          'unavailable',
          PROVIDER_ID,
          `All ${failedBatches} historical price requests failed`,
        );
      }

      if (failedBatches > 0) {
        warnings.push({
          code: 'prices.history_partial',
          message: `${failedBatches} of ${batches.length} historical price batches could not be loaded, so some assets show no change figure.`,
        });
      }

      return { providerId: PROVIDER_ID, quotes, warnings, attemptedRefKeys };
    },
  };
}

function toVendorKey(ref: PriceRef, namespace: string): string | null {
  if (ref.contractAddress === null) {
    return NATIVE_REF_BY_CHAIN_ID[ref.chainId] ?? null;
  }
  return `${namespace}:${ref.contractAddress}`;
}

/**
 * Returns null rather than "now" when the provider omits a timestamp. Stamping
 * the current time would assert a freshness Nuxfolio has not verified, which is
 * exactly the kind of quiet claim this product is meant not to make.
 */
function toIsoTimestamp(unixSeconds: number | undefined): string | null {
  if (unixSeconds === undefined || !Number.isFinite(unixSeconds) || unixSeconds <= 0) {
    return null;
  }
  return new Date(unixSeconds * 1000).toISOString();
}
