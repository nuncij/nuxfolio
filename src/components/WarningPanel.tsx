import type { PortfolioWarning } from '@/domain/portfolio';

/**
 * Data caveats, shown rather than swallowed.
 *
 * Every warning here corresponds to something Nuxfolio could not do: a token
 * list that does not cover everything, a price batch that failed, a quote that
 * is old. The product's position is that a visible gap is more useful than a
 * confident-looking number with a hole in it.
 */
export function WarningPanel({ warnings }: { warnings: readonly PortfolioWarning[] }) {
  if (warnings.length === 0) {
    return null;
  }

  return (
    <section
      aria-label="Data limitations"
      className="rounded-xl border border-caution-line bg-caution-surface p-4"
    >
      <h2 className="text-xs font-semibold tracking-wide text-caution uppercase">
        What this view does not include
      </h2>
      <ul className="mt-2 space-y-1.5">
        {warnings.map((warning) => (
          <li key={warning.code} className="flex gap-2 text-sm text-ink-muted">
            <span aria-hidden="true" className="mt-1.5 size-1.5 shrink-0 rounded-full bg-caution" />
            <span>{warning.message}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
