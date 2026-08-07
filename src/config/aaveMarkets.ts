import 'server-only';

import type { WalletAddress } from '@/domain/address';

/**
 * Aave v3 markets, by chain.
 *
 * A **market** is one `Pool` contract with its own reserves, its own oracle and its
 * own health factor. Ethereum runs three of them — Core, Prime and EtherFi — so a
 * registry keyed on chain alone would read one market and silently report a wallet as
 * debt-free while it borrows in another (review round 12, F-04).
 *
 * **Addresses are recorded with the date they were checked**, and deliberately not
 * refreshed automatically. The token lists have a weekly job because their *contents*
 * change constantly; these are proxy addresses that change when Aave governance
 * deploys a new market, which is rare and newsworthy. A scheduled refresh would be
 * machinery that never fires. CI asserts each pool still answers instead, which is the
 * proportionate version of the same guarantee.
 *
 * **Only USD-denominated markets belong here.** Aave's oracle interface permits a
 * different base currency — ETH at 1e18, for instance — which would make every
 * `…ValueUsd` field a lie for that market (round 12, F-08). `baseCurrencyDecimals`
 * records what was measured rather than what was assumed, and a market whose base is
 * not USD is left out rather than guessed at.
 */

export type AaveMarket = {
  /** Stable identity for the wire and for React keys: `${chainId}:${slug}`. */
  readonly marketId: string;
  /** What a person calls it on Aave's own interface. */
  readonly name: string;
  readonly chainId: number;
  /** The `Pool` contract — `getUserAccountData` lives here. */
  readonly poolAddress: WalletAddress;
  /**
   * Decimals of the market's base currency, measured through the oracle's
   * `BASE_CURRENCY_UNIT`. Every market registered here reported USD at 1e8 on
   * 2026-08-06.
   */
  readonly baseCurrencyDecimals: number;
  /** When the address above was last verified against a live endpoint. */
  readonly verifiedOn: string;
};

const USD_8 = 8;

export const AAVE_MARKETS: readonly AaveMarket[] = [
  // Ethereum runs three markets. Reading only Core would report a wallet that
  // borrows on Prime or EtherFi as debt-free.
  {
    marketId: '1:core',
    name: 'Aave v3 Core',
    chainId: 1,
    poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-06',
  },
  {
    marketId: '1:prime',
    name: 'Aave v3 Prime',
    chainId: 1,
    poolAddress: '0x4e033931ad43597d96D6bcc25c280717730B58B1',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-06',
  },
  {
    marketId: '1:etherfi',
    name: 'Aave v3 EtherFi',
    chainId: 1,
    poolAddress: '0x0AA97c284e98396202b6A04024F5E2c65026F3c0',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-06',
  },
  {
    marketId: '8453:base',
    name: 'Aave v3',
    chainId: 8453,
    poolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-06',
  },
  {
    marketId: '42161:arbitrum',
    name: 'Aave v3',
    chainId: 42161,
    poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-06',
  },
  {
    marketId: '10:optimism',
    name: 'Aave v3',
    chainId: 10,
    poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-06',
  },
  {
    marketId: '56:bnb',
    name: 'Aave v3',
    chainId: 56,
    poolAddress: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-06',
  },
];

/** Every market on one chain. Empty when Aave is not deployed there. */
export function marketsForChain(chainId: number): readonly AaveMarket[] {
  return AAVE_MARKETS.filter((market) => market.chainId === chainId);
}
