import type { PortfolioWarning } from '@/domain/portfolio';

/**
 * Data caveats, shown rather than swallowed.
 *
 * Every warning here corresponds to something Nuxfolio could not do: a token
 * list that does not cover everything, a price batch that failed, a quote that
 * is old. The product's position is that a visible gap is more useful than a
 * confident-looking number with a hole in it.
 *
 * **Collapsed by default, but never silent.** A keyless load carries three or four
 * of these on every request, and a permanent wall of caution above the numbers is
 * how a caveat becomes wallpaper — read once, then never again. So the summary line
 * stays visible and states *how many* there are; only the detail folds away. That
 * keeps the honest claim ("this view is incomplete, here is the count") at full
 * strength while costing one line instead of five.
 *
 * `<details>` rather than a `useState` toggle: it is a server component this way,
 * it works before hydration, and the keyboard and screen-reader behaviour is the
 * browser's rather than something to reimplement and get subtly wrong.
 *
 * The `<section>` around it is not decoration. `<details>` carries the ARIA role
 * `group`, not `region`, so collapsing the panel into a bare `<details>` would have
 * quietly removed a landmark a screen-reader user can jump to — trading one
 * accessibility win for a different accessibility loss. The section keeps the
 * landmark and its name; the `<details>` inside supplies the disclosure.
 */
export function WarningPanel({ warnings }: { warnings: readonly PortfolioWarning[] }) {
  if (warnings.length === 0) {
    return null;
  }

  return (
    <section aria-label="Data limitations">
      <details className="group rounded-xl border border-caution-line bg-caution-surface [&[open]>summary]:mb-2">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-xl p-4 text-xs font-semibold tracking-wide text-caution uppercase focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-caution [&::-webkit-details-marker]:hidden">
          {/* Rotates to point down when open; hidden from assistive tech because
              `<summary>` already announces its own expanded state. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3l5 5-5 5" />
          </svg>
          <span>
            What this view does not include
            {/* The count is the part that must survive collapsing: it is the
                difference between "there are caveats" and "there are four". */}
            <span className="ml-1.5 normal-case opacity-80">
              ({warnings.length} {warnings.length === 1 ? 'note' : 'notes'})
            </span>
          </span>
        </summary>

        <ul className="space-y-1.5 px-4 pb-4">
          {warnings.map((warning) => (
            <li key={warning.code} className="flex gap-2 text-sm text-ink-muted">
              <span
                aria-hidden="true"
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-caution"
              />
              <span>{warning.message}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
