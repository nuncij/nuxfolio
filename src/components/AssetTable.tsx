'use client';

import { useMemo, useState } from 'react';

import { shortenAddress } from '@/domain/address';
import { DEFAULT_SORT, toggleAssetSort, withAssetSort, type AssetSort } from '@/domain/assetSort';
import { compareDecimal } from '@/domain/money';
import { sortAssets, type CrossChainAsset } from '@/domain/normalize';
import type { AssetSortKey, PortfolioAsset, PriceChange, SortDirection } from '@/domain/portfolio';
import { isBelowDisplayPrecision } from '@/domain/priceHistory';
import { SUSPECT_REASON_LABEL } from '@/domain/suspect';
import { groupAssetsForDisplay } from '@/lib/assetGroups';
import { formatPercent, formatQuantity, formatUsd } from '@/lib/format';

import { useMoney } from './DisplayProvider';

/**
 * The asset table.
 *
 * Sorting reuses the domain's comparator rather than re-implementing it here,
 * so the ordering the user sees is the ordering that is unit-tested — including
 * the rule that unpriced assets never sort to the bottom out of sight.
 *
 * Grouping happens after sorting, so each section is ordered by the same
 * comparator independently.
 */
type TableAsset = PortfolioAsset &
  Partial<Pick<CrossChainAsset, 'chainName'>> & {
    /**
     * Which wallet holds this position, in a bundle.
     *
     * Rows are never merged across wallets. Two wallets holding USDC are two rows,
     * because one row cannot carry two price qualities, two dispute verdicts or two
     * change figures — those fields are singular, and collapsing them would either
     * hide a caveat or apply it to a balance it does not describe.
     */
    walletAddress?: string | null;
  };

