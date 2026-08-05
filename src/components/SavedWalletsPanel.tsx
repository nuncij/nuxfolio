'use client';

import { useState } from 'react';

import { shortenAddress } from '@/domain/address';
import { bundlePath, BUNDLE_MAX_MEMBERS } from '@/domain/bundleRequest';
import { portfolioPath } from '@/domain/portfolioPath';
import type { ReadResult } from '@/lib/savedWallets';

import { useSavedWallets } from './useSavedWallets';

/**
 * The saved wallets, on the landing page.
 *
 * Two things here are deliberate and would be easy to get wrong.
 *
 * **Plain `<a>`, not `next/link`.** A `<Link>` prefetches the route it points at, so
 * ten saved wallets would send ten addresses to the server merely by opening this
 * page — telling it precisely the list this feature exists to keep private.
 *
 * `prefetch={false}` would probably also do, and an earlier version used it. A plain
 * anchor is preferred anyway: it has no prefetch behaviour to disable, so the
 * guarantee does not depend on what a framework flag currently means, and it keeps
 * every property a link should have — middle-click, "copy link address", and a real
 * `href` for a screen reader.
 *
 * The cost is a full navigation instead of a client-side transition. On a link that
 * leaves the landing page for a data-fetching route, that is barely perceptible and
 * plainly worth it.
 *
 * Rows also link by canonical address rather than by ENS name, so listing a wallet
 * cannot trigger a server-side name resolution either.
 *
 * **"You have no saved wallets" is only said when that is known.** A store that is
 * corrupt, unreadable or written by a newer build is not an empty one, and saying so
 * would be a false claim — the same rule the rest of the product applies to a price
 * it could not fetch.
 */
export function SavedWalletsPanel() {
  const { state, remove, clear } = useSavedWallets();
  const [managing, setManaging] = useState(false);

  const notice = describeState(state);

  // Nothing to show and nothing to explain. Both halves matter: an absent key and a
  // stored-but-empty list are different read outcomes (`empty` versus `ok` with no
  // wallets, which is what removing the last one leaves behind) and neither is worth
  // a panel. A notice, on the other hand, is always worth showing — that is the case
  // where silence would be the false claim.
  if (state.wallets.length === 0 && notice === null) {
    return null;
  }

  return (
    <section aria-label="Saved wallets" className="mt-10 border-t border-line pt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
          Saved wallets
        </h2>
        {state.wallets.length >= 2 ? (
          <a
            /*
             * A plain anchor, like every row here. A prefetching link would put the
             * entire saved list — up to ten addresses in one URL — on the wire before
             * any click, which is exactly what this panel exists not to do (ADR-023).
             */
            href={bundlePath(
              state.wallets.slice(0, BUNDLE_MAX_MEMBERS).map((wallet) => wallet.address),
            )}
            className="text-xs text-accent hover:underline"
          >
            View together
          </a>
        ) : null}
        {state.wallets.length > 0 ? (
          <button
            type="button"
            onClick={() => setManaging((current) => !current)}
            aria-expanded={managing}
            className="text-xs text-ink-subtle hover:text-ink"
          >
            {managing ? 'Done' : 'Manage'}
          </button>
        ) : null}
      </div>

      {notice === null ? null : (
        <p role="status" className="mt-3 text-xs text-caution">
          {notice}
        </p>
      )}

      <ul className="mt-3 divide-y divide-line">
        {state.wallets.map((wallet) => (
          <li key={wallet.address} className="flex items-center gap-3 py-2.5">
            {/* Canonical address, and a plain anchor so nothing is prefetched. */}
            <a
              href={portfolioPath({ address: wallet.address })}
              className="min-w-0 flex-1 hover:text-accent"
            >
              <span className="block truncate text-sm font-medium text-ink">
                {wallet.label ?? wallet.ensName ?? shortenAddress(wallet.address)}
              </span>
              {/*
                The canonical address is always shown, never replaced by a label.
                A label is user text; the address is the identity.
              */}
              <span className="numeric block truncate text-xs text-ink-subtle">
                {shortenAddress(wallet.address)}
              </span>
            </a>

            {managing ? (
              <button
                type="button"
                onClick={() => remove(wallet.address)}
                className="shrink-0 rounded border border-line px-2 py-1 text-xs text-ink-subtle hover:text-caution"
              >
                Remove
              </button>
            ) : (
              <span aria-hidden="true" className="shrink-0 text-ink-subtle">
                →
              </span>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-baseline justify-between gap-3">
        <p className="text-xs text-ink-subtle">
          Stored in this browser only — never sent to a server, and not shared with your other
          devices.
        </p>
        {managing && state.wallets.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              clear();
              setManaging(false);
            }}
            className="shrink-0 text-xs text-caution hover:underline"
          >
            Remove all
          </button>
        ) : null}
      </div>
    </section>
  );
}

/**
 * What to say when the list could not be read cleanly.
 *
 * Null in the ordinary case. Every other case is stated rather than swallowed,
 * because each one means something different from "you have not saved anything".
 */
function describeState(state: ReadResult): string | null {
  switch (state.status) {
    case 'ok':
    case 'empty':
      return null;
    case 'partiallyInvalid':
      return `${state.droppedCount} saved ${state.droppedCount === 1 ? 'entry' : 'entries'} could not be read and ${state.droppedCount === 1 ? 'was' : 'were'} left out of this list.`;
    case 'unsupportedVersion':
      return 'Your saved wallets were written by a newer version of Nuxfolio. They are being left untouched rather than shown or changed.';
    case 'corrupt':
      return 'Your saved wallets could not be read. They have not been deleted — saving a wallet now would replace them.';
    case 'unavailable':
      return 'This browser is not letting Nuxfolio read stored data, so saved wallets cannot be shown.';
  }
}
