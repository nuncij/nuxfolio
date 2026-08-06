'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { shortenAddress } from '@/domain/address';
import {
  createBundleState,
  recordBundleMember,
  selectBundleBreakdown,
  selectBundleConclusion,
  selectBundleFetchedAt,
  selectBundleFxRate,
  selectBundleProgress,
  selectBundleTotals,
  selectBundleWarnings,
  selectFailedMembers,
  type BundleState,
} from '@/domain/bundle';
import { BUNDLE_MAX_MEMBERS, type BundleRequest } from '@/domain/bundleRequest';
import { DEFAULT_SORT, type AssetSort } from '@/domain/assetSort';
import { flattenAggregateAssets, withCrossChainShares } from '@/domain/normalize';
import { portfolioPath } from '@/domain/portfolioPath';
import type { PublicChainInfo } from '@/config/chains';
import { canShowEur, conversionNote } from '@/lib/displayContext';
import { formatRelativeTime } from '@/lib/format';
import { fetchBundleMembers } from '@/lib/portfolioClient';

import { AssetTable } from './AssetTable';
import {
  CurrencyToggle,
  readCurrency,
  readServerCurrency,
  subscribeToCurrency,
} from './CurrencyToggle';
import { DisplayProvider, useMoney } from './DisplayProvider';
import { PortfolioSkeleton } from './PortfolioSkeleton';
import { WarningPanel } from './WarningPanel';

/**
 * Several wallets, totalled.
 *
 * The honesty rules that took two review rounds to get right on the network axis all
 * apply again here, one axis out:
 *
 *  - **"1 of 3 wallets readable"**, never "2 of 3 settled". A wallet whose request
 *    finished by failing is not covered by the figures.
 *  - **No conclusion about the bundle until every member has settled.** "No assets
 *    found" while two wallets are still loading would speak for wallets nobody has
 *    read; the same words when every wallet *failed* would be a claim about holdings
 *    rather than about a failed load.
 *  - **No cross-cutting insight before then either.** A concentration figure over two
 *    of three wallets is true about two wallets and false about the bundle.
 *  - **Rows are per wallet position, not merged.** Two wallets holding USDC are two
 *    rows. One merged row cannot carry two different price qualities, two dispute
 *    verdicts or two change figures, and the fields that would have to hold them are
 *    singular.
 */
