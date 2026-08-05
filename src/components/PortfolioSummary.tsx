import type { AggregatePortfolio, Portfolio } from '@/domain/portfolio';
import { summarizeAggregate, summarizePortfolio } from '@/domain/normalize';
import type { AggregateProgress } from '@/domain/progressiveAggregate';
import { formatPercent, formatRelativeTime } from '@/lib/format';

import { conversionNote } from '@/lib/displayContext';

import { useDisplayContext, useMoney } from './DisplayProvider';

/**
 * The four headline numbers.
 *
 * The total is labelled "priced assets" rather than "total value", because when
 * some holdings have no price the sum is a subtotal. Calling a subtotal a total
 * is the small dishonesty this product is specifically trying to avoid. The same
 * rule governs `progress`: while the all-networks view is still arriving, the
 * network card counts the networks the figures actually cover instead of
 * implying they cover all of them.
 */
export function PortfolioSummary(
  props:
    | { portfolio: Portfolio; aggregate?: never; progress?: never }
    | {
        aggregate: AggregatePortfolio;
        portfolio?: never;
        /**
         * How many networks these figures cover; null once every one has
         * settled. Required rather than optional, so a caller cannot leave a
         * partial view looking complete by forgetting it.
         */
        progress: AggregateProgress | null;
      },
) {
  const money = useMoney();
  // One disclosure per page, next to the estimates caveat it belongs with, rather
  // than repeated beside every figure — repetition adds noise, not truth.
  const conversion = conversionNote(useDisplayContext());
  const isAggregate = props.aggregate !== undefined;
  const summary = isAggregate
    ? summarizeAggregate(props.aggregate)
    : summarizePortfolio(props.portfolio);
  const fetchedAt = isAggregate ? props.aggregate.fetchedAt : props.portfolio.fetchedAt;

  // Non-null only while an all-networks view is still arriving.
  const pending =
    isAggregate && props.progress !== null && !props.progress.complete ? props.progress : null;

  const networkValue = !isAggregate
    ? props.portfolio.chainName
    : pending !== null
      ? `${props.aggregate.chains.length} of ${pending.total} networks`
      : `${props.aggregate.chains.length} networks`;
  // The card counts every asset the wallet holds, so it has to say which of
  // them the headline figure leaves out and why.
  const assetCaveats = [
    summary.unpricedAssetCount > 0 ? `${summary.unpricedAssetCount} without a price` : null,
    summary.suspectAssetCount > 0 ? `${summary.suspectAssetCount} flagged as likely spam` : null,
  ].filter((caveat): caveat is string => caveat !== null);
  const assetDetail = assetCaveats.length > 0 ? assetCaveats.join(' · ') : 'All with a price';

  // "All reachable" is a claim about every network, so it waits until every
  // network has answered; until then the card says it is still counting.
  const networkDetail = !isAggregate
    ? `via ${props.portfolio.balanceSource}`
    : props.aggregate.failedChains.length > 0
      ? `${props.aggregate.failedChains.length} unavailable${pending !== null ? ' so far' : ''}`
      : pending !== null
        ? 'Still loading'
        : 'All reachable';

  // The asset table marks disagreements only, so an unmarked row would otherwise
  // be indistinguishable from a confirmed one. Stating the scope of the check is
  // what keeps silence from reading as endorsement. Null when no second source
  // was consulted at all: there is then nothing to scope, and a "0 of 12" would
  // suggest a check had failed rather than never been configured.
  //
  // "and agreed" is claimed only when every checked price actually agreed. An
  // asset the second source declined to price is `unverified` — asked, no answer —
  // and folding it into agreement would report a confirmation that never happened.
  const crossCheckNote = summary.checkedAssetCount === 0 ? null : describeCrossCheck(summary);

  return (
    <section aria-label="Portfolio summary">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label={
            summary.unpricedAssetCount > 0 ? 'Estimated value (priced assets)' : 'Estimated value'
          }
          value={money(summary.totalValueUsd)}
          detail={
            summary.totalValueUsd === null
              ? 'No prices available'
              : summary.unpricedAssetCount > 0
                ? `${summary.pricedAssetCount} of ${summary.assetCount} assets priced`
                : `Updated ${formatRelativeTime(fetchedAt)}`
          }
          emphasis
        />

        <SummaryCard label="Assets" value={String(summary.assetCount)} detail={assetDetail} />

        <SummaryCard
          label="Largest position"
          value={summary.largestAsset?.symbol ?? '—'}
          detail={
            summary.largestAsset === null
              ? 'Needs price data'
              : `${money(summary.largestAsset.valueUsd)} · ${formatPercent(summary.largestAsset.sharePct)}`
          }
        />

        <SummaryCard
          label={isAggregate ? 'Networks' : 'Network'}
          value={networkValue}
          detail={networkDetail}
        />
      </dl>

      <p className="mt-3 text-xs text-ink-subtle">
        Values are estimates derived from public market data and can differ from what you would
        actually receive. Nuxfolio reads public chain data only.
        {crossCheckNote === null ? null : ` ${crossCheckNote}`}
        {conversion === null ? null : ` ${conversion}`}
      </p>
    </section>
  );
}

/**
 * One sentence describing what the cross-check actually established.
 *
 * Every outcome gets its own clause. The failure mode being avoided is a single
 * cheerful "and agreed" appended whenever nothing was disputed — which would also
 * cover the case where the second source had no opinion on anything.
 */
function describeCrossCheck(summary: {
  checkedAssetCount: number;
  agreedAssetCount: number;
  disputedAssetCount: number;
  countedPricedAssetCount: number;
}): string {
  const scope = `${summary.checkedAssetCount} of ${summary.countedPricedAssetCount} prices were checked against a second source`;

  const unverified =
    summary.checkedAssetCount - summary.agreedAssetCount - summary.disputedAssetCount;

  const clauses = [
    summary.disputedAssetCount > 0
      ? `${summary.disputedAssetCount} disagreed and ${summary.disputedAssetCount === 1 ? 'is' : 'are'} marked below`
      : null,
    unverified > 0
      ? `${unverified} could not be confirmed — the second source had no price for ${unverified === 1 ? 'it' : 'them'}`
      : null,
  ].filter((clause): clause is string => clause !== null);

  if (clauses.length === 0) {
    return `${scope} and agreed.`;
  }
  return `${scope}; ${clauses.join(', and ')}.`;
}

function SummaryCard({
  label,
  value,
  detail,
  emphasis = false,
}: {
  label: string;
  value: string;
  detail: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <dt className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</dt>
      <dd className={`numeric mt-2 ${emphasis ? 'text-2xl' : 'text-xl'} font-semibold text-ink`}>
        {value}
      </dd>
      <p className="mt-1 text-xs text-ink-subtle">{detail}</p>
    </div>
  );
}
