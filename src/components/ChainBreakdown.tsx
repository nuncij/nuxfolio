import type { AggregatePortfolio } from '@/domain/portfolio';
import { compareDecimal, percentageOf } from '@/domain/money';
import { portfolioPath } from '@/domain/portfolioPath';
import { formatPercent } from '@/lib/format';

import { useMoney } from './DisplayProvider';

/**
 * Where the money sits, by network.
 *
 * This is the first question a cross-chain view has to answer, and it is the
 * one a flat asset table answers worst. Chains that could not be read are listed
 * alongside the ones that could — a network missing from a total without
 * explanation is the same quiet error as an unpriced asset missing from it.
 *
 * Each readable card links to that network on its own. A plain anchor rather than a
 * prefetching link, for the reason the rest of this app uses plain anchors to wallet
 * routes: a card scrolling into view should not fetch a portfolio nobody asked for.
 *
 * The unavailable cards are deliberately **not** links. Offering to open a network
 * that could not be read is offering a page that will fail.
 */
export function ChainBreakdown({
  aggregate,
  ensName = null,
}: {
  aggregate: AggregatePortfolio;
  /** Carried into the link so a portfolio reached by name keeps its name. */
  ensName?: string | null;
}) {
  const money = useMoney();
  const ranked = [...aggregate.chains]
    .filter((chain) => chain.assetCount > 0)
    .sort((a, b) => {
      if (a.totalValueUsd === null && b.totalValueUsd === null) return 0;
      if (a.totalValueUsd === null) return 1;
      if (b.totalValueUsd === null) return -1;
      return -compareDecimal(a.totalValueUsd, b.totalValueUsd);
    });

  if (ranked.length === 0 && aggregate.failedChains.length === 0) {
    return null;
  }

  return (
    <section aria-label="Value by network" className="rounded-xl border border-line bg-surface p-4">
      <h2 className="text-xs font-medium tracking-wide text-ink-muted uppercase">
        Value by network
      </h2>

      <ul className="mt-3 flex flex-wrap gap-2">
        {ranked.map((chain) => {
          const share =
            chain.totalValueUsd !== null && aggregate.totalValueUsd !== null
              ? percentageOf(chain.totalValueUsd, aggregate.totalValueUsd)
              : null;

          return (
            <li key={chain.chainId} className="flex min-w-36 flex-1">
              <a
                href={portfolioPath({
                  address: aggregate.address,
                  chainId: String(chain.chainId),
                  ensName,
                })}
                className="flex w-full flex-col rounded-lg border border-line bg-surface-raised px-3 py-2 hover:border-line-strong"
              >
                <span className="text-xs text-ink-muted">{chain.chainName}</span>
                <span className="numeric mt-0.5 text-sm font-semibold text-ink">
                  {money(chain.totalValueUsd)}
                </span>
                <span className="numeric text-[11px] text-ink-subtle">
                  {share === null ? `${chain.assetCount} assets` : formatPercent(share)} ·{' '}
                  {chain.assetCount} {chain.assetCount === 1 ? 'asset' : 'assets'}
                </span>
              </a>
            </li>
          );
        })}

        {aggregate.failedChains.map((chain) => (
          <li
            key={chain.chainId}
            className="flex min-w-36 flex-1 flex-col rounded-lg border border-caution-line bg-caution-surface px-3 py-2"
            title={chain.message}
          >
            <span className="text-xs text-ink-muted">{chain.chainName}</span>
            <span className="mt-0.5 text-sm font-semibold text-caution">Unavailable</span>
            <span className="text-[11px] text-ink-subtle">Not counted in the total</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
