'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import type { PublicChainInfo } from '@/config/chains';
import { shortenAddress, type WalletAddress } from '@/domain/address';
import { flattenAggregateAssets, withCrossChainShares } from '@/domain/normalize';
import {
  ALL_CHAINS,
  type AggregatePortfolio,
  type ApiError,
  type FxQuote,
  type PortfolioWarning,
} from '@/domain/portfolio';
import {
  createProgressiveAggregate,
  recordChainResult,
  selectAggregateError,
  selectAggregatePortfolio,
  selectAggregateProgress,
  type AggregateProgress,
  type ProgressiveAggregateState,
} from '@/domain/progressiveAggregate';
import { selectPortfolioViewState, type PortfolioData } from '@/domain/viewState';
import { DEFAULT_SORT, type AssetSort } from '@/domain/assetSort';
import { canShowEur } from '@/lib/displayContext';
import { formatRelativeTime } from '@/lib/format';
import {
  ABORTED,
  fetchChainPortfolios,
  fetchPortfolioFromApi,
  type ChainSelection,
  type PortfolioFetchResult,
} from '@/lib/portfolioClient';

import { AssetTable } from './AssetTable';
import {
  CurrencyToggle,
  readCurrency,
  readServerCurrency,
  subscribeToCurrency,
} from './CurrencyToggle';
import { CopyAddressButton } from './CopyAddressButton';
import { DisplayProvider } from './DisplayProvider';
import { SaveWalletButton } from './SaveWalletButton';
import { ChainBreakdown } from './ChainBreakdown';
import { ChainSelector } from './ChainSelector';
import { PortfolioSkeleton } from './PortfolioSkeleton';
import { PortfolioSummary } from './PortfolioSummary';
import { PriceSourceCredit } from './PriceSourceCredit';
import { LendingPanel } from './LendingPanel';
import { StakedPanel } from './StakedPanel';
import { WarningPanel } from './WarningPanel';

/**
 * Renders one wallet's portfolio, for a single network or across all of them.
 *
 * Requesting and validating the data lives in `lib/portfolioClient`, and
 * combining per-chain results in `domain/progressiveAggregate`; what is left here
 * is the state transitions. State is only ever written from a promise callback or
 * a user event, never synchronously inside the effect, which is what keeps a
 * mount from cascading extra renders (ADR-010).
 *
 * The all-networks view is assembled here rather than on the server: one request
 * per network, each rendered as it lands, so the view no longer waits for the
 * slowest chain. `fetchChainPortfolios` documents what that costs.
 */
