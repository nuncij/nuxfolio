'use client';

import type { ProtocolReadStatus, StakedPositionDto } from '@/domain/portfolio';
import { formatQuantity } from '@/lib/format';

import { useMoney } from './DisplayProvider';

/**
 * Positions another protocol is holding for the wallet.
 *
 * This is the one thing in the product that **no balance read can find**. A Convex
 * staker's Curve LP is owned by Convex's reward contract, and unlike an Aave supply
 * there is no receipt token left in the wallet to stand in for it — so without this
 * panel the position is not double-counted or mispriced, it is simply absent.
 *
 * **These values are not in the portfolio total.** They are priced by the same source as
 * the assets, unlike the lending panel's figures, so they *could* be added — but adding
 * them would change what `totalValueUsd` has meant since milestone 1 without saying so,
 * and a headline that quietly grows is the failure this product is built to avoid. The
 * caption says which way it goes rather than leaving it to be inferred.
 *
 * Absent entirely when the wallet stakes nothing. A row of zeroes would be a claim.
 */
export function StakedPanel({
  positions,
  status,
  failedOn = [],
}: {
  positions: readonly StakedPositionDto[];
  status: ProtocolReadStatus;
  /** Networks whose read failed, so the notice can name them instead of the page. */
  failedOn?: readonly string[];
}) {
  if (status === 'failed') {
    return (
      <section
        aria-label="Staked positions"
        className="rounded-xl border border-line bg-surface p-4"
      >
        <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Staked</h2>
        {/* Named, because "could not be read" without a where is a sentence a reader can
            do nothing with — and because the first time this notice appeared it was the
            only symptom of a decode bug on one network while the other was fine. */}
        <p className="mt-2 text-xs text-caution">
          Convex could not be read
          {failedOn.length > 0 ? ` on ${listNetworks(failedOn)}` : ''} this time, so any position
          staked there is missing from this page. Nothing else on it is affected.
        </p>
      </section>
    );
  }

  if (positions.length === 0) {
    return null;
  }

  return (
    <section aria-label="Staked positions" className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Staked</h2>
        {/* Both halves matter. "Convex only" is coverage, the same statement the lending
            panel leads with. "Not in the total above" is true here in a way it is not
            there: these really are outside `totalValueUsd`, and they are the one kind of
            holding a reader would otherwise never see counted anywhere. */}
        <p className="text-xs text-ink-subtle">
          Convex only · held by the protocol, not in the total above
        </p>
      </div>

      <dl className="mt-3 space-y-1">
        {positions.map((position) => (
          <div
            key={position.positionId}
            className="grid gap-x-4 text-sm sm:grid-cols-[1fr_9rem_auto] sm:items-baseline"
          >
            <dt className="text-ink">
              {position.symbol ??
                `${position.stakedToken.slice(0, 6)}…${position.stakedToken.slice(-4)}`}
            </dt>
            <dd className="numeric text-ink-muted sm:text-right">
              {formatQuantity(position.amount)}
            </dd>
            <dd className="sm:text-right">
              <Value valueUsd={position.valueUsd} />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function listNetworks(names: readonly string[]): string {
  if (names.length <= 2) {
    return names.join(' and ');
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Measured on 2026-08-08: the price source covers 238 of the 330 Convex pools anything is
 * staked in, and only 13 of the 25 largest — the biggest are Curve lending-market LPs it
 * does not carry. So no price is an ordinary outcome here, and the amount beside it is
 * still the true amount.
 */
function Value({ valueUsd }: { valueUsd: string | null }) {
  const money = useMoney();

  if (valueUsd === null) {
    return <span className="text-xs text-ink-subtle">No price for this pool token</span>;
  }
  return <span className="numeric text-ink">{money(valueUsd)}</span>;
}
