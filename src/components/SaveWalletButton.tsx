'use client';

import { useState } from 'react';

import { isSaved, MAX_WALLETS, type WriteResult } from '@/lib/savedWallets';

import { useSavedWallets } from './useSavedWallets';

/**
 * Saves the wallet being viewed, or removes it.
 *
 * Nothing is saved automatically. A product that quietly remembered every address
 * pasted into it would be building a list the user never asked for, on a machine
 * that might not be theirs alone.
 *
 * A failed save is always said out loud. `localStorage` can refuse a write — quota,
 * a locked store, private mode — and a save the user believes happened is worse than
 * one they know failed.
 */
export function SaveWalletButton({
  address,
  ensName,
}: {
  address: string;
  ensName: string | null;
}) {
  const { state, save, remove } = useSavedWallets();
  const [problem, setProblem] = useState<string | null>(null);

  const saved = isSaved(state.wallets, address);

  // Storage is unreadable or written by a newer build, so a write would either
  // fail or destroy data. Offering the control anyway would promise something that
  // cannot happen.
  if (state.status === 'unavailable' || state.status === 'unsupportedVersion') {
    return null;
  }

  function act(): void {
    const result = saved ? remove(address) : save({ address, ensName });
    setProblem(result.ok ? null : describeFailure(result));
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={act}
        aria-pressed={saved}
        title={saved ? 'Remove from your saved wallets' : 'Save this wallet in this browser'}
        className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
          saved
            ? 'border-accent text-accent hover:bg-surface-raised'
            : 'border-line bg-surface text-ink-muted hover:text-ink'
        }`}
      >
        {saved ? 'Saved' : 'Save'}
      </button>
      {problem === null ? null : (
        <p role="alert" className="max-w-56 text-right text-xs text-caution">
          {problem}
        </p>
      )}
    </div>
  );
}

function describeFailure(result: Extract<WriteResult, { ok: false }>): string {
  switch (result.reason) {
    case 'full':
      return `You have ${MAX_WALLETS} saved wallets, which is the limit. Remove one to save another.`;
    case 'invalidAddress':
      return 'That address could not be saved because it is not a valid one.';
    case 'unsupportedVersion':
      return 'Your saved wallets were written by a newer version of Nuxfolio, so this one will not change them.';
    case 'unavailable':
      return 'Could not save — this browser is not allowing Nuxfolio to store anything.';
  }
}