export function PortfolioView({
  address,
  ensName = null,
  selectedChainId,
  chains,
  initialSort = DEFAULT_SORT,
}: {
  address: WalletAddress;
  /**
   * The ENS name this wallet was reached by, already re-validated server side.
   * Labelled "entered as" in the header: a forward resolution says the name
   * pointed here when it was looked up, not that this address owns the name, and
   * the parameter itself is only as trustworthy as whoever shared the link.
   */
  ensName?: string | null;
  selectedChainId: ChainSelection;
  chains: readonly PublicChainInfo[];
  /** Sort order from the URL, so a shared link opens the way it was shared. */
  initialSort?: AssetSort;
}) {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [error, setError] = useState<ApiError['error'] | null>(null);
  // Starts true because the mount effect fetches immediately. The page keys this
  // component by address and selection, so a navigation remounts it and this
  // default is correct again rather than carrying the previous view's state.
  const [loading, setLoading] = useState(true);
  /**
   * How many networks the figures currently on screen cover. Written only
   * together with `data`, so it always describes what is rendered rather than
   * what is in flight; null in single-network mode.
   */
  const [shownNetworks, setShownNetworks] = useState<AggregateProgress | null>(null);

  // Memoised because it feeds the effect's dependencies: rebuilding the list on
  // every render would restart the fan-out on every state update.
  const requestedChains = useMemo(
    () => chains.map((chain) => ({ chainId: chain.chainId, name: chain.name })),
    [chains],
  );

  const applyChainResult = useCallback((result: PortfolioFetchResult) => {
    if (!result.ok) {
      setError(result.error);
    } else {
      setData(
        result.aggregate !== null
          ? { scope: 'aggregate', aggregate: result.aggregate }
          : { scope: 'chain', portfolio: result.portfolio },
      );
      setError(null);
    }
    setLoading(false);
  }, []);

  /**
   * Publishes what the per-chain results add up to so far.
   *
   * A partial view is held back until it has an asset to show: an aggregate of
   * networks that are all still empty renders as "no assets found", which the
   * next network then contradicts. `allowPartial` is false for a refresh that
   * already has a complete view on screen — replacing it with one network's
   * subtotal would read as the total collapsing.
   */
  const publishAggregate = useCallback(
    (assembly: ProgressiveAggregateState, allowPartial: boolean) => {
      const progress = selectAggregateProgress(assembly);
      const aggregate = selectAggregatePortfolio(assembly);

      if (aggregate !== null && (progress.complete || (allowPartial && aggregate.assetCount > 0))) {
        setData({ scope: 'aggregate', aggregate });
        setShownNetworks(progress);
      }

      // Only a total failure is an error: a single network that failed is
      // rendered as an unavailable network inside the view.
      setError(progress.complete ? selectAggregateError(assembly) : null);
    },
    [],
  );

  const load = useCallback(
    (options: { signal?: AbortSignal; allowPartial: boolean }) => {
      const aborted = () => options.signal?.aborted === true;

      if (selectedChainId !== ALL_CHAINS) {
        void fetchPortfolioFromApi({
          address,
          chainId: selectedChainId,
          signal: options.signal,
        }).then((result) => {
          // An aborted request belongs to a view that is going away; writing
          // state on its behalf would fight the request that replaced it.
          if (result !== ABORTED && !aborted()) {
            applyChainResult(result);
          }
        });
        return;
      }

      // The reducer state is a local of this run, not component state: a refresh
      // starts from an empty one, and an aborted run's results are dropped
      // instead of merging into the run that replaced it.
      let assembly = createProgressiveAggregate({ address, chains: requestedChains });

      void fetchChainPortfolios({
        address,
        chainIds: requestedChains.map((chain) => chain.chainId),
        signal: options.signal,
        onSettled: (result) => {
          if (aborted()) {
            return;
          }
          assembly = recordChainResult(assembly, result);
          publishAggregate(assembly, options.allowPartial);
        },
      }).then(() => {
        if (aborted()) {
          return;
        }
        // The last publish; also the one that surfaces an all-networks failure.
        publishAggregate(assembly, options.allowPartial);
        setLoading(false);
      });
    },
    [address, selectedChainId, requestedChains, applyChainResult, publishAggregate],
  );

  /** Manual refresh. A user event, so a synchronous state update is fine. */
  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    load({ allowPartial: data === null });
  }, [load, data]);

  useEffect(() => {
    const controller = new AbortController();
    load({ signal: controller.signal, allowPartial: true });
    return () => controller.abort();
  }, [load]);

  const state = selectPortfolioViewState({ requested: true, loading, data, error });
  const activeChain =
    selectedChainId === ALL_CHAINS
      ? null
      : (chains.find((chain) => chain.chainId === selectedChainId) ?? null);
  const fetchedAt = data === null ? null : readFetchedAt(data);
  // The rate travels on the payload (never fetched from the browser — ADR-009),
  // so it is null until data arrives and the toggle appears with it.
  const fxRate = data === null ? null : readFxRate(data);
  const currency = useSyncExternalStore(subscribeToCurrency, readCurrency, readServerCurrency);

  return (
    <DisplayProvider currency={canShowEur(fxRate) ? currency : 'USD'} fxRate={fxRate}>
      <div className="space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="numeric truncate text-lg font-semibold text-ink" title={address}>
              {ensName !== null ? (
                <>
                  <span className="font-normal text-ink-subtle">entered as </span>
                  {ensName}
                  <span className="text-ink-subtle"> · </span>
                </>
              ) : null}
              {shortenAddress(address)}
            </h1>
            <p className="mt-0.5 text-xs text-ink-subtle">
              <a
                href={`${(activeChain ?? chains[0])?.explorerUrl ?? ''}/address/${address}`}
                target="_blank"
                rel="noreferrer noopener"
                className="hover:text-ink-muted hover:underline"
              >
                View on block explorer
              </a>
              {fetchedAt !== null ? ` · updated ${formatRelativeTime(fetchedAt)}` : null}
            </p>
          </div>

          {/*
            Wraps, and each control may shrink. The header carried three controls when
            it was written and now carries five, which overflowed a 390 px screen — the
            narrow-viewport test caught it rather than a phone did.
          */}
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            <ChainSelector
              chains={chains}
              selected={selectedChainId}
              address={address}
              ensName={ensName}
            />
            <CopyAddressButton address={address} />
            <SaveWalletButton address={address} ensName={ensName} />
            {canShowEur(fxRate) ? <CurrencyToggle /> : null}
            <button
              type="button"
              onClick={refresh}
              disabled={loading}
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm text-ink-muted hover:text-ink disabled:opacity-60"
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </header>

        {state.kind === 'loading' ? <PortfolioSkeleton /> : null}

        {state.kind === 'error' ? (
          <ErrorState error={state.error} retryable={state.retryable} onRetry={refresh} />
        ) : null}

        {state.kind === 'empty' ? <EmptyState data={state.data} /> : null}

        {state.kind === 'ready' || state.kind === 'unpriced' ? (
          <PortfolioBody
            data={state.data}
            explorerUrl={activeChain?.explorerUrl ?? null}
            shownNetworks={shownNetworks}
            ensName={ensName}
            initialSort={initialSort}
          />
        ) : null}
      </div>
    </DisplayProvider>
  );
}