export function AssetTable({
  assets,
  explorerUrl,
  showChain = false,
  showWallet = false,
  initialSort = DEFAULT_SORT,
}: {
  assets: readonly TableAsset[];
  /** Explorer for a single-chain view; omitted per row in the cross-chain one. */
  explorerUrl: string | null;
  showChain?: boolean;
  showWallet?: boolean;
  /**
   * Sort order from the URL, so a shared link opens the way it was shared.
   *
   * Passed in rather than read here: the page already parses its query string on the
   * server, and `useSearchParams` in a client component would add a Suspense
   * requirement for a value that is available for free one level up.
   */
  initialSort?: AssetSort;
}) {
  const money = useMoney();
  const [sort, setSort] = useState<AssetSort>(initialSort);
  const { key: sortKey, direction } = sort;
  // Both sections start collapsed on every load. Remembering the choice would
  // mean a returning user quietly seeing a table that includes spam again.
  const [dustExpanded, setDustExpanded] = useState(false);
  const [suspectExpanded, setSuspectExpanded] = useState(false);

  const sorted = useMemo(
    () => sortAssets(assets, sortKey, direction),
    [assets, sortKey, direction],
  );
  const groups = useMemo(() => groupAssetsForDisplay(sorted), [sorted]);

  // A wallet can now reach this view with nothing in the table: its only holding may be
  // one a protocol keeps for it, which is what milestone 5 added. A header with no rows
  // under it is a table promising data it does not have.
  if (assets.length === 0) {
    return null;
  }

  const columnCount = 7 + (showChain ? 1 : 0) + (showWallet ? 1 : 0);

  /**
   * Sorts, and records the choice in the URL so the view can be shared or reloaded.
   *
   * `history.replaceState`, not a router navigation: the sort is view state, not a
   * different page. A `router.replace` would ask the server for a payload identical
   * to the one already rendered, and `replaceState` also keeps the back button
   * meaning "the previous page" rather than "the previous column I clicked".
   */
  function toggleSort(key: AssetSortKey): void {
    const next = toggleAssetSort(sort, key);
    setSort(next);

    try {
      window.history.replaceState(
        window.history.state,
        '',
        withAssetSort(`${window.location.pathname}${window.location.search}`, next),
      );
    } catch {
      // A sandboxed frame can refuse history access. The table still sorts; the URL
      // simply will not carry it.
    }
  }

  return (
    <section aria-label="Assets" className="overflow-hidden rounded-xl border border-line">
      <div className="overflow-x-auto">
        <table
          className={`w-full ${showWallet ? 'min-w-[66rem]' : showChain ? 'min-w-[58rem]' : 'min-w-[52rem]'} border-collapse text-sm`}
        >
          <caption className="sr-only">
            Assets held, with quantity, unit price, value, price change over 24 hours and 7 days,
            and share of the priced total. One row per holding: in a bundle, the same token in two
            wallets is two rows.
          </caption>
          <thead>
            <tr className="border-b border-line bg-surface-raised text-left">
              <SortableHeader
                label="Asset"
                active={sortKey === 'name'}
                direction={direction}
                onClick={() => toggleSort('name')}
              />
              {showWallet ? (
                <th scope="col" className="px-4 py-3 text-left font-medium text-ink-muted">
                  Wallet
                </th>
              ) : null}
              {showChain ? (
                <th scope="col" className="px-4 py-3 text-left font-medium text-ink-muted">
                  Network
                </th>
              ) : null}
              <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">
                Quantity
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">
                Price
              </th>
              <SortableHeader
                label="Value"
                align="right"
                active={sortKey === 'value'}
                direction={direction}
                onClick={() => toggleSort('value')}
              />
              <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">
                24h
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">
                7d
              </th>
              <th scope="col" className="px-4 py-3 text-right font-medium text-ink-muted">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {groups.primary.map((asset) => (
              <AssetRow
                key={rowKey(asset)}
                asset={asset}
                explorerUrl={explorerUrl}
                showChain={showChain}
                showWallet={showWallet}
              />
            ))}
          </tbody>

          {groups.dust.length > 0 ? (
            <>
              <tbody>
                <ExpanderRow
                  columnCount={columnCount}
                  expanded={dustExpanded}
                  controls="asset-table-dust"
                  onToggle={() => setDustExpanded((current) => !current)}
                  label={`${groups.dust.length} small balance${groups.dust.length === 1 ? '' : 's'} · ${money(groups.dustValueUsd)} total`}
                />
              </tbody>
              <tbody id="asset-table-dust" hidden={!dustExpanded}>
                {groups.dust.map((asset) => (
                  <AssetRow
                    key={rowKey(asset)}
                    asset={asset}
                    explorerUrl={explorerUrl}
                    showChain={showChain}
                    showWallet={showWallet}
                  />
                ))}
              </tbody>
            </>
          ) : null}

          {groups.suspect.length > 0 ? (
            <>
              <tbody>
                <ExpanderRow
                  columnCount={columnCount}
                  expanded={suspectExpanded}
                  controls="asset-table-suspect"
                  tone="caution"
                  onToggle={() => setSuspectExpanded((current) => !current)}
                  label={`${groups.suspect.length} flagged as likely spam · ${money(groups.suspectValueUsd)} excluded`}
                />
              </tbody>
              <tbody id="asset-table-suspect" hidden={!suspectExpanded}>
                {groups.suspect.map((asset) => (
                  <AssetRow
                    key={rowKey(asset)}
                    asset={asset}
                    explorerUrl={explorerUrl}
                    showChain={showChain}
                    showWallet={showWallet}
                  />
                ))}
              </tbody>
            </>
          ) : null}
        </table>
      </div>
    </section>
  );
}

