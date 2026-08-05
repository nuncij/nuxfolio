import 'server-only';

import { z } from 'zod';

import type { WalletAddress } from '@/domain/address';

import { getServerEnv, type ServerEnv } from './env';
import arbitrumTokenList from './tokenlists/arbitrum.json';
import baseTokenList from './tokenlists/base.json';
import bscTokenList from './tokenlists/bsc.json';
import ethereumTokenList from './tokenlists/ethereum.json';
import optimismTokenList from './tokenlists/optimism.json';

/**
 * Chain registry.
 *
 * Adding an EVM chain means adding one entry here plus a generated token list;
 * no code branches on chain identity. Multicall3 is deployed at the same
 * address on every chain below — verified bytecode-identical — which is what
 * lets one balance adapter serve all of them.
 *
 * This module is server-only: it carries RPC endpoints that may embed
 * credentials. Clients receive {@link toPublicChain} projections instead.
 */

const tokenListEntrySchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  name: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
});

const tokenListSchema = z.object({
  source: z.string().min(1),
  sourceName: z.string().min(1),
  sourceVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  chainId: z.number().int().positive(),
  tokens: z.array(tokenListEntrySchema).min(1),
});

export type TokenListEntry = {
  readonly address: WalletAddress;
  readonly name: string;
  readonly symbol: string;
  readonly decimals: number;
  /**
   * Always null from a bundled list: logos are not rendered (ADR-009), so the
   * URLs are stripped at generation time rather than carried in the repo.
   */
  readonly logoUrl: string | null;
};

export type TokenList = {
  readonly source: string;
  readonly sourceName: string;
  readonly sourceVersion: string;
  readonly generatedAt: string;
  readonly tokens: readonly TokenListEntry[];
};

export type ChainConfig = {
  readonly chainId: number;
  /** URL-safe identifier, used in query strings and file names. */
  readonly slug: string;
  readonly name: string;
  readonly shortName: string;
  readonly nativeAsset: {
    readonly symbol: string;
    readonly name: string;
    readonly decimals: number;
  };
  readonly rpcUrls: readonly string[];
  /** Null when the chain has no Multicall3 deployment. */
  readonly multicall3Address: WalletAddress | null;
  readonly explorerUrl: string;
  readonly tokenList: TokenList;
};

/** The subset of chain data that is safe to serialise to the browser. */
export type PublicChainInfo = {
  readonly chainId: number;
  readonly slug: string;
  readonly name: string;
  readonly shortName: string;
  readonly nativeSymbol: string;
  readonly explorerUrl: string;
  readonly tokenListSize: number;
};

/**
 * Multicall3's canonical deterministic-deployment address. Verified present
 * with identical bytecode on all five registered chains.
 */
const MULTICALL3_ADDRESS: WalletAddress = '0xcA11bde05977b3631167028862bE2a173976CA11';

const ETHER = { symbol: 'ETH', name: 'Ether', decimals: 18 } as const;

function loadTokenList(raw: unknown, expectedChainId: number): TokenList {
  const parsed = tokenListSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Bundled token list for chain ${expectedChainId} is malformed; run \`pnpm tokens:generate\``,
    );
  }
  if (parsed.data.chainId !== expectedChainId) {
    throw new Error(
      `Bundled token list is for chain ${parsed.data.chainId}, expected ${expectedChainId}`,
    );
  }
  return {
    source: parsed.data.source,
    sourceName: parsed.data.sourceName,
    sourceVersion: parsed.data.sourceVersion,
    generatedAt: parsed.data.generatedAt,
    tokens: parsed.data.tokens.map((token) => ({
      address: token.address as WalletAddress,
      name: token.name,
      symbol: token.symbol,
      decimals: token.decimals,
      logoUrl: null,
    })),
  };
}

type ChainDefinition = {
  chainId: number;
  slug: string;
  name: string;
  shortName: string;
  nativeAsset: ChainConfig['nativeAsset'];
  defaultRpcUrls: readonly string[];
  explorerUrl: string;
  tokenListJson: unknown;
  configuredRpcUrls: (env: ServerEnv) => readonly string[] | undefined;
};

