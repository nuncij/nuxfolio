'use client';

import { useRouter } from 'next/navigation';

import type { PublicChainInfo } from '@/config/chains';
import { ALL_CHAINS } from '@/domain/portfolio';
import { portfolioPath } from '@/domain/portfolioPath';
import type { ChainSelection } from '@/lib/portfolioClient';

/**
 * Network picker.
 *
 * "All networks" is the default and the first option, because a portfolio split
 * across chains is the normal case and a per-chain total answers a narrower
 * question than most people are asking.
 */
export function ChainSelector({
  chains,
  selected,
  address,
  ensName = null,
}: {
  chains: readonly PublicChainInfo[];
  selected: ChainSelection;
  address: string;
  /** Carried across navigation so a wallet reached by name keeps its name. */
  ensName?: string | null;
}) {
  const router = useRouter();

  return (
    <div className="flex items-center gap-2">
      <label htmlFor="chain" className="text-xs font-medium text-ink-muted">
        Network
      </label>
      <select
        id="chain"
        value={String(selected)}
        onChange={(event) => {
          router.push(portfolioPath({ address, ensName, chainId: event.target.value }));
        }}
        className="rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm text-ink"
      >
        <option value={ALL_CHAINS}>All networks ({chains.length})</option>
        {chains.map((chain) => (
          <option key={chain.chainId} value={chain.chainId}>
            {chain.shortName}
          </option>
        ))}
      </select>
    </div>
  );
}
