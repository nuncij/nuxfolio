'use client';

import { useEffect, useState } from 'react';

import type { HistoryPoint } from '@/domain/history';
import { describeChange } from '@/domain/history';

import { useMoney } from './DisplayProvider';

/**
 * What has actually been recorded for this wallet.
 *
 * **Every point is a reading, not a reconstruction.** The roadmap's second series —
 * today's holdings valued at historical prices — answers a different question and is
 * wrong for every day the balances differed from today's. It is deliberately absent from
 * v1 (`docs/M4_PLAN.md` §5): a sparse chart where each point means what it says beats a
 * dense one where half of it does not.
 *
 * **Absent unless there is history.** A wallet nobody tracks has none, and an empty chart
 * frame would imply the wallet is flat rather than unobserved.
 */
export function HistoryChart({ address, chainId }: { address: string; chainId?: number }) {
  const [points, setPoints] = useState<readonly HistoryPoint[] | 'failed' | null>(null);

  useEffect(() => {
    let cancelled = false;
    // History is a local file read, so it costs nothing to ask and is not worth
    // blocking the page for. A wallet with none simply never renders this.
    const scope = chainId === undefined ? '' : `&chainId=${chainId}`;
    fetch(`/api/history?address=${encodeURIComponent(address)}${scope}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        return response.json();
      })
      .then((body: { points?: readonly HistoryPoint[] }) => {
        if (!cancelled) {
          setPoints(body.points ?? []);
        }
      })
      .catch(() => {
        // A failed read is not "no history" — the store only errors for a wallet it
        // was actually asked about, and silence here would make a broken store look
        // like a wallet nobody tracks (round 15).
        if (!cancelled) {
          setPoints('failed');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [address, chainId]);

  if (points === null) {
    return null;
  }

  if (points === 'failed') {
    return (
      <section
        aria-label="Recorded history"
        className="rounded-xl border border-line bg-surface p-4"
      >
        <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">History</h2>
        <p className="mt-3 text-sm text-ink-muted">
          Recorded history could not be read this time. The readings themselves are safe; only this
          page&rsquo;s view of them failed.
        </p>
      </section>
    );
  }

  if (points.length === 0) {
    return null;
  }

  return (
    <section aria-label="Recorded history" className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">History</h2>
        <Caption points={points} />
      </div>

      {points.length === 1 ? (
        // One reading is not a line. Saying so beats drawing a flat one.
        <p className="mt-3 text-sm text-ink-muted">
          One reading so far, on {points[0]?.day}. A second arrives with tomorrow&rsquo;s.
        </p>
      ) : (
        <Series points={points} />
      )}
    </section>
  );
}

function Caption({ points }: { points: readonly HistoryPoint[] }) {
  const change = describeChange(points);
  const incomparable = points.filter((point) => !point.comparable).length;

  return (
    <p className="text-xs text-ink-subtle">
      {change === null
        ? `${points.length} reading${points.length === 1 ? '' : 's'} recorded`
        : `${change.pct}% since ${change.from}`}
      {/* A day covering a different set of networks moves the total for a reason that is
          not the market. Saying how many rather than hiding them keeps the line honest. */}
      {incomparable > 0
        ? ` · ${incomparable} day${incomparable === 1 ? '' : 's'} covered different networks`
        : ''}
    </p>
  );
}

/**
 * An inline SVG line, because a chart of a dozen points does not need a library.
 *
 * Days with no figure break the line rather than being drawn at zero — a gap is what "not
 * recorded" looks like, and a dip to zero is a claim the wallet was empty.
 */
function Series({ points }: { points: readonly HistoryPoint[] }) {
  const money = useMoney();

  const values = points.map((point) =>
    point.totalValueUsd === null ? null : Number(point.totalValueUsd),
  );
  const present = values.filter((value): value is number => value !== null);
  const max = Math.max(...present);
  const min = Math.min(...present);
  const span = max - min || 1;

  // Spaced by date, not by index. A week with one reading and a week with seven are
  // different shapes, and an evenly spaced axis would draw them identically — the chart
  // would be claiming a density of observation it does not have.
  const at = (point: HistoryPoint) => Date.parse(`${point.day}T00:00:00Z`);
  const firstAt = at(points[0]!);
  const lastAt = at(points.at(-1)!);
  const elapsed = lastAt - firstAt || 1;
  const x = (index: number) => ((at(points[index]!) - firstAt) / elapsed) * 100;
  const y = (value: number) => 30 - ((value - min) / span) * 26;

  // Each unbroken run of recorded days is its own path, so a missing day leaves a gap —
  // whether it was recorded and unpriceable (a null value) or never recorded at all (a
  // date jump). Connecting across an absent day would draw a reading nobody took
  // (round 15). A run of one is drawn as a dot, because a path with one point renders
  // as nothing and an isolated reading must not vanish.
  const DAY_MS = 86_400_000;
  const runs: string[] = [];
  let current: string[] = [];
  let previousRecorded = -1;
  const close = () => {
    if (current.length === 1) runs.push(`${current[0]} l0.01 0`);
    if (current.length > 1) runs.push(current.join(' '));
    current = [];
  };
  for (const [index, value] of values.entries()) {
    if (value === null) {
      close();
      continue;
    }
    if (previousRecorded >= 0 && at(points[index]!) - at(points[previousRecorded]!) > DAY_MS) {
      close();
    }
    current.push(
      `${current.length === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(value).toFixed(2)}`,
    );
    previousRecorded = index;
  }
  close();

  const latest = points.at(-1);

  return (
    <div className="mt-3">
      <svg
        viewBox="0 0 100 32"
        preserveAspectRatio="none"
        className="h-24 w-full"
        role="img"
        aria-label={`Recorded value from ${points[0]?.day} to ${latest?.day}`}
      >
        {runs.map((path) => (
          <path
            key={path}
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="0.6"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
            className="text-accent"
          />
        ))}
      </svg>

      <div className="mt-1 flex justify-between text-xs text-ink-subtle">
        <span>{points[0]?.day}</span>
        <span className="numeric text-ink">{money(latest?.totalValueUsd ?? null)}</span>
      </div>
    </div>
  );
}
