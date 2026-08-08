import 'server-only';

import type { AaveMarket } from '@/config/aaveMarkets';
import type { WalletAddress } from '@/domain/address';
import {
  failedProtocolAccount,
  toProtocolAccount,
  type PositionsStatus,
  type ProtocolAccount,
} from '@/domain/protocolAccount';
import { toProtocolPosition, type ProtocolPosition } from '@/domain/protocolPosition';
import { isUnclaimed, toProtocolReward, type ProtocolReward } from '@/domain/protocolReward';

import { createRpcRequester, type RpcRequester } from '../balances/jsonRpc';
import { ProviderError, type ProviderContext } from '../types';

import { readMarketReserves } from './aaveReserves';
import { readMarketRewards } from './aaveRewards';

/**
 * Reads Aave v3 borrower state: collateral, debt, how close the wallet is to
 * liquidation, and which assets those totals are made of.
 *
 * **One `eth_call` per market for the totals**, `Pool.getUserAccountData(address)`.
 * That choice came from probing rather than from documentation: the alternative,
 * `UiPoolDataProvider.getUserReservesData`, does return per-token detail in one call
 * but its balances are *scaled* and need a second call for the liquidity indices to
 * mean anything — and the struct this code would have declared from memory fails to
 * decode against the deployed contract, because Aave 3.2 removed stable-rate
 * borrowing.
 *
 * **The totals are read first, and never wait on the breakdown.** They are what the
 * panel is for, so a breakdown that fails or runs out of budget costs the rows and
 * nothing else. The breakdown is read for every detail-capable market, including one
 * whose totals are zero: a supply with collateral switched off contributes to neither
 * total, so skipping on zero totals would hide exactly the position only the breakdown
 * can show. Measured at 134 ms across all three Ethereum markets, that is worth paying.
 *
 * The `getUserAccountData` selector is hard-coded rather than derived through an ABI
 * encoder. The call takes one address and returns six `uint256`s, so a decoder would be
 * more machinery than the thing it decodes — and the layout is asserted by tests
 * against real captured responses.
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
  /** Null when the chain has no Multicall3, which costs the breakdown but not the totals. */
  multicallAddress: WalletAddress | null;
  rpcUrls: readonly string[];
  dependencies: AaveDependencies;
}): Promise<readonly ProtocolAccount[]> {
  const { address, markets, multicallAddress, rpcUrls, dependencies } = input;

  if (markets.length === 0) {
    return [];
  }

  const requester =
    dependencies.requester ??
    createRpcRequester({ urls: rpcUrls, providerId: PROVIDER_ID, context: dependencies.context });

  // Sequential on purpose. It is at most three markets on the busiest chain, they share
  // one endpoint, and the chain-level scan already runs several chains at once — a
  // second layer of fan-out would multiply load on a public endpoint to save
  // milliseconds.
  const accounts: ProtocolAccount[] = [];
  for (const market of markets) {
    accounts.push(await readMarket({ address, market, multicallAddress, requester, dependencies }));
  }
  return accounts;
}

async function readMarket(input: {
  address: WalletAddress;
  market: AaveMarket;
  multicallAddress: WalletAddress | null;
  requester: RpcRequester;
  dependencies: AaveDependencies;
}): Promise<ProtocolAccount> {
  const { address, market, multicallAddress, requester, dependencies } = input;
  const identity = {
    chainId: market.chainId,
    marketId: market.marketId,
    marketName: market.name,
  };

  let raw;
  try {
    const response = await requester({
      method: 'eth_call',
      params: [
        {
          to: market.poolAddress,
          data: SELECTOR + address.slice(2).toLowerCase().padStart(64, '0'),
        },
        'latest',
      ],
    });
    raw = decodeAccountData(response);
  } catch (error) {
    // Logged, not swallowed: a market that silently stops answering would otherwise
    // look exactly like a wallet that closed its position.
    logFailure(dependencies, 'aave.market_read_failed', market.marketId, error);
    return failedProtocolAccount({
      ...identity,
      positionsStatus: canReadDetail(market, multicallAddress) ? 'failed' : 'unavailable',
      rewardsStatus: multicallAddress === null ? 'unavailable' : 'failed',
    });
  }

  // Concurrent, not sequential. They share nothing, and the rewards read costs three
  // round trips to the position read's two — in series every market would take five,
  // for a figure that is usually dust.
  const [detail, rewards] = await Promise.all([
    readPositions({ address, market, multicallAddress, requester, dependencies }),
    readRewards({ address, market, multicallAddress, requester, dependencies }),
  ]);

  return toProtocolAccount({ ...identity, raw, ...detail, ...rewards });
}

