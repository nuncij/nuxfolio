import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AddressForm } from '@/components/AddressForm';
import { BundleView } from '@/components/BundleView';
import { listPublicChains } from '@/config/chains';
import { parseAssetSort } from '@/domain/assetSort';
import { parseBundleRequest, shouldRenderBundle } from '@/domain/bundleRequest';
import { portfolioPath } from '@/domain/portfolioPath';

/**
 * Several wallets on one page: `/bundle/0xA,0xB,0xC`.
 *
 * Validated on the server before anything renders, as the single-wallet route is, so
 * a broken link produces a helpful page rather than a client component firing requests
 * destined to fail.
 *
 * **A single valid address still renders here when something was rejected.** The
 * obvious behaviour — redirect to that wallet's own page — would erase the notice
 * saying what was dropped, and a page cannot report what it discarded once it is no
 * longer the page. Redirecting happens only when there is nothing to report.
 *
 * **ENS names are refused**, not resolved. Resolution is an `eth_call` on the render
 * path outside the API rate limiter — already the one hard prerequisite before this
 * product could be public — and a bundle URL would let a stranger choose the
 * multiplier.
 */

type PageProps = {
  params: Promise<{ addresses: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { addresses } = await params;
  const request = parseBundleRequest(safeDecode(addresses));

  return {
    // Deliberately just a count. A bundle URL discloses an *association* between
    // addresses, which is more sensitive than any one of them, so the list stays out
    // of the title and out of anything a browser might keep or send.
    title:
      request.addresses.length > 0
        ? `${request.addresses.length} wallets combined`
        : 'Invalid bundle',
    robots: { index: false, follow: false },
  };
}

export default async function BundlePage({ params, searchParams }: PageProps) {
  const [{ addresses }, query] = await Promise.all([params, searchParams]);
  const request = parseBundleRequest(safeDecode(addresses));

  if (!shouldRenderBundle(request)) {
    const only = request.addresses[0];
    if (only !== undefined) {
      // Exactly one wallet and nothing was lost: its own page is the better view.
      redirect(portfolioPath({ address: only }));
    }
    return <NothingToBundle />;
  }

  return (
    <BundleView
      // Keyed on the request, so navigating to a different bundle remounts with
      // fresh state instead of showing the previous one's totals while loading.
      key={request.addresses.join(',')}
      request={request}
      chains={listPublicChains()}
      initialSort={parseAssetSort({ sort: query.sort, dir: query.dir })}
    />
  );
}

function NothingToBundle() {
  return (
    <div className="mx-auto max-w-2xl py-8 sm:py-16">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">
        That bundle has no valid addresses
      </h1>
      <p className="mt-3 text-sm text-ink-muted">
        A bundle is a list of public addresses separated by commas, like{' '}
        <span className="numeric">/bundle/0xabc…,0xdef…</span>. ENS names are not accepted here —
        look a name up on its own first, then bundle the address it resolves to.
      </p>

      <div className="mt-8">
        <AddressForm autoFocus />
      </div>

      <p className="mt-4 text-sm text-ink-subtle">
        <Link href="/" className="text-accent hover:underline">
          Back to the start
        </Link>
      </p>
    </div>
  );
}

/** A malformed percent-escape is a bad URL, not a crash. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
