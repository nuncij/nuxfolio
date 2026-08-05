import { getAddress, isAddress } from 'viem';
import { z } from 'zod';

import type { WalletAddress } from '@/domain/address';
import type { PortfolioCoverage, PortfolioWarning } from '@/domain/portfolio';
import { mapWithConcurrency } from '@/server/concurrency';
import { describeError } from '@/server/logger';

import {
  ProviderError,
  type BalanceSnapshot,
  type PortfolioProvider,
  type ProviderContext,
  type RawBalance,
} from '../types';

import { createRpcRequester, type RpcRequester } from './jsonRpc';

/**
 * Balance discovery through Alchemy's indexed token API.
 *
 * This is the adapter that answers the question a plain node cannot: every
 * ERC-20 the address has ever received. It is opt-in because it needs a key.
 *
 * All fan-out here is bounded — pages, assets and concurrent metadata reads all
 * have ceilings. A wallet that has been airdropped ten thousand spam tokens
 * must not be able to turn one page load into ten thousand upstream calls, and
 * when a ceiling is hit the snapshot says `truncated` rather than `complete`.
 */

const PROVIDER_ID = 'alchemy';

/** Alchemy network slugs, keyed by chain ID. Vendor naming stays in-adapter. */
const NETWORK_BY_CHAIN_ID: Record<number, string> = {
  1: 'eth-mainnet',
  8453: 'base-mainnet',
  42161: 'arb-mainnet',
  10: 'opt-mainnet',
  56: 'bnb-mainnet',
};

/** Alchemy returns up to 100 balances per page. */
const MAX_PAGES = 5;
const METADATA_CONCURRENCY = 6;

const hexQuantitySchema = z.string().regex(/^0x[0-9a-fA-F]*$/);

const tokenBalancesSchema = z.object({
  address: z.string(),
  tokenBalances: z.array(
    z.object({
      contractAddress: z.string(),
      // Null or an error string when Alchemy could not read the balance.
      tokenBalance: hexQuantitySchema.nullable(),
      error: z.string().nullable().optional(),
    }),
  ),
  pageKey: z.string().nullable().optional(),
});

const tokenMetadataSchema = z.object({
  name: z.string().nullable().optional(),
  symbol: z.string().nullable().optional(),
  decimals: z.number().int().min(0).max(36).nullable().optional(),
  logo: z.string().nullable().optional(),
});

type TokenMetadata = z.infer<typeof tokenMetadataSchema>;

