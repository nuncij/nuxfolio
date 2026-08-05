import type { WalletAddress } from './address';
import { compareDecimal } from './money';
import { sumPortfolioTotals } from './normalize';
import type { AggregatePortfolio, FxQuote, PortfolioWarning } from './portfolio';

import type { BundleRequest } from './bundleRequest';

/**
 * Several wallets, totalled.
 *
 * **One canonical fact per member, everything else derived.** The member map is the
 * only stored state; totals, counts, failures and warnings are selectors over it.
 * An earlier draft stored a failure flag on each member *and* a list of failed
 * addresses *and* eight scalar counts — three representations of the same facts, any
 * two of which can drift apart under a refresh.
 *
 * **Four counts, and they are not interchangeable.** A member whose request finished
 * is *settled*; a member that returned a portfolio is *readable*. Saying "2 of 3
 * wallets" when one of those two failed counts a failure as coverage, which is the
 * defect review found twice on the network axis before it could happen here.
 */

export type BundleMemberState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly aggregate: AggregatePortfolio }
  | { readonly status: 'failed'; readonly message: string };

export type BundleState = {
  readonly request: BundleRequest;
  /** Keyed by lowercased address. The only stored facts. */
  readonly members: ReadonlyMap<string, BundleMemberState>;
};

export function createBundleState(request: BundleRequest): BundleState {
  return {
    request,
    members: new Map(
      request.addresses.map((address) => [address.toLowerCase(), { status: 'loading' as const }]),
    ),
  };
}

export function recordBundleMember(
  state: BundleState,
  address: string,
  result: BundleMemberState,
): BundleState {
  const key = address.toLowerCase();
  if (!state.members.has(key)) {
    // An address nobody asked for cannot join the bundle by arriving late.
    return state;
  }
  const members = new Map(state.members);
  members.set(key, result);
  return { ...state, members };
}

export type BundleProgress = {
  /** Members the URL asked for and that were accepted. */
  readonly total: number;
  /** Members whose request has finished, whether it succeeded or not. */
  readonly settled: number;
  /** Members that returned a portfolio. The only ones the figures cover. */
  readonly readable: number;
  /** Members that could not be read at all. */
  readonly failed: number;
  readonly complete: boolean;
};

export function selectBundleProgress(state: BundleState): BundleProgress {
  const states = [...state.members.values()];
  const readable = states.filter((member) => member.status === 'loaded').length;
  const failed = states.filter((member) => member.status === 'failed').length;

  return {
    total: states.length,
    settled: readable + failed,
    readable,
    failed,
    complete: readable + failed === states.length,
  };
}

/** Members in request order, so a shared link renders identically for everyone. */
export function selectBundleMembers(
  state: BundleState,
): readonly { readonly address: WalletAddress; readonly member: BundleMemberState }[] {
  return state.request.addresses.map((address) => ({
    address,
    member: state.members.get(address.toLowerCase()) ?? { status: 'loading' },
  }));
}

export function selectReadableAggregates(state: BundleState): readonly AggregatePortfolio[] {
  return selectBundleMembers(state).flatMap(({ member }) =>
    member.status === 'loaded' ? [member.aggregate] : [],
  );
}

export type BundleTotals = ReturnType<typeof sumPortfolioTotals>;

/**
 * The money figures, summed over the **readable** members only.
 *
 * A wallet that could not be read contributes nothing and is named separately. It is
 * never counted as zero: zero is a claim that a wallet holds nothing, and "we could
 * not read it" is not that claim.
 */
export function selectBundleTotals(state: BundleState): BundleTotals {
  return sumPortfolioTotals(selectReadableAggregates(state));
}

export function selectFailedMembers(
  state: BundleState,
): readonly { readonly address: WalletAddress; readonly message: string }[] {
  return selectBundleMembers(state).flatMap(({ address, member }) =>
    member.status === 'failed' ? [{ address, message: member.message }] : [],
  );
}

/**
 * The oldest observation behind any figure on screen.
 *
 * Taken from the member *chains*, not from `AggregatePortfolio.fetchedAt` and not
 * from the moment the bundle assembled. The aggregate endpoint stamps assembly time
 * even when its chains came from a nearly-expired cache, so trusting it would let a
 * bundle print "updated just now" about minute-old data. The per-chain progressive
 * aggregate already takes the oldest leaf for the same reason.
 */
