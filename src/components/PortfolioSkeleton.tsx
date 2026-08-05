/** Loading placeholders shaped like the content they replace, to avoid layout shift. */
export function PortfolioSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="space-y-6">
      <span className="sr-only">Loading portfolio…</span>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="rounded-xl border border-line bg-surface p-4">
            <Shimmer className="h-3 w-24" />
            <Shimmer className="mt-3 h-6 w-32" />
            <Shimmer className="mt-2 h-3 w-20" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-line">
        <div className="border-b border-line bg-surface-raised px-4 py-3">
          <Shimmer className="h-3 w-40" />
        </div>
        {Array.from({ length: 5 }, (_, index) => (
          <div
            key={index}
            className="flex items-center justify-between border-b border-line/60 px-4 py-3 last:border-0"
          >
            <div className="flex items-center gap-3">
              <Shimmer className="size-8 rounded-full" />
              <div>
                <Shimmer className="h-3 w-16" />
                <Shimmer className="mt-1.5 h-2.5 w-28" />
              </div>
            </div>
            <Shimmer className="h-3 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}

function Shimmer({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-line-strong/60 ${className}`} />;
}