export function createAlchemyProvider(input: { apiKey: string }): PortfolioProvider {
  const { apiKey } = input;

  return {
    id: PROVIDER_ID,

    supportsChain(chainId: number): boolean {
      return NETWORK_BY_CHAIN_ID[chainId] !== undefined;
    },

    async fetchBalances({ address, chain, context }): Promise<BalanceSnapshot> {
      const network = NETWORK_BY_CHAIN_ID[chain.chainId];
      if (network === undefined) {
        throw new ProviderError(
          'misconfigured',
          PROVIDER_ID,
          `Chain ${chain.chainId} has no Alchemy network mapping`,
        );
      }

      const request = createRpcRequester({
        urls: [`https://${network}.g.alchemy.com/v2/${apiKey}`],
        providerId: PROVIDER_ID,
        context,
      });

      const warnings: PortfolioWarning[] = [];
      const balances: RawBalance[] = [];
      let coverage: PortfolioCoverage = 'complete';

      const nativeRaw = await readNativeBalance(request, address);
      if (nativeRaw > 0n) {
        balances.push({
          chainId: chain.chainId,
          contractAddress: null,
          name: chain.nativeAsset.name,
          symbol: chain.nativeAsset.symbol,
          decimals: chain.nativeAsset.decimals,
          raw: nativeRaw,
          logoUrl: null,
        });
      }

      const { holdings, truncated, truncationReason, unreadableEntries } = await readTokenHoldings({
        request,
        address,
        context,
        maxAssets: context.maxAssets,
      });

      if (truncated) {
        coverage = 'truncated';
        warnings.push({
          code: 'coverage.truncated',
          message: truncationReason,
        });
      }

      // An entry the indexer could not read is a holding that exists and is not
      // being shown. Reporting `complete` in that state would present an
      // understated portfolio as exhaustive.
      if (unreadableEntries > 0) {
        coverage = 'truncated';
        warnings.push({
          code: 'balances.unreadable_entries',
          message: `${unreadableEntries} token${unreadableEntries === 1 ? '' : 's'} could not be read from the indexer and ${unreadableEntries === 1 ? 'is' : 'are'} missing from this view.`,
        });
      }

      // Known tokens get their metadata from the bundled list, which turns the
      // common case into zero extra requests. Only unknown contracts are looked
      // up, and those are the ones worth spending calls on.
      const knownTokens = new Map(
        chain.tokenList.tokens.map((token) => [token.address.toLowerCase(), token]),
      );
      const unknown = holdings.filter(
        (holding) => !knownTokens.has(holding.contractAddress.toLowerCase()),
      );

      const metadataByAddress = new Map<string, TokenMetadata>();
      let metadataFailures = 0;

      await mapWithConcurrency(unknown, METADATA_CONCURRENCY, async (holding) => {
        if (context.deadline.hasExpired()) {
          metadataFailures += 1;
          return;
        }
        try {
          const metadata = await readTokenMetadata(request, holding.contractAddress);
          metadataByAddress.set(holding.contractAddress.toLowerCase(), metadata);
        } catch (error) {
          metadataFailures += 1;
          context.logger.warn('alchemy.metadata_failed', {
            providerId: PROVIDER_ID,
            ...describeError(error),
          });
        }
      });

      let skippedUnnamed = 0;

      for (const holding of holdings) {
        const key = holding.contractAddress.toLowerCase();
        const listed = knownTokens.get(key);
        const metadata = metadataByAddress.get(key);

        const decimals = listed?.decimals ?? metadata?.decimals;
        const symbol = listed?.symbol ?? metadata?.symbol;
        const name = listed?.name ?? metadata?.name;

        // Without decimals a raw balance cannot be interpreted at all, and a
        // guess would be a fabricated quantity. Skip and report instead.
        if (decimals === undefined || decimals === null || !symbol || !name) {
          skippedUnnamed += 1;
          continue;
        }

        balances.push({
          chainId: chain.chainId,
          contractAddress: holding.contractAddress,
          name,
          symbol,
          decimals,
          raw: holding.raw,
          logoUrl: listed?.logoUrl ?? metadata?.logo ?? null,
        });
      }

      if (metadataFailures > 0) {
        context.logger.warn('alchemy.metadata_incomplete', {
          providerId: PROVIDER_ID,
          metadataFailures,
        });
      }

      // Only a token actually missing from the output warrants a user-facing
      // warning; a failed metadata lookup for a token that was resolved from the
      // bundled list anyway costs the user nothing.
      if (skippedUnnamed > 0) {
        warnings.push({
          code: 'balances.metadata_incomplete',
          message: `${skippedUnnamed} token${skippedUnnamed === 1 ? ' was' : 's were'} skipped because ${skippedUnnamed === 1 ? 'its' : 'their'} name, symbol or decimals could not be resolved.`,
        });
        if (coverage === 'complete') {
          coverage = 'truncated';
        }
      }

      return {
        providerId: PROVIDER_ID,
        chainId: chain.chainId,
        coverage,
        balances,
        warnings,
      };
    },
  };
}

type Holding = { contractAddress: WalletAddress; raw: bigint };