function ExpanderRow({
  columnCount,
  expanded,
  controls,
  label,
  onToggle,
  tone = 'muted',
}: {
  columnCount: number;
  expanded: boolean;
  controls: string;
  label: string;
  onToggle: () => void;
  tone?: 'muted' | 'caution';
}) {
  return (
    <tr className="border-t border-line bg-surface-raised">
      <td colSpan={columnCount} className="p-0">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={controls}
          className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-xs hover:text-ink ${
            tone === 'caution' ? 'text-caution' : 'text-ink-muted'
          }`}
        >
          <span className="text-left">{label}</span>
          <span className="shrink-0 text-ink-muted">
            {expanded ? 'Hide' : 'Show'}
            <span aria-hidden="true"> {expanded ? '▲' : '▼'}</span>
          </span>
        </button>
      </td>
    </tr>
  );
}

/**
 * A stable, unique key per rendered row.
 *
 * `assetId` is `chainId:contractAddress`, which is deliberately the same across
 * wallets — it identifies the token, not the holding. In a bundle two wallets holding
 * USDC would therefore collide on it, and React would reconcile two different rows as
 * one. The wallet is part of a row's identity here.
 */
function rowKey(asset: TableAsset): string {
  return `${asset.walletAddress ?? 'self'}:${asset.assetId}`;
}

function AssetRow({
  asset,
  explorerUrl,
  showChain,
  showWallet,
}: {
  asset: TableAsset;
  explorerUrl: string | null;
  showChain: boolean;
  showWallet?: boolean;
}) {
  const money = useMoney();

  return (
    <tr className="border-b border-line/60 last:border-0 hover:bg-surface">
      <th scope="row" className="px-4 py-3 text-left font-normal">
        <div className="flex items-center gap-3">
          <AssetGlyph symbol={asset.symbol} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-ink">{asset.symbol}</span>
              {asset.contractAddress === null ? (
                <span className="rounded border border-line-strong px-1.5 py-0.5 text-[10px] tracking-wide text-ink-subtle uppercase">
                  Native
                </span>
              ) : null}
              {asset.suspectReason === null ? null : (
                <span
                  title="Excluded from the total: this asset looks like a scam airdrop rather than a holding."
                  className="rounded border border-caution-line px-1.5 py-0.5 text-[10px] tracking-wide text-caution uppercase"
                >
                  {SUSPECT_REASON_LABEL[asset.suspectReason]}
                </span>
              )}
            </div>
            <div className="truncate text-xs text-ink-subtle">
              {asset.contractAddress === null || explorerUrl === null ? (
                asset.name
              ) : (
                <a
                  href={`${explorerUrl}/token/${asset.contractAddress}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:text-ink-muted hover:underline"
                >
                  {asset.name}
                </a>
              )}
            </div>
          </div>
        </div>
      </th>

      {showWallet === true ? (
        <td className="numeric px-4 py-3 text-left text-xs text-ink-muted">
          {asset.walletAddress === null || asset.walletAddress === undefined
            ? '—'
            : shortenAddress(asset.walletAddress)}
        </td>
      ) : null}

      {showChain ? (
        <td className="px-4 py-3 text-left text-xs text-ink-muted">{asset.chainName ?? '—'}</td>
      ) : null}

      <td className="numeric px-4 py-3 text-right text-ink">{formatQuantity(asset.quantity)}</td>

      <td className="numeric px-4 py-3 text-right">
        {asset.priceUsd === null ? (
          <span className="text-ink-subtle">No price</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-ink-muted">
            {money(asset.priceUsd)}
            <PriceQualityFlag quality={asset.priceQuality} />
            <PriceCheckFlag check={asset.priceCheck} />
          </span>
        )}
      </td>

      <td className="numeric px-4 py-3 text-right font-medium text-ink">{money(asset.valueUsd)}</td>

      <td className="numeric px-4 py-3 text-right">
        <ChangeCell change={asset.priceChange24h} />
      </td>

      <td className="numeric px-4 py-3 text-right">
        <ChangeCell change={asset.priceChange7d} />
      </td>

      <td className="numeric px-4 py-3 text-right text-ink-muted">
        {formatPercent(asset.portfolioSharePct)}
      </td>
    </tr>
  );
}

function PriceQualityFlag({ quality }: { quality: PortfolioAsset['priceQuality'] }) {
  if (quality === null || quality === 'ok') {
    return null;
  }
  const label =
    quality === 'stale'
      ? 'Price may be out of date'
      : quality === 'unknown-age'
        ? 'Price age could not be confirmed'
        : 'Low-confidence price';
  return (
    <span
      title={label}
      aria-label={label}
      className="inline-block size-1.5 rounded-full bg-caution"
    />
  );
}

/**
 * Price change over a period, or an honest dash.
 *
 * Three ways this cell could lie, all of them avoided here:
 *
 *  - **`0.00%` for a missing figure.** Zero is a real answer meaning "unchanged".
 *    Anything that is not a usable observation renders an em dash.
 *  - **`0.00%` for a real but tiny change.** `formatPercent` rounds to two
 *    places, so a genuine 0.004% would print as the opposite of what happened.
 *    Those render `<0.01%`.
 *  - **A silent dash.** Every dash carries its reason, so "we did not ask", "the
 *    source had no price" and "this cannot honestly be compared" are
 *    distinguishable rather than looking like the same shrug.
 */