export function BundleView({
  request,
  chains,
  initialSort = DEFAULT_SORT,
}: {
  request: BundleRequest;
  chains: readonly PublicChainInfo[];
  /** Sort order from the URL, so a shared bundle link opens the way it was shared. */
  initialSort?: AssetSort;
}) {
  const [state, setState] = useState<BundleState>(() => createBundleState(request));
  const [loading, setLoading] = useState(true);
  const currency = useSyncExternalStore(subscribeToCurrency, readCurrency, readServerCurrency);

  const addresses = useMemo(() => [...request.addresses], [request.addresses]);

  /**
   * Loads every member, publishing as each lands.
   *
   * The accumulator is a **local of this run**, not component state, and no state is
   * set synchronously — both for the same reason. `react-hooks/set-state-in-effect`
   * forbids the synchronous version, and it is right to: this component is keyed on
   * the request, so a different bundle remounts with fresh state rather than needing
   * a reset, and an aborted run's results must not merge into the run that replaced
   * it. That rule has caught two real bugs in this codebase already (ADR-010,
   * ADR-016).
   */
  const load = useCallback(
    (signal: AbortSignal) => {
      let assembly = createBundleState(request);
      const aborted = () => signal.aborted;

      return fetchBundleMembers({
        addresses,
        signal,
        onSettled: ({ address, result }) => {
          if (aborted()) {
            return;
          }
          assembly = recordBundleMember(
            assembly,
            address,
            !result.ok
              ? { status: 'failed', message: result.error.message }
              : result.aggregate !== null
                ? { status: 'loaded', aggregate: result.aggregate }
                : // The bundle asks for every network, so an aggregate is what should
                  // come back. A single-chain payload here means the contract moved.
                  { status: 'failed', message: 'That wallet returned an unexpected shape.' },
          );
          setState(assembly);
        },
      }).then(() => {
        if (aborted()) {
          return;
        }
        setState(assembly);
        setLoading(false);
      });
    },
    [addresses, request],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const progress = selectBundleProgress(state);
  const totals = selectBundleTotals(state);
  const conclusion = selectBundleConclusion(state);
  const fxRate = selectBundleFxRate(state);
  const fetchedAt = selectBundleFetchedAt(state);
  const failed = selectFailedMembers(state);

  // Shares are recomputed against the bundle subtotal: a member's stored share is of
  // its own wallet, and three wallets' shares would sum to 300 %.
  const assets = useMemo(() => {
    const flattened = selectBundleBreakdown(state).flatMap(({ address, member }) =>
      member.status === 'loaded'
        ? flattenAggregateAssets(member.aggregate).map((asset) => ({
            ...asset,
            walletAddress: address,
          }))
        : [],
    );
    return withCrossChainShares(flattened, totals.totalValueUsd).map((asset, index) => ({
      ...asset,
      walletAddress: flattened[index]?.walletAddress ?? null,
    }));
  }, [state, totals.totalValueUsd]);

  return (
    <DisplayProvider currency={canShowEur(fxRate) ? currency : 'USD'} fxRate={fxRate}>
      <div className="space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-ink">{progress.total} wallets combined</h1>
            <p className="mt-0.5 text-xs text-ink-subtle">
              {fetchedAt === null ? 'Loading…' : `Oldest reading ${formatRelativeTime(fetchedAt)}`}
            </p>
          </div>
          {canShowEur(fxRate) ? <CurrencyToggle /> : null}
        </header>

        <RequestNotices request={request} />

        {conclusion === 'pending' && progress.readable === 0 ? <PortfolioSkeleton /> : null}

        {conclusion === 'all-failed' ? (
          <AllFailed failed={failed} />
        ) : progress.readable > 0 || conclusion === 'empty' ? (
          <>
            <BundleSummary
              totals={totals}
              progress={progress}
              conversion={conversionNote({ currency, fxRate })}
              fxUnavailable={!canShowEur(fxRate) && progress.readable > 1}
            />
            <BundleBreakdown state={state} chains={chains} />
            <WarningPanel warnings={selectBundleWarnings(state)} />
            {assets.length > 0 ? (
              <AssetTable
                assets={assets}
                explorerUrl={null}
                showChain
                showWallet
                initialSort={initialSort}
              />
            ) : conclusion === 'empty' ? (
              <NothingHeld count={progress.readable} />
            ) : null}
          </>
        ) : null}

        {loading && progress.readable > 0 && !progress.complete ? (
          <p role="status" className="text-xs text-ink-subtle">
            Still loading {progress.total - progress.settled} of {progress.total} wallets…
          </p>
        ) : null}
      </div>
    </DisplayProvider>
  );
}

/**
 * What the URL asked for that did not make it.
 *
 * Shown before anything else. A reader who opened a shared link needs to know that a
 * segment was rejected, or a repeat removed, before they read a total that excludes it.
 */
function RequestNotices({ request }: { request: BundleRequest }) {
  const notes = [
    ...request.rejected.map((entry) =>
      entry.reason === 'ens-name'
        ? `“${entry.input}” is an ENS name. Bundles take addresses only — look the name up on its own first.`
        : entry.reason === 'too-many-segments'
          ? `${entry.input} entries in the link were ignored.`
          : `“${entry.input}” is not a wallet address and was left out.`,
    ),
    request.duplicateCount > 0
      ? `${request.duplicateCount} repeated ${request.duplicateCount === 1 ? 'address was' : 'addresses were'} counted once, not twice.`
      : null,
    request.omittedCount > 0
      ? `A bundle holds ${BUNDLE_MAX_MEMBERS} wallets; ${request.omittedCount} more in the link ${request.omittedCount === 1 ? 'was' : 'were'} left out.`
      : null,
  ].filter((note): note is string => note !== null);

  if (notes.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="About this link"
      className="rounded-xl border border-caution-line bg-caution-surface p-4"
    >
      <ul className="space-y-1.5 text-sm text-caution">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </section>
  );
}

function BundleSummary({
  totals,
  progress,
  conversion,
  fxUnavailable,
}: {
  totals: ReturnType<typeof selectBundleTotals>;
  progress: ReturnType<typeof selectBundleProgress>;
  conversion: string | null;
  fxUnavailable: boolean;
}) {
  const money = useMoney();

  return (
    <section aria-label="Bundle summary">
      <div className="rounded-xl border border-line bg-surface p-4">
        <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">
          {totals.unpricedAssetCount > 0 ? 'Estimated value (priced assets)' : 'Estimated value'}
        </p>
        <p className="numeric mt-2 text-2xl font-semibold text-ink">
          {money(totals.totalValueUsd)}
        </p>
        <p className="mt-1 text-xs text-ink-subtle">
          {/*
            "readable", never "settled". A wallet whose request finished by failing has
            settled and is not covered by this figure.
          */}
          {progress.readable} of {progress.total} wallets readable
          {progress.failed > 0
            ? ` · ${progress.failed} unavailable and not counted`
            : progress.complete
              ? ''
              : ' so far'}
        </p>
      </div>

      <p className="mt-3 text-xs text-ink-subtle">
        Values are estimates derived from public market data and can differ from what you would
        actually receive. Nuxfolio reads public chain data only.
        {conversion === null ? null : ` ${conversion}`}
        {fxUnavailable
          ? ' Euro conversion is unavailable for this bundle because the wallets did not return the same reference rate.'
          : null}
      </p>
    </section>
  );
}

/** Per-wallet value, mirroring the per-network breakdown on a single portfolio. */
function BundleBreakdown({
  state,
  chains,
}: {
  state: BundleState;
  chains: readonly PublicChainInfo[];
}) {
  const money = useMoney();
  const rows = selectBundleBreakdown(state);

  return (
    <section aria-label="Value by wallet" className="overflow-hidden rounded-xl border border-line">
      <ul className="divide-y divide-line">
        {rows.map(({ address, member, totalValueUsd }) => (
          <li key={address} className="flex items-center justify-between gap-3 px-4 py-3">
            <a
              // Plain anchor, as on the saved-wallets panel: a prefetching link would
              // send every address in the bundle to the server before any click.
              href={portfolioPath({ address })}
              className="numeric min-w-0 truncate text-sm text-ink hover:text-accent"
            >
              {shortenAddress(address)}
            </a>
            <span className="shrink-0 text-right">
              {member.status === 'loading' ? (
                <span className="text-xs text-ink-subtle">Loading…</span>
              ) : member.status === 'failed' ? (
                <>
                  <span className="block text-xs text-caution">Unavailable</span>
                  <span className="block text-[11px] text-ink-subtle">
                    Not counted in the total
                  </span>
                </>
              ) : (
                <>
                  <span className="numeric block text-sm font-medium text-ink">
                    {money(totalValueUsd)}
                  </span>
                  <span className="block text-[11px] text-ink-subtle">
                    {member.aggregate.chains.length} of {chains.length} networks read
                  </span>
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Every wallet failed.
 *
 * Deliberately not the "no assets found" or "no prices available" state: nothing was
 * read, so any statement about holdings or prices would be a claim the data cannot
 * support. This is a load failure and says so.
 */
function AllFailed({
  failed,
}: {
  failed: readonly { readonly address: string; readonly message: string }[];
}) {
  return (
    <section
      role="alert"
      aria-label="Bundle could not be loaded"
      className="rounded-xl border border-caution-line bg-caution-surface p-5"
    >
      <h2 className="text-sm font-semibold text-caution">None of these wallets could be read</h2>
      <p className="mt-1.5 text-sm text-ink-muted">
        This is a loading problem, not a statement about what the wallets hold.
      </p>
      <ul className="mt-3 space-y-1 text-xs text-ink-subtle">
        {failed.map(({ address, message }) => (
          <li key={address} className="numeric">
            {shortenAddress(address)} — <span className="font-sans">{message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NothingHeld({ count }: { count: number }) {
  return (
    <section aria-label="Assets" className="rounded-xl border border-line bg-surface p-6">
      <h2 className="text-base font-semibold text-ink">No assets found</h2>
      <p className="mt-2 text-sm text-ink-muted">
        {/* Scoped to the wallets that answered, never to "these wallets". */}
        None of the {count === 1 ? 'wallet' : `${count} wallets`} that could be read holds any of
        the tokens Nuxfolio checks.
      </p>
    </section>
  );
}