export function selectBundleFetchedAt(state: BundleState): string | null {
  const timestamps = selectReadableAggregates(state)
    .flatMap((aggregate) => aggregate.chains.map((chain) => chain.fetchedAt))
    .filter((value) => !Number.isNaN(Date.parse(value)));

  if (timestamps.length === 0) {
    return null;
  }
  return timestamps.reduce((oldest, value) =>
    Date.parse(value) < Date.parse(oldest) ? value : oldest,
  );
}

/**
 * The rate to convert with, or null.
 *
 * A bundle is several independent responses, so unlike one wallet's five chains they
 * need not share a rate: one member may carry Friday's quote while another carries a
 * `rates.unavailable` warning saying figures are dollars only. Taking the first
 * non-null — which the per-wallet aggregate does, correctly, because there one
 * request produced them all — would put euro figures beside a warning denying them.
 *
 * So: convert only when every readable member that has a rate agrees on its date, and
 * every readable member has one. Otherwise no conversion, and the caller says why.
 */
export function selectBundleFxRate(state: BundleState): FxQuote | null {
  const aggregates = selectReadableAggregates(state);
  if (aggregates.length === 0) {
    return null;
  }

  const rates = aggregates.map((aggregate) => aggregate.fxRate);
  const first = rates[0];
  if (first === null || first === undefined) {
    return null;
  }
  const agreed = rates.every(
    (rate) => rate !== null && rate.asOf === first.asOf && rate.rate === first.rate,
  );
  return agreed ? first : null;
}

/**
 * Every warning from every readable member, prefixed with the wallet it came from.
 *
 * Coverage caveats have to travel with the total they qualify: a wallet can be read
 * and still have enumerated only a bundled token list, or stopped at the per-chain
 * asset ceiling. A headline without them would claim more completeness than it has.
 *
 * Identical messages from several wallets collapse into one — five identical
 * "checked a fixed list" notices is noise, and the aggregate view already does this
 * per chain.
 */
export function selectBundleWarnings(state: BundleState): readonly PortfolioWarning[] {
  const seen = new Map<string, PortfolioWarning>();

  for (const { address, member } of selectBundleMembers(state)) {
    if (member.status !== 'loaded') {
      continue;
    }
    for (const chain of member.aggregate.chains) {
      for (const warning of chain.warnings) {
        // Keyed by message rather than by code: the same code carries different
        // specifics per chain ("1,037 Arbitrum tokens" versus "5,078 Ethereum"),
        // and collapsing those would drop information.
        const key = `${warning.code}::${warning.message}`;
        const existing = seen.get(key);
        if (existing === undefined) {
          seen.set(key, {
            code: warning.code,
            message: `${shortAddress(address)}: ${warning.message}`,
          });
        } else if (!existing.message.startsWith('Several wallets')) {
          seen.set(key, { code: warning.code, message: `Several wallets: ${warning.message}` });
        }
      }
    }
  }

  return [...seen.values()];
}

/**
 * Whether the bundle may state a conclusion about itself.
 *
 * Two separate questions the UI must not conflate: whether every member has settled,
 * and whether any of them could be read. "No assets found" while two wallets are
 * still loading would speak for wallets nobody has read yet; the same sentence when
 * every wallet *failed* would be a claim about holdings when the truth is a load
 * failure.
 */
export function selectBundleConclusion(
  state: BundleState,
): 'pending' | 'all-failed' | 'empty' | 'holdings' {
  const progress = selectBundleProgress(state);
  if (!progress.complete) {
    return 'pending';
  }
  if (progress.readable === 0) {
    return 'all-failed';
  }
  return selectBundleTotals(state).assetCount > 0 ? 'holdings' : 'empty';
}

/** Ranked by value, so the breakdown leads with the wallet that matters most. */
export function selectBundleBreakdown(state: BundleState): readonly {
  readonly address: WalletAddress;
  readonly member: BundleMemberState;
  readonly totalValueUsd: string | null;
}[] {
  return [...selectBundleMembers(state)]
    .map(({ address, member }) => ({
      address,
      member,
      totalValueUsd: member.status === 'loaded' ? member.aggregate.totalValueUsd : null,
    }))
    .sort((a, b) => {
      // Unvalued members last but never hidden — a wallet that failed or holds
      // nothing still belongs on the list.
      if (a.totalValueUsd === null && b.totalValueUsd === null) {
        return 0;
      }
      if (a.totalValueUsd === null) {
        return 1;
      }
      if (b.totalValueUsd === null) {
        return -1;
      }
      return -compareDecimal(a.totalValueUsd, b.totalValueUsd);
    });
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