/**
 * The per-asset breakdown, or a stated reason there is none.
 *
 * Never throws. The totals are already in hand by the time this runs, and losing a
 * health factor because a second call timed out would be the failure this whole split
 * exists to prevent (review round 13, F5).
 */
async function readPositions(input: {
  address: WalletAddress;
  market: AaveMarket;
  multicallAddress: WalletAddress | null;
  requester: RpcRequester;
  dependencies: AaveDependencies;
}): Promise<{ positions: readonly ProtocolPosition[]; positionsStatus: PositionsStatus }> {
  const { market, multicallAddress, dependencies } = input;

  if (!canReadDetail(market, multicallAddress)) {
    return { positions: [], positionsStatus: 'unavailable' };
  }
  if (dependencies.context.deadline.hasExpired()) {
    // The budget is spent and the totals are already good. Asking anyway would trade a
    // page that renders for one that times out.
    return { positions: [], positionsStatus: 'failed' };
  }

  try {
    const reserves = await readMarketReserves({
      address: input.address,
      market,
      multicallAddress,
      requester: input.requester,
    });
    return {
      positions: reserves.map((reserve) =>
        toProtocolPosition({ ...reserve, asset: reserve.underlyingAsset }),
      ),
      positionsStatus: 'ok',
    };
  } catch (error) {
    logFailure(dependencies, 'aave.detail_read_failed', market.marketId, error);
    return { positions: [], positionsStatus: 'failed' };
  }
}

/**
 * Whether a breakdown is possible at all here. Both halves are permanent facts about
 * the deployment rather than about today's request, which is why either one missing
 * reads as `unavailable` rather than as a failure.
 */
function canReadDetail(
  market: AaveMarket,
  multicallAddress: WalletAddress | null,
): multicallAddress is WalletAddress {
  return market.detail !== undefined && multicallAddress !== null;
}

/**
 * Unclaimed incentives, or a stated reason there are none to show.
 *
 * Never throws, for the same reason `readPositions` does not: the totals are already in
 * hand, and a reward read is the least important thing on the panel.
 */
async function readRewards(input: {
  address: WalletAddress;
  market: AaveMarket;
  multicallAddress: WalletAddress | null;
  requester: RpcRequester;
  dependencies: AaveDependencies;
}): Promise<{ rewards: readonly ProtocolReward[]; rewardsStatus: PositionsStatus }> {
  const { market, multicallAddress, dependencies } = input;

  // Deliberately not `canReadDetail`: rewards need the addresses provider and the pool,
  // never the `UiPoolDataProvider`. Gating them together denied rewards to Optimism,
  // which of all seven markets has the most assets actually emitting.
  if (multicallAddress === null) {
    return { rewards: [], rewardsStatus: 'unavailable' };
  }
  if (dependencies.context.deadline.hasExpired()) {
    return { rewards: [], rewardsStatus: 'failed' };
  }

  try {
    const raw = await readMarketRewards({
      address: input.address,
      market,
      multicallAddress,
      requester: input.requester,
    });
    return {
      // `getAllUserRewards` answers for every reward the market ever configured, so most
      // entries are zero. A zero reward is not a reward.
      rewards: raw.filter(isUnclaimed).map(toProtocolReward),
      rewardsStatus: 'ok',
    };
  } catch (error) {
    logFailure(dependencies, 'aave.rewards_read_failed', market.marketId, error);
    return { rewards: [], rewardsStatus: 'failed' };
  }
}

function logFailure(
  dependencies: AaveDependencies,
  event: string,
  marketId: string,
  error: unknown,
): void {
  dependencies.context.logger?.warn(event, {
    marketId,
    errorName: error instanceof Error ? error.name : 'NonError',
    kind: error instanceof ProviderError ? error.kind : 'unknown',
  });
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