const DEFINITIONS: readonly ChainDefinition[] = [
  {
    chainId: 1,
    slug: 'ethereum',
    name: 'Ethereum Mainnet',
    shortName: 'Ethereum',
    nativeAsset: ETHER,
    defaultRpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com'],
    explorerUrl: 'https://etherscan.io',
    tokenListJson: ethereumTokenList,
    configuredRpcUrls: (env) => env.ETHEREUM_RPC_URLS,
  },
  {
    chainId: 8453,
    slug: 'base',
    name: 'Base',
    shortName: 'Base',
    nativeAsset: ETHER,
    defaultRpcUrls: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org'],
    explorerUrl: 'https://basescan.org',
    tokenListJson: baseTokenList,
    configuredRpcUrls: (env) => env.BASE_RPC_URLS,
  },
  {
    chainId: 42161,
    slug: 'arbitrum',
    name: 'Arbitrum One',
    shortName: 'Arbitrum',
    nativeAsset: ETHER,
    defaultRpcUrls: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc'],
    explorerUrl: 'https://arbiscan.io',
    tokenListJson: arbitrumTokenList,
    configuredRpcUrls: (env) => env.ARBITRUM_RPC_URLS,
  },
  {
    chainId: 10,
    slug: 'optimism',
    name: 'OP Mainnet',
    shortName: 'Optimism',
    nativeAsset: ETHER,
    defaultRpcUrls: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io'],
    explorerUrl: 'https://optimistic.etherscan.io',
    tokenListJson: optimismTokenList,
    configuredRpcUrls: (env) => env.OPTIMISM_RPC_URLS,
  },
  {
    chainId: 56,
    slug: 'bsc',
    name: 'BNB Smart Chain',
    shortName: 'BNB Chain',
    nativeAsset: { symbol: 'BNB', name: 'BNB', decimals: 18 },
    defaultRpcUrls: ['https://bsc-rpc.publicnode.com', 'https://bsc-dataseed.binance.org'],
    explorerUrl: 'https://bscscan.com',
    tokenListJson: bscTokenList,
    configuredRpcUrls: (env) => env.BSC_RPC_URLS,
  },
];

let registry: ReadonlyMap<number, ChainConfig> | undefined;

function buildRegistry(): ReadonlyMap<number, ChainConfig> {
  const env = getServerEnv();

  const entries = DEFINITIONS.map<[number, ChainConfig]>((definition) => [
    definition.chainId,
    {
      chainId: definition.chainId,
      slug: definition.slug,
      name: definition.name,
      shortName: definition.shortName,
      nativeAsset: definition.nativeAsset,
      rpcUrls: definition.configuredRpcUrls(env) ?? definition.defaultRpcUrls,
      multicall3Address: MULTICALL3_ADDRESS,
      explorerUrl: definition.explorerUrl,
      tokenList: loadTokenList(definition.tokenListJson, definition.chainId),
    },
  ]);

  return new Map(entries);
}

function getRegistry(): ReadonlyMap<number, ChainConfig> {
  registry ??= buildRegistry();
  return registry;
}

export function getChainConfig(chainId: number): ChainConfig | undefined {
  return getRegistry().get(chainId);
}

export function listChains(): readonly ChainConfig[] {
  return [...getRegistry().values()];
}

export function listChainIds(): readonly number[] {
  return DEFINITIONS.map((definition) => definition.chainId);
}

/** The chain shown when a request does not name one. */
export const DEFAULT_CHAIN_ID = 1;

export function toPublicChain(chain: ChainConfig): PublicChainInfo {
  return {
    chainId: chain.chainId,
    slug: chain.slug,
    name: chain.name,
    shortName: chain.shortName,
    nativeSymbol: chain.nativeAsset.symbol,
    explorerUrl: chain.explorerUrl,
    tokenListSize: chain.tokenList.tokens.length,
  };
}

export function listPublicChains(): readonly PublicChainInfo[] {
  return listChains().map(toPublicChain);
}