async function readTokenHoldings(input: {
  request: RpcRequester;
  address: WalletAddress;
  context: ProviderContext;
  maxAssets: number;
}): Promise<HoldingsResult> {
  const { request, address, context, maxAssets } = input;
  const holdings: Holding[] = [];
  /**
   * Entries the provider could not read, or that were unusable. These are
   * *missing holdings*, not absent ones, so they are counted and reported —
   * dropping them silently would present an understated portfolio as complete.
   */
  let unreadableEntries = 0;
  let pageKey: string | undefined;
  let page = 0;

  for (;;) {
    page += 1;

    const params: unknown[] = [address, 'erc20'];
    if (pageKey !== undefined) {
      params.push({ pageKey });
    }

    const raw = await request({ method: 'alchemy_getTokenBalances', params });
    const parsed = tokenBalancesSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderError(
        'invalid-response',
        PROVIDER_ID,
        'alchemy_getTokenBalances returned an unexpected shape',
      );
    }

    // An answer about a different address is not an answer about this one — and
    // neither is an answer that does not say which address it is about. Both
    // must fail closed: attributing someone else's balances to this wallet is
    // the worst thing this adapter could do.
    const respondedAddress = parsed.data.address;
    if (
      !isAddress(respondedAddress, { strict: false }) ||
      getAddress(respondedAddress) !== address
    ) {
      throw new ProviderError(
        'invalid-response',
        PROVIDER_ID,
        'alchemy_getTokenBalances did not confirm it answered for the requested address',
      );
    }

    for (const entry of parsed.data.tokenBalances) {
      if (entry.error || entry.tokenBalance === null || entry.tokenBalance === undefined) {
        unreadableEntries += 1;
        continue;
      }
      if (!isAddress(entry.contractAddress, { strict: false })) {
        unreadableEntries += 1;
        continue;
      }
      const balance = entry.tokenBalance === '0x' ? 0n : BigInt(entry.tokenBalance);
      // A zero balance is genuinely not a holding, so it is not a gap.
      if (balance === 0n) {
        continue;
      }
      holdings.push({ contractAddress: getAddress(entry.contractAddress), raw: balance });
    }

    pageKey = parsed.data.pageKey ?? undefined;
    const morePagesExist = pageKey !== undefined;

    if (holdings.length >= maxAssets) {
      // Landing exactly on the cap with no further pages means nothing was
      // actually dropped, so it would be wrong to report truncation.
      const dropped = holdings.length - maxAssets;
      if (dropped === 0 && !morePagesExist) {
        return done(holdings, unreadableEntries, null);
      }
      return done(
        holdings.slice(0, maxAssets),
        unreadableEntries,
        `This wallet holds more than ${maxAssets} tokens; only the ${maxAssets} found first were loaded.`,
      );
    }

    if (!morePagesExist) {
      return done(holdings, unreadableEntries, null);
    }
    if (page >= MAX_PAGES) {
      return done(
        holdings,
        unreadableEntries,
        `Token discovery stopped after ${MAX_PAGES} pages, so some tokens are not shown.`,
      );
    }
    if (context.deadline.hasExpired()) {
      return done(
        holdings,
        unreadableEntries,
        'Token discovery ran out of time, so some tokens are not shown.',
      );
    }
  }
}

type HoldingsResult = {
  holdings: Holding[];
  truncated: boolean;
  truncationReason: string;
  unreadableEntries: number;
};

function done(
  holdings: Holding[],
  unreadableEntries: number,
  truncationReason: string | null,
): HoldingsResult {
  return {
    holdings,
    truncated: truncationReason !== null,
    truncationReason: truncationReason ?? '',
    unreadableEntries,
  };
}

async function readTokenMetadata(
  request: RpcRequester,
  contractAddress: WalletAddress,
): Promise<TokenMetadata> {
  const raw = await request({
    method: 'alchemy_getTokenMetadata',
    params: [contractAddress],
  });
  const parsed = tokenMetadataSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      'alchemy_getTokenMetadata returned an unexpected shape',
    );
  }
  return parsed.data;
}

async function readNativeBalance(request: RpcRequester, address: WalletAddress): Promise<bigint> {
  const result = await request({ method: 'eth_getBalance', params: [address, 'latest'] });
  const parsed = hexQuantitySchema.safeParse(result);
  if (!parsed.success) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      'eth_getBalance did not return a hex string',
    );
  }
  return parsed.data === '0x' ? 0n : BigInt(parsed.data);
}
