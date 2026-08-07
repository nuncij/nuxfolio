import 'server-only';

import type { AaveMarket } from '@/config/aaveMarkets';
import type { WalletAddress } from '@/domain/address';
import {
  failedProtocolAccount,
  toProtocolAccount,
  type ProtocolAccount,
} from '@/domain/protocolAccount';

import { createRpcRequester, type RpcRequester } from '../balances/jsonRpc';
import { ProviderError, type ProviderContext } from '../types';

/**
 * Reads Aave v3 borrower state: collateral, debt, and how close the wallet is to
 * liquidation.
 *
 * **One `eth_call` per market**, `Pool.getUserAccountData(address)`. That choice came
 * from probing rather than from documentation: the alternative,
 * `UiPoolDataProvider.getUserReservesData`, does return per-token detail in one call
 * but its balances are *scaled* and need a second call for the liquidity indices to
 * mean anything — and the struct this code would have declared from memory fails to
 * decode against the deployed contract, because Aave 3.2 removed stable-rate
 * borrowing. Per-token detail is M5-2, with its own arithmetic and its own tests.
 *
 * The function selector is hard-coded rather than derived through an ABI encoder. The
 * call takes one address and returns six `uint256`s, so a decoder would be more
 * machinery than the thing it decodes — and the layout is asserted by tests against
 * real captured responses.
 */

const PROVIDER_ID = 'aave-v3';

/** `getUserAccountData(address)` — first four bytes of the keccak hash. */
const SELECTOR = '0xbf92857c';

/** Six `uint256` words: collateral, debt, borrowable, threshold, ltv, health. */
const EXPECTED_WORDS = 6;

export type AaveDependencies = {
  readonly context: ProviderContext;
  /** Injected by tests; production builds one per chain from the registry. */
  readonly requester?: RpcRequester;
};

/**
 * Reads every market on one chain.
 *
 * Never throws. A market that cannot be read becomes a `failed` account, because the
 * page needs a sentence rather than an exception — and because "we could not ask" and
 * "there is no debt" are different answers that must reach the user as different
 * things.
 */
export async function readAaveAccounts(input: {
  address: WalletAddress;
  markets: readonly AaveMarket[];
  rpcUrls: readonly string[];
  dependencies: AaveDependencies;
}): Promise<readonly ProtocolAccount[]> {
  const { address, markets, rpcUrls, dependencies } = input;

  if (markets.length === 0) {
    return [];
  }

  const requester =
    dependencies.requester ??
    createRpcRequester({ urls: rpcUrls, providerId: PROVIDER_ID, context: dependencies.context });

  // Sequential on purpose. It is at most three calls on the busiest chain, they share
  // one endpoint, and the chain-level scan already runs several chains at once — a
  // second layer of fan-out would multiply load on a public endpoint to save
  // milliseconds.
  const accounts: ProtocolAccount[] = [];
  for (const market of markets) {
    accounts.push(await readMarket({ address, market, requester, dependencies }));
  }
  return accounts;
}

async function readMarket(input: {
  address: WalletAddress;
  market: AaveMarket;
  requester: RpcRequester;
  dependencies: AaveDependencies;
}): Promise<ProtocolAccount> {
  const { address, market, requester, dependencies } = input;
  const identity = {
    chainId: market.chainId,
    marketId: market.marketId,
    marketName: market.name,
  };

  try {
    const raw = await requester({
      method: 'eth_call',
      params: [
        {
          to: market.poolAddress,
          data: SELECTOR + address.slice(2).toLowerCase().padStart(64, '0'),
        },
        'latest',
      ],
    });

    return toProtocolAccount({ ...identity, raw: decodeAccountData(raw) });
  } catch (error) {
    // Logged, not swallowed: a market that silently stops answering would otherwise
    // look exactly like a wallet that closed its position.
    dependencies.context.logger?.warn('aave.market_read_failed', {
      marketId: market.marketId,
      errorName: error instanceof Error ? error.name : 'NonError',
      kind: error instanceof ProviderError ? error.kind : 'unknown',
    });
    return failedProtocolAccount(identity);
  }
}

/**
 * Splits the response into its six words and keeps the three that matter.
 *
 * A short or malformed response is an error rather than a zero. Decoding `0x` — what
 * an address with no contract returns — as "no debt" would report every wallet on a
 * chain with a wrong pool address as debt-free.
 */
export function decodeAccountData(raw: unknown): {
  totalCollateralBase: string;
  totalDebtBase: string;
  healthFactor: string;
} {
  if (typeof raw !== 'string' || !raw.startsWith('0x')) {
    throw new ProviderError('unavailable', PROVIDER_ID, 'eth_call did not return hex');
  }

  const body = raw.slice(2);
  if (body.length !== EXPECTED_WORDS * 64) {
    throw new ProviderError(
      'unavailable',
      PROVIDER_ID,
      `expected ${EXPECTED_WORDS} words, got ${body.length / 64}`,
    );
  }

  const word = (index: number): string =>
    BigInt(`0x${body.slice(index * 64, (index + 1) * 64)}`).toString();

  return {
    totalCollateralBase: word(0),
    totalDebtBase: word(1),
    // Words 2–4 are available borrows, liquidation threshold and LTV. None is shown:
    // each needs its own explanation to be meaningful, and none answers a question
    // this milestone set out to answer.
    healthFactor: word(5),
  };
}