function ChangeCell({ change }: { change: PortfolioAsset['priceChange24h'] }) {
  if (change === null) {
    return <span className="text-ink-subtle">—</span>;
  }

  // `status: 'ok'` with no percentage is a contradiction the schema permits but
  // the domain never produces. Treated as unusable rather than trusted: rendering
  // whatever a null formats to would be worse than saying nothing.
  const status = change.pct === null && change.status === 'ok' ? 'unusable' : change.status;

  if (status !== 'ok') {
    const reason = CHANGE_REASON[status];
    return (
      <span title={reason} aria-label={reason} className="text-ink-subtle">
        —
      </span>
    );
  }
  if (change.pct === null) {
    return <span className="text-ink-subtle">—</span>;
  }

  const rising = compareDecimal(change.pct, '0') > 0;
  const falling = compareDecimal(change.pct, '0') < 0;
  const tone = rising ? 'text-positive' : falling ? 'text-negative' : 'text-ink-muted';

  // A real change too small for two decimals says so, rather than rounding to a
  // figure that asserts no movement.
  const label = isBelowDisplayPrecision(change.pct)
    ? `${falling ? '>-' : '<'}0.01%`
    : formatPercent(change.pct);

  const title =
    change.thenUsd === null ? undefined : `Was ${formatUsd(change.thenUsd)} ${whenLabel(change)}`;

  return (
    <span title={title} className={tone}>
      {rising ? '+' : ''}
      {label}
    </span>
  );
}

/** Why a dash is a dash. A reason the user can read beats an unexplained gap. */
const CHANGE_REASON: Record<Exclude<PriceChange['status'], 'ok'>, string> = {
  'not-requested': 'No past price was requested for this asset.',
  'no-quote': 'The price source had no past price for this asset.',
  unusable:
    'A past price exists but cannot be compared honestly — the current price is flagged or disputed, or the past price is not from the right time.',
};

function whenLabel(change: PriceChange): string {
  return change.asOf === null ? 'earlier' : `on ${change.asOf.slice(0, 10)}`;
}

/**
 * A second source's verdict on this price.
 *
 * Only a dispute is marked. Agreement is the expected case and a tick on every
 * row would be noise; the absence of a marker is not a claim either way, which is
 * why the summary states how many prices were actually checked.
 */
function PriceCheckFlag({ check }: { check: PortfolioAsset['priceCheck'] }) {
  if (check === null || check.status !== 'disputed') {
    return null;
  }

  const second = formatUsd(check.priceUsd);
  const label =
    check.deltaPct === null
      ? `A second source disagrees on this price (${second})`
      : `A second source says ${second}, a ${formatPercent(check.deltaPct)} difference. Both are shown; neither is preferred.`;

  return (
    <span
      title={label}
      aria-label={label}
      className="rounded border border-caution-line px-1 text-[9px] font-semibold tracking-wide text-caution uppercase"
    >
      ?
    </span>
  );
}

/**
 * Token logos would mean a request from the user's browser to a third-party CDN
 * for every row, which leaks the wallet's holdings to that host. An initial is
 * enough to scan a table by. See docs/DECISIONS.md, ADR-009.
 */
function AssetGlyph({ symbol }: { symbol: string }) {
  const initial = symbol.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?';
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line-strong bg-surface-raised text-[10px] font-semibold text-ink-muted"
    >
      {initial.toUpperCase()}
    </span>
  );
}

function SortableHeader({
  label,
  active,
  direction,
  onClick,
  align = 'left',
}: {
  label: string;
  active: boolean;
  direction: SortDirection;
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <th
      scope="col"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`px-4 py-3 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`inline-flex items-center gap-1 hover:text-ink ${active ? 'text-ink' : 'text-ink-muted'}`}
      >
        {label}
        <span aria-hidden="true" className="text-[10px]">
          {active ? (direction === 'asc' ? '▲' : '▼') : '↕'}
        </span>
      </button>
    </th>
  );
}
