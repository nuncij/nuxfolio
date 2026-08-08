'use client';

import { Decimal } from 'decimal.js';

import type { ProtocolAccountDto, ProtocolPositionDto } from '@/domain/portfolio';
import { hasPosition, summarizeAccounts } from '@/domain/protocolAccount';

import { formatHealthFactor, formatQuantity } from '@/lib/format';

import { useMoney } from './DisplayProvider';

/**
 * What the wallet has in a lending protocol: supplied, borrowed, and how close it is to
 * liquidation.
 *
 * **These figures are never added to the portfolio total.** They come from Aave's own
 * oracle rather than the price source the assets use, so they do not share a
 * denominator with anything above them.
 *
 * And no net-of-debt figure is derived — for a reason sharper than the one first
 * written here. The original said collateral is *invisible* to the asset total.
 * Measuring properly showed 53 Aave v3 receipt tokens are on the bundled lists, so
 * collateral is often visible, under a name like "Aave v3 WETH". But not always, and
 * nothing in the data says which case a wallet is in. `total − debt` is therefore
 * correct when the receipt token happens to be listed and wrong by the entire
 * collateral when it is not. A figure that is right for some wallets and silently
 * wrong for others is worse than no figure. See ADR-026.
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
    <section aria-label="Lending markets" className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        {/* Not "Borrowing": a wallet that only supplies, with collateral switched
            off, now appears here too — and for it both headline figures are zero. */}
        <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
          Lending markets
        </h2>
        {/* Three clauses, and the first is the one M5-3 added. Naming Aave as the
            *source* of these figures is attribution; saying Aave is the *only*
            protocol read is coverage, and only the second stops a heading that says
            "Lending markets" from implying it lists all of them. The caveat panel
            carries the same fact, but it is collapsed by default — a statement a
            reader has to open a disclosure to find is not one the panel above it can
            lean on.

            The second clause: these are Aave's own numbers, computed by Aave's oracle,
            which is why they reconcile with Aave's interface and why they are not
            mixed into a total priced by someone else.

            The third took a real screenshot to get right. "Not included in the total
            above" was true of these *figures* — nothing here is summed into the total —
            and false about the money: 53 Aave v3 receipt tokens are on the bundled
            lists, so a wallet's collateral is often already counted above under a name
            like "Aave v3 WETH". The old wording invited exactly the addition it was
            trying to prevent. */}
        <p className="text-xs text-ink-subtle">
          Aave v3 only · figures are Aave&rsquo;s own · collateral may also appear above as a
          receipt token
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
    <>
      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-[1fr_auto_auto_auto] sm:items-baseline">
        <span className="text-sm text-ink">{account.marketName}</span>

        <Figure label="Collateral" value={money(account.collateralValueUsd)} />
        <Figure label="Borrowed" value={money(account.borrowedValueUsd)} />

        <div className="text-sm">
          <span className="mr-2 text-xs text-ink-subtle uppercase">Health</span>
          <HealthFactor value={account.healthFactor} />
        </div>
      </div>

      <Breakdown account={account} />
    </>
  );
}

/**
 * Which assets the two figures above are made of.
 *
 * Every row here is priced by the same market oracle that produced the totals, so the
 * supplied rows marked as collateral sum to the collateral figure and the borrowed rows
 * sum to the borrowed figure — exactly, to the base unit. That is the point of not
 * pricing them with the app's own source, and it is asserted in
 * `domain/protocolPosition.test.ts` against a whole market captured at one block.
 *
 * Two things qualify that. A row the oracle cannot price shows no figure at all rather
 * than a zero, so the visible rows fall short of the headline by whatever that position
 * is worth — the alternative being to call it worthless, which is worse. And the totals
 * and the rows are two reads a few hundred milliseconds apart, so a repayment landing
 * between them shows up as a mismatch until the next refresh; interest accrual over
 * that window is far below the cent these figures are shown to.
 *
 * A missing breakdown is stated rather than left blank, and the two reasons it can be
 * missing are not merged: a market that has no detail provider at all will never have
 * one, while a read that failed may well work on the next load.
 */
function Breakdown({ account }: { account: ProtocolAccountDto }) {
  const supplied = account.positions.filter((position) => !isZero(position.supplied));
  const borrowed = account.positions.filter((position) => !isZero(position.borrowed));

  if (account.positionsStatus === 'failed') {
    return (
      <p className="mt-1 text-xs text-caution">
        The per-asset breakdown could not be read this time. The figures above are unaffected.
      </p>
    );
  }

  if (account.positionsStatus === 'unavailable') {
    return (
      <p className="mt-1 text-xs text-ink-subtle">
        Nuxfolio has no verified detail provider for this market, so it cannot say which assets
        these are.
      </p>
    );
  }

  if (supplied.length === 0 && borrowed.length === 0) {
    return null;
  }

  return (
    <dl className="mt-2 space-y-2 border-l border-line pl-3">
      <PositionGroup label="Supplied" positions={supplied} side="supplied" />
      <PositionGroup label="Borrowed" positions={borrowed} side="borrowed" />
    </dl>
  );
}

function PositionGroup({
  label,
  positions,
  side,
}: {
  label: string;
  positions: readonly ProtocolPositionDto[];
  side: 'supplied' | 'borrowed';
}) {
  if (positions.length === 0) {
    return null;
  }

  return (
    <div>
      <dt className="text-xs text-ink-subtle uppercase">{label}</dt>
      {positions.map((position) => (
        <dd key={`${side}:${position.asset}`}>
          <PositionRow position={position} side={side} />
        </dd>
      ))}
    </div>
  );
}

function PositionRow({
  position,
  side,
}: {
  position: ProtocolPositionDto;
  side: 'supplied' | 'borrowed';
}) {
  const money = useMoney();
  const amount = side === 'supplied' ? position.supplied : position.borrowed;
  const value = side === 'supplied' ? position.suppliedValueUsd : position.borrowedValueUsd;

  return (
    // Both figures right-aligned: amounts that line up on the decimal can be compared
    // down the column, and the value lands under the market total it is part of.
    <div className="grid gap-x-4 text-sm sm:grid-cols-[6rem_9rem_1fr] sm:items-baseline">
      {/* An unlisted underlying still has an address, and an address is a true answer
          where a guessed name would not be. */}
      <span className="text-ink">{position.symbol ?? shortAddress(position.asset)}</span>
      <span className="numeric text-ink-muted sm:text-right">{formatQuantity(amount)}</span>
      {value === null ? (
        // The market oracle answered zero, which means it has no price rather than that
        // the asset is worthless. Rendering "$0.00" here would be off by the position.
        <span className="text-xs text-ink-subtle sm:text-right">No price from the market</span>
      ) : (
        <span className="numeric text-ink sm:text-right">{money(value)}</span>
      )}
      {side === 'supplied' && !position.usedAsCollateral && (
        // Why this row is absent from the collateral figure above it. Without the note
        // the two numbers simply fail to add up, with nothing on screen to say why.
        <span className="text-xs text-ink-subtle sm:col-start-3">Not used as collateral</span>
      )}
    </div>
  );
}

/** Decimal, not `Number`: a quantity never passes through a float here (ADR-003). */
function isZero(value: string): boolean {
  return new Decimal(value).isZero();
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
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