/** Reads the rate off whichever payload shape arrived. */
function readFxRate(data: PortfolioData): FxQuote | null {
  return data.scope === 'chain' ? data.portfolio.fxRate : data.aggregate.fxRate;
}

function PortfolioBody({
  data,
  explorerUrl,
  shownNetworks,
  ensName,
  initialSort,
}: {
  data: PortfolioData;
  explorerUrl: string | null;
  shownNetworks: AggregateProgress | null;
  ensName: string | null;
  initialSort: AssetSort;
}) {
  if (data.scope === 'chain') {
    return (
      <>
        <PortfolioSummary portfolio={data.portfolio} />
        <LendingPanel accounts={data.portfolio.protocolAccounts} />
        <StakedPanel
          positions={data.portfolio.stakedPositions}
          status={data.portfolio.stakedStatus}
        />
        <WarningPanel warnings={data.portfolio.warnings} />
        <AssetTable
          assets={data.portfolio.assets}
          explorerUrl={explorerUrl}
          initialSort={initialSort}
        />
        <PriceSourceCredit
          assets={data.portfolio.assets}
          priceSource={data.portfolio.priceSource}
        />
      </>
    );
  }

  const { aggregate } = data;
  // Shares are recomputed against the cross-chain total; each asset's stored
  // share is relative to its own chain and would sum to 100 % per network.
  const assets = withCrossChainShares(flattenAggregateAssets(aggregate), aggregate.totalValueUsd);

  return (
    <>
      {shownNetworks !== null && !shownNetworks.complete ? (
        <PartialViewNotice progress={shownNetworks} />
      ) : null}
      <PortfolioSummary aggregate={aggregate} progress={shownNetworks} />
      <ChainBreakdown aggregate={aggregate} ensName={ensName} />
      {/* Flattened across networks: a wallet borrows on a market, and which chain
          that market sits on is already in its name. The accounts arrive as each
          chain settles, so this grows with the aggregate rather than waiting. */}
      <LendingPanel accounts={aggregate.chains.flatMap((chain) => chain.protocolAccounts)} />
      <StakedPanel
        positions={aggregate.chains.flatMap((chain) => chain.stakedPositions)}
        // Any chain that failed makes the whole panel say so: a staked position missing
        // from one network is missing from the page, and the reader cannot tell which.
        status={
          aggregate.chains.some((chain) => chain.stakedStatus === 'failed')
            ? 'failed'
            : aggregate.chains.some((chain) => chain.stakedStatus === 'ok')
              ? 'ok'
              : 'unavailable'
        }
      />
      <WarningPanel warnings={collectAggregateWarnings(aggregate)} />
      <AssetTable assets={assets} explorerUrl={null} showChain initialSort={initialSort} />
      <PriceSourceCredit
        assets={assets}
        priceSource={
          aggregate.chains.find((chain) => chain.priceSource !== null)?.priceSource ?? null
        }
      />
    </>
  );
}

/**
 * Says out loud that the figures below are incomplete.
 *
 * Every number on the page is a sum over the networks that have answered, so
 * without this line a partially loaded view is indistinguishable from a finished
 * one that happens to be smaller — a total that quietly omits a network is
 * exactly the error this product is built to avoid. `aria-live` announces each
 * step, so the same information reaches a screen reader.
 */
function PartialViewNotice({ progress }: { progress: AggregateProgress }) {
  return (
    <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-ink-subtle">
      <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-accent" />
      Loading… ({progress.settled} of {progress.total} networks)
    </p>
  );
}

/**
 * One warning list for the whole view.
 *
 * Every network raises the same coverage caveat, so repeating it five times
 * buries the caveats that differ. It is combined into a single line naming the
 * total the lists cover; everything chain-specific keeps its network prefix, and
 * nothing is dropped.
 */
