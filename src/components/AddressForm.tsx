'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { parseWalletAddress } from '@/domain/address';
import { parseEnsName } from '@/domain/ensName';

/**
 * The wallet-address entry point.
 *
 * Validation runs here as well as on the server: the server check is the one
 * that matters for safety, but rejecting a typo without a round trip is the
 * difference between a form that feels broken and one that feels helpful.
 *
 * A `.eth` name is recognised but not resolved here — resolution is server work
 * (it would otherwise tell an RPC provider who the visitor is looking up), so the
 * name is navigated to and the route resolves it and redirects.
 */
export function AddressForm({
  initialAddress = '',
  autoFocus = false,
}: {
  initialAddress?: string;
  autoFocus?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(initialAddress);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    const name = parseEnsName(value);
    if (name.ok) {
      setError(null);
      setSubmitting(true);
      // The route resolves the name and redirects to the canonical address URL.
      router.push(`/portfolio/${name.name}`);
      return;
    }

    const parsed = parseWalletAddress(value);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }

    setError(null);
    setSubmitting(true);
    // No chainId: the route defaults to every supported network.
    router.push(`/portfolio/${parsed.address}`);
  }

  const errorId = 'address-error';

  return (
    <form onSubmit={handleSubmit} className="w-full" noValidate>
      <label htmlFor="address" className="block text-sm font-medium text-ink-muted">
        Public wallet address or ENS name
      </label>

      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <input
          id="address"
          name="address"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error !== null) {
              setError(null);
            }
          }}
          placeholder="0x0000… or name.eth"
          aria-invalid={error !== null}
          aria-describedby={error !== null ? errorId : undefined}
          className="numeric min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-ink-subtle focus:border-line-strong focus:outline-none"
        />

        <button
          type="submit"
          disabled={submitting}
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {submitting ? 'Loading…' : 'View portfolio'}
        </button>
      </div>

      {error !== null ? (
        <p id={errorId} role="alert" className="mt-2 text-sm text-caution">
          {error}
        </p>
      ) : (
        <p className="mt-2 text-xs text-ink-subtle">
          Nuxfolio only reads public chain data. It never asks for a seed phrase or private key.
        </p>
      )}
    </form>
  );
}
