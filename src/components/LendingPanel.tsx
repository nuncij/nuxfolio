'use client';

import type { ProtocolAccountDto } from '@/domain/portfolio';
import { hasPosition, summarizeAccounts } from '@/domain/protocolAccount';

import { formatHealthFactor } from '@/lib/format';

import { useMoney } from './DisplayProvider';

/**
 * What the wallet owes a lending protocol, and how close it is to liquidation.
 *
 * **These figures are never added to the portfolio total**, and the panel says so.
 * Two independent reasons: they come from Aave's own oracle rather than the price
 * source the assets use, and the collateral behind them is invisible to the asset
 * list, so a subtraction would cross two scopes. Review round 12 worked the example —
 * a wallet supplying $100k and borrowing $40k would report a net of $0 against a true
 * $60k. A wrong headline is worse than an absent one.
 *
 * The panel is absent entirely when the wallet uses no lending market. A row of
 * zeroes would be a claim; nothing is the truth.
 */
export function LendingPanel({ accounts }: { accounts: readonly ProtocolAccountDto[] }) {
  const shown = accounts.filter(hasPosition);
  if (shown.length === 0) {
    return null;
  }

  const summary = summarizeAccounts(shown);

  return (
    <section
      aria-label="Lending positions"
      className="rounded-xl border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Borrowing</h2>
        {/* The source is named, not implied. These are Aave's numbers, computed by
            Aave's oracle, which is why they reconcile with Aave's own interface and
            why they are not mixed into a total priced by someone else. */}
        <p className="text-xs text-ink-subtle">
          Reported by Aave · not included in the total above
        </p>
      </div>

      {summary.marketsFailed > 0 && (
        <p className="mt-2 text-xs text-caution">
          {summary.marketsFailed} of {shown.length} markets could not be read. Any borrowing there
          is missing from these figures.
        </p>
      )}

      <ul className="mt-3 space-y-3">
        {shown.map((account) => (
          <li key={account.marketId}>
            <MarketRow account={account} />
          </li>
        ))}
      </ul>

      {summary.lowestHealthFactor !== null && (
        // Once, below the list, rather than per row: the definition is what makes the
        // number mean anything, and a tooltip does not exist on a touch device.
        <p className="mt-3 border-t border-line pt-3 text-xs text-ink-subtle">
          A health factor below 1 becomes eligible for liquidation; higher is further from that
          threshold.
        </p>
      )}
    </section>
  );
}

function MarketRow({ account }: { account: ProtocolAccountDto }) {
  const money = useMoney();

  if (account.status === 'failed') {
    return (
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm text-ink">{account.marketName}</span>
        {/* Not "no debt". The read did not answer, and the difference between those
            two is the entire reason `status` exists. */}
        <span className="text-sm text-caution">Could not be read</span>
      </div>
    );
  }

  return (
    <div className="grid gap-x-6 gap-y-1 sm:grid-cols-[1fr_auto_auto_auto] sm:items-baseline">
      <span className="text-sm text-ink">{account.marketName}</span>

      <Figure label="Collateral" value={money(account.collateralValueUsd)} />
      <Figure label="Borrowed" value={money(account.borrowedValueUsd)} />

      <div className="text-sm">
        <span className="mr-2 text-xs text-ink-subtle uppercase">Health</span>
        <HealthFactor value={account.healthFactor} />
      </div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-sm">
      <span className="mr-2 text-xs text-ink-subtle uppercase">{label}</span>
      <span className="numeric text-ink">{value}</span>
    </div>
  );
}

/**
 * The health factor, with the one sentence that makes it mean anything.
 *
 * A bare "1.04" is not honest: a reader cannot tell whether it is a percentage, or
 * whether higher is better (review round 12, F-09). Stating that below 1 becomes
 * eligible for liquidation is a **definition** — it says what the number is. "You
 * should repay" would be advice, and stays out of this product entirely.
 *
 * Null means no debt in this market, which renders as words rather than as a number:
 * Aave returns uint256 max there, and any arithmetic on it produces nonsense.
 */
function HealthFactor({ value }: { value: string | null }) {
  if (value === null) {
    return <span className="text-ink-muted">Not applicable — nothing borrowed</span>;
  }

  return <span className="numeric text-ink">{formatHealthFactor(value)}</span>;
}
