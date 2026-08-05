import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AddressForm } from '@/components/AddressForm';
import { PortfolioView } from '@/components/PortfolioView';
import { getChainConfig, listPublicChains } from '@/config/chains';
import { parseWalletAddress, shortenAddress } from '@/domain/address';
import { parseAssetSort } from '@/domain/assetSort';
import { parseEnsName } from '@/domain/ensName';
import { ALL_CHAINS } from '@/domain/portfolio';
import type { ChainSelection } from '@/lib/portfolioClient';
import { resolvePortfolioRoute } from '@/server/addressRoute';
import { resolveEnsNameGated } from '@/server/ensGate';

/**
 * The shareable portfolio route: `/portfolio/0x…?chainId=1` for one network, or
 * `?chainId=all` — the default — for every supported network at once.
 *
 * The address is validated and the selection resolved on the server, so an
 * invalid link renders a helpful page instead of mounting a client component
 * that would fire a request destined to fail. A `.eth` name is resolved here too
 * and then redirected away, so the URL that gets shared always names the address
 * the numbers belong to.
 */

type PageProps = {
  params: Promise<{ address: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { address } = await params;

  return {
    title: describeTarget(address),
    // A wallet lookup is not something to hand to search engines.
    robots: { index: false, follow: false },
  };
}

/**
 * The title without resolving anything: metadata is generated alongside the page,
 * and a name here would otherwise cost a second ENS lookup for one line of text.
 */
function describeTarget(rawParam: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawParam);
  } catch {
    return 'Invalid address';
  }

  const name = parseEnsName(decoded);
  if (name.ok) {
    return `${name.name} portfolio`;
  }

  const parsed = parseWalletAddress(decoded);
  return parsed.ok ? `${shortenAddress(parsed.address)} portfolio` : 'Invalid address';
}

export default async function PortfolioPage({ params, searchParams }: PageProps) {
  const [{ address }, query] = await Promise.all([params, searchParams]);

  const route = await resolvePortfolioRoute({
    addressParam: address,
    query,
    // Name resolution costs an `eth_call`, so it goes through the render-path
    // rate limiter (see ensGate.ts). `headers()` is read inside the callback on
    // purpose: it only runs when the segment is actually a name, so a plain 0x
    // render never touches request state.
    resolve: async (name) => resolveEnsNameGated(name, await headers()),
  });

  if (route.kind === 'redirect') {
    // A resolved name never renders: the address is the canonical URL, and the
    // name follows it as a display-only parameter.
    redirect(route.path);
  }

  if (route.kind === 'invalid') {
    return <InvalidAddress message={route.message} reason={route.reason} />;
  }

  const selection = resolveChainSelection(query.chainId);
  if (selection === null) {
    return <UnsupportedChain raw={String(query.chainId)} />;
  }

  return (
    // Keyed so that navigating to a different wallet or network remounts the
    // view with fresh state, instead of showing the previous selection's assets
    // while the new request is still in flight.
    <PortfolioView
      key={`${selection}:${route.address}`}
      address={route.address}
      ensName={route.ensName}
      selectedChainId={selection}
      chains={listPublicChains()}
      // Parsed here rather than in the table: the query string is already available
      // server-side, and reading it in a client component would add a Suspense
      // requirement for nothing.
      initialSort={parseAssetSort({ sort: query.sort, dir: query.dir })}
    />
  );
}

/**
 * Resolves the `chainId` query value.
 *
 * Defaults to every network: a wallet spread across chains is the normal case,
 * and showing one network's subtotal as though it were the portfolio is the
 * kind of partial truth this product is built to avoid. Returns null for a
 * value that names no supported chain.
 */
function resolveChainSelection(raw: string | string[] | undefined): ChainSelection | null {
  const value = Array.isArray(raw) ? raw[0] : raw;

  if (value === undefined || value === ALL_CHAINS) {
    return ALL_CHAINS;
  }

  const chainId = Number(value);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return null;
  }
  return getChainConfig(chainId) === undefined ? null : chainId;
}

/**
 * The heading follows the reason, because they ask for different things. A
 * throttled name lookup under "that address does not look right" sends someone to
 * re-check a spelling that was correct (review round 11); the address they typed
 * may be perfectly good, and pasting the 0x form is never rate limited.
 */
function InvalidAddress({
  message,
  reason,
}: {
  message: string;
  reason?: 'rate-limited' | undefined;
}) {
  const throttled = reason === 'rate-limited';

  return (
    <div className="mx-auto max-w-xl py-12">
      <h1 className="text-xl font-semibold text-ink">
        {throttled ? 'Too many name lookups just now' : 'That address does not look right'}
      </h1>
      <p className="mt-2 text-sm text-ink-muted">{message}</p>
      <div className="mt-6">
        <AddressForm autoFocus />
      </div>
    </div>
  );
}

function UnsupportedChain({ raw }: { raw: string }) {
  const supported = listPublicChains()
    .map((chain) => chain.shortName)
    .join(', ');

  return (
    <div className="mx-auto max-w-xl py-12">
      <h1 className="text-xl font-semibold text-ink">That network is not supported yet</h1>
      <p className="mt-2 text-sm text-ink-muted">
        Nuxfolio does not know network &quot;{raw}&quot;. Available today: {supported}.
      </p>
      <Link href="/" className="mt-6 inline-block text-sm text-accent hover:underline">
        Back to start
      </Link>
    </div>
  );
}
