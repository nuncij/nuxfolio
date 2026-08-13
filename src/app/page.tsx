import Link from 'next/link';

import { AddressForm } from '@/components/AddressForm';
import { SavedWalletsPanel } from '@/components/SavedWalletsPanel';
import { listPublicChains } from '@/config/chains';

/** A well-known public address, so the product can be tried without owning a wallet. */
const EXAMPLE_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

export default function HomePage() {
  const chains = listPublicChains();
  const tokenCount = chains.reduce((sum, chain) => sum + chain.tokenListSize, 0);

  return (
    <div className="mx-auto max-w-2xl py-8 sm:py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
        Your crypto portfolio, clearly explained.
      </h1>
      <p className="mt-4 text-base text-ink-muted">
        Enter a public wallet address or a .eth name to see what it holds, what it is worth today,
        and where the concentration sits. Nuxfolio reads public data only — there is nothing to
        connect and nothing to sign.
      </p>

      <div className="mt-8">
        <AddressForm autoFocus />
      </div>

      <p className="mt-4 text-sm text-ink-subtle">
        No address handy?{' '}
        <Link href={`/portfolio/${EXAMPLE_ADDRESS}`} className="text-accent hover:underline">
          Try a public example wallet
        </Link>
        . Balances no chain can show — exchange accounts, cold storage — live under{' '}
        <Link href="/manual" className="text-accent hover:underline">
          reported balances
        </Link>
        .
      </p>

      <SavedWalletsPanel />

      <dl className="mt-10 grid grid-cols-1 gap-4 border-t border-line pt-8 sm:grid-cols-3">
        <Fact term="What you get">
          {`Native and ERC-20 balances across ${chains.length} networks — ${tokenCount.toLocaleString('en-US')} tokens checked — with unit prices, position values and each holding's share of the portfolio.`}
        </Fact>
        <Fact term="Where it comes from">
          {`Public RPC endpoints on ${chains.length} networks (${chains
            .map((chain) => chain.shortName)
            .join(', ')}) for balances, and a public market-data API for prices.`}
        </Fact>
        <Fact term="What it will not do">
          Ask for a seed phrase, connect a wallet, move funds, or claim an estimate is an exact
          figure.
        </Fact>
      </dl>
    </div>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold tracking-wide text-ink-muted uppercase">{term}</dt>
      <dd className="mt-1.5 text-sm text-ink-subtle">{children}</dd>
    </div>
  );
}
