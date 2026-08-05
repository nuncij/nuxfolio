'use client';

import { HOLDING_FORM_LABEL, TRACKED_ASSET_LABEL, type HoldingForm } from '@/domain/assetClass';
import type { ExposureSlice, PortfolioInsights } from '@/domain/insights';
import { formatPercent } from '@/lib/format';

/**
 * What the portfolio is, stated as facts.
 *
 * The panel exists because the asset table answers "what do I hold" and nothing
 * answers "what does that add up to". Three positions on one network can be a
 * near-perfect thirds split across ether, dollars and bitcoin, and no amount of
 * scrolling a table makes that visible.
 *
 * Everything here is a **fact with a stated denominator**. There is no advice, no
 * risk score and no "you should": the product reports, and the reader decides.
 * The wording is careful in three specific places, each of which would otherwise
 * be a claim the data does not support:
 *
 *  - "of the priced total" — never "of your portfolio", because unpriced and
 *    excluded assets are outside every share here, and the panel says how many.
 *  - "designed to track" — never "tracks", because an address proves which
 *    instrument something is, not that it is currently holding its peg.
 *  - a named holding form — because a lending receipt for dollars is not the same
 *    exposure as dollars, and calling both "the US dollar" hides a real dependency.
 */
export function InsightsPanel({ insights }: { insights: PortfolioInsights | null }) {
  if (insights === null) {
    return null;
  }

  const { concentration, exposure, networks, excluded } = insights;

  return (
    <section
      aria-label="What this portfolio is"
      className="rounded-xl border border-line bg-surface p-4"
    >
      <h2 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
        What this portfolio is
      </h2>

      <ul className="mt-3 space-y-2 text-sm text-ink">
        {concentration.largest === null ? null : (
          <li>
            <b className="font-semibold">{concentration.largest.symbol}</b> is{' '}
            <Figure>{formatPercent(concentration.largest.sharePct)}</Figure> of the priced total on
            its own.
          </li>
        )}

        {concentration.holdingsToReachNinetyPct === null ? null : (
          <li>
            <Figure>{concentration.holdingsToReachNinetyPct}</Figure> of{' '}
            <Figure>{concentration.holdingCount}</Figure> priced holdings account for 90 % of it
            {concentration.topThreeSharePct === null ? null : (
              <>
                ; the largest three are{' '}
                <Figure>{formatPercent(concentration.topThreeSharePct)}</Figure>
              </>
            )}
            .
          </li>
        )}

        {exposure.length > 1 ? (
          <li>
            The value is designed to track{' '}
            {exposure.map((slice, index) => (
              <span key={slice.tracks}>
                {index > 0 ? (index === exposure.length - 1 ? ' and ' : ', ') : ''}
                <Figure>{formatPercent(slice.sharePct)}</Figure> {TRACKED_ASSET_LABEL[slice.tracks]}
                <Forms forms={slice.forms} />
              </span>
            ))}
            .
          </li>
        ) : null}

        {networks === null || networks.length < 2 ? null : (
          <li>
            <Figure>{formatPercent(networks[0]?.sharePct ?? null)}</Figure> of it sits on{' '}
            {networks[0]?.chainName}
            {networks.length > 1 ? `, across ${networks.length} networks in total` : ''}.
          </li>
        )}
      </ul>

      {excluded.unpricedCount > 0 || excluded.suspectCount > 0 ? (
        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-subtle">
          Outside every figure above:{' '}
          {[
            excluded.unpricedCount > 0
              ? `${excluded.unpricedCount} holding${excluded.unpricedCount === 1 ? '' : 's'} with no price`
              : null,
            excluded.suspectCount > 0 ? `${excluded.suspectCount} flagged as likely spam` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' · ')}
          .
        </p>
      ) : null}
    </section>
  );
}

/**
 * How the exposure is held, when that is worth saying.
 *
 * A direct balance needs no qualifier. A receipt does, because the issuing
 * protocol is a dependency the underlying asset does not carry.
 */
function Forms({ forms }: { forms: readonly HoldingForm[] }) {
  const described = forms
    .map((form) => HOLDING_FORM_LABEL[form])
    .filter((label): label is string => label !== null);

  if (described.length === 0) {
    return null;
  }
  return <span className="text-ink-muted"> ({described.join(', ')})</span>;
}

/** Figures are tabular so a column of them lines up and reads as data. */
function Figure({ children }: { children: React.ReactNode }) {
  return <span className="numeric font-medium">{children}</span>;
}

export type { ExposureSlice };
