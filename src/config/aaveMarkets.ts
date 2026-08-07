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
 * change constantly; these are proxy addresses that change when Aave governance deploys
 * a new market, which is rare and newsworthy. Nothing re-checks them: a market that
 * moves stops answering, which surfaces as a `failed` account rather than as a wrong
 * figure. That is the accepted risk, and it is bounded because every address here is a
 * call *target* — the numbers themselves are always read live.
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
  /**
   * The market's `PoolAddressesProvider`, derived from the pool itself rather than
   * copied from a deployment list, the `UiPoolDataProvider` that answers
   * `getUserReservesData` for it, and the market's own `AaveOracle`.
   *
   * **Optional, and its absence is meaningful.** A market without a verified trio
   * still reports account-level totals and a health factor (M5-1); it simply cannot
   * report which assets those are made of. Two of the seven markets are in that
   * state — the provider addresses this project had for them did not answer, and a
   * guessed address that silently decodes to nonsense is worse than a stated gap.
   *
   * The market's own price oracle is deliberately **not** here. It is read from the
   * addresses provider at request time instead, in the same batch as the balances, so
   * it costs nothing: a stale pool address stops answering and fails loudly, but a
   * stale oracle keeps returning plausible prices from a market nobody uses any more,
   * and the rows would quietly stop adding up to the totals (review round 13).
   */
  readonly detail?: {
    readonly addressesProvider: WalletAddress;
    readonly uiPoolDataProvider: WalletAddress;
  };
  /** When the addresses above were last verified against a live endpoint. */
  readonly verifiedOn: string;
};

const USD_8 = 8;

export const AAVE_MARKETS: readonly AaveMarket[] = [
  // Ethereum runs three markets. Reading only Core would report a wallet that
  // borrows on Prime or EtherFi as debt-free.
  {
    marketId: '1:core',
    detail: {
      addressesProvider: '0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e',
      uiPoolDataProvider: '0x3F78BBD206e4D3c504Eb854232EdA7e47E9Fd8FC',
    },
    name: 'Aave v3 Core',
    chainId: 1,
    poolAddress: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-07',
  },
  {
    marketId: '1:prime',
    detail: {
      addressesProvider: '0xcfBf336fe147D643B9Cb705648500e101504B16d',
      uiPoolDataProvider: '0x3F78BBD206e4D3c504Eb854232EdA7e47E9Fd8FC',
    },
    name: 'Aave v3 Prime',
    chainId: 1,
    poolAddress: '0x4e033931ad43597d96D6bcc25c280717730B58B1',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-07',
  },
  {
    marketId: '1:etherfi',
    detail: {
      addressesProvider: '0xeBa440B438Ad808101d1c451C1C5322c90BEFCdA',
      uiPoolDataProvider: '0x3F78BBD206e4D3c504Eb854232EdA7e47E9Fd8FC',
    },
    name: 'Aave v3 EtherFi',
    chainId: 1,
    poolAddress: '0x0AA97c284e98396202b6A04024F5E2c65026F3c0',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-07',
  },
  {
    marketId: '8453:base',
    detail: {
      addressesProvider: '0xe20fCBdBfFC4Dd138cE8b2E6FBb6CB49777ad64D',
      uiPoolDataProvider: '0x68100bD5345eA474D93577127C11F39FF8463e93',
    },
    name: 'Aave v3',
    chainId: 8453,
    poolAddress: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-07',
  },
  {
    marketId: '42161:arbitrum',
    detail: {
      addressesProvider: '0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb',
      uiPoolDataProvider: '0x5c5228aC8BC1528482514aF3e27E692495148717',
    },
    name: 'Aave v3',
    chainId: 42161,
    poolAddress: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
    baseCurrencyDecimals: USD_8,
    verifiedOn: '2026-08-07',
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

/** Markets whose per-token detail can be read. A subset of {@link AAVE_MARKETS}. */
export function marketsWithDetail(chainId: number): readonly AaveMarket[] {
  return marketsForChain(chainId).filter((market) => market.detail !== undefined);
}

/** Every market on one chain. Empty when Aave is not deployed there. */
export function marketsForChain(chainId: number): readonly AaveMarket[] {
  return AAVE_MARKETS.filter((market) => market.chainId === chainId);
}