export function collectAggregateWarnings(aggregate: AggregatePortfolio): PortfolioWarning[] {
  const coverage = aggregate.chains.filter((chain) =>
    chain.warnings.some((warning) => warning.code === COVERAGE_CODE),
  );

  const combined: PortfolioWarning[] = [];

  if (coverage.length > 0) {
    const totalTokens = coverage.reduce((sum, chain) => sum + countListedTokens(chain), 0);
    combined.push({
      code: COVERAGE_CODE,
      message:
        `Without an indexer API key, Nuxfolio checks fixed token lists — ` +
        `${totalTokens.toLocaleString('en-US')} tokens across ${listNames(coverage)}. ` +
        `Tokens outside those lists are not shown.`,
    });
  }

  const globalsSeen = new Set<string>();

  for (const chain of aggregate.chains) {
    for (const warning of chain.warnings) {
      if (warning.code === COVERAGE_CODE) {
        continue;
      }
      // A statement about the product rather than about this network's data. Every
      // chain carries an identical copy, so namespacing it by chain the way the rest
      // are would print the same sentence five times.
      if (GLOBAL_CODES.has(warning.code)) {
        if (!globalsSeen.has(warning.code)) {
          globalsSeen.add(warning.code);
          combined.push(warning);
        }
        continue;
      }
      combined.push({
        code: `${chain.chainId}:${warning.code}`,
        message: SELF_DESCRIBING_CODES.has(warning.code)
          ? warning.message
          : `${chain.chainName}: ${warning.message}`,
      });
    }
  }

  return combined;
}

/**
 * Warnings that describe the product, not a network.
 *
 * Distinct from {@link SELF_DESCRIBING_CODES}, which only drops the chain-name prefix:
 * those still appear once per network because each is about that network. These are
 * the same fact repeated, so exactly one survives.
 */
const GLOBAL_CODES: ReadonlySet<string> = new Set(['protocols.coverage']);

const COVERAGE_CODE = 'coverage.token-list';

/**
 * Warnings that already name their own network. Prefixing them would produce
 * "Ethereum Mainnet: The Ethereum token list…"; only the code is namespaced, so
 * two networks raising it stay distinguishable as React keys.
 */
const SELF_DESCRIBING_CODES: ReadonlySet<string> = new Set(['coverage.token-list-aged']);

/** Recovers the list size from the coverage warning the provider wrote. */
function countListedTokens(chain: AggregatePortfolio['chains'][number]): number {
  const message = chain.warnings.find((warning) => warning.code === COVERAGE_CODE)?.message ?? '';
  const match = /list of ([\d,]+)/.exec(message);
  return match?.[1] === undefined ? 0 : Number(match[1].replaceAll(',', ''));
}

function listNames(chains: readonly AggregatePortfolio['chains'][number][]): string {
  const names = chains.map((chain) => chain.chainName);
  if (names.length <= 1) {
    return names[0] ?? 'no networks';
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function readFetchedAt(data: PortfolioData): string {
  return data.scope === 'chain' ? data.portfolio.fetchedAt : data.aggregate.fetchedAt;
}

function ErrorState({
  error,
  retryable,
  onRetry,
}: {
  error: ApiError['error'];
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <section
      role="alert"
      className="rounded-xl border border-caution-line bg-caution-surface p-6 text-center"
    >
      <h2 className="text-sm font-semibold text-ink">This portfolio could not be loaded</h2>
      <p className="mx-auto mt-2 max-w-prose text-sm text-ink-muted">{error.message}</p>
      {retryable ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90"
        >
          Try again
        </button>
      ) : null}
    </section>
  );
}

function EmptyState({ data }: { data: PortfolioData }) {
  const warnings =
    data.scope === 'chain' ? data.portfolio.warnings : collectAggregateWarnings(data.aggregate);

  /**
   * "Nothing found on any supported network" is only true if every network
   * answered. When one could not be read, the honest claim covers the networks
   * that did — and the breakdown below names the one that did not, so an
   * unreadable network is never mistaken for an empty one.
   */
  const unreachable = data.scope === 'aggregate' ? data.aggregate.failedChains.length : 0;
  const scopeLabel =
    data.scope === 'chain'
      ? `on ${data.portfolio.chainName}`
      : unreachable > 0
        ? `on the ${data.aggregate.chains.length} network${data.aggregate.chains.length === 1 ? '' : 's'} that could be read`
        : 'on any supported network';

  return (
    <section className="rounded-xl border border-line bg-surface p-8">
      <h2 className="text-center text-sm font-semibold text-ink">No assets found</h2>
      <p className="mx-auto mt-2 max-w-prose text-center text-sm text-ink-muted">
        This wallet holds no native balance and none of the tokens Nuxfolio checks {scopeLabel}. It
        may still hold tokens outside those lists.
        {unreachable > 0
          ? ` ${unreachable} network${unreachable === 1 ? '' : 's'} could not be read at all, so nothing is claimed about ${unreachable === 1 ? 'it' : 'them'}.`
          : ''}
      </p>

      {data.scope === 'aggregate' && unreachable > 0 ? (
        <div className="mt-6">
          <ChainBreakdown aggregate={data.aggregate} />
        </div>
      ) : null}

      <div className="mt-6">
        <WarningPanel warnings={warnings} />
      </div>
    </section>
  );
}
