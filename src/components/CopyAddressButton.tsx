'use client';

import { useEffect, useState } from 'react';

/**
 * Copies the wallet address to the clipboard.
 *
 * Small, and with two things worth getting right.
 *
 * **It copies the full address, never the shortened one.** The header displays
 * `0xd8dA…6045` because a full address does not fit; copying what is *displayed*
 * would hand over a string that is not an address at all, and the failure would only
 * show up when someone pasted it somewhere that mattered.
 *
 * **A refusal is reported.** The Clipboard API needs a secure context and a user
 * gesture, and can be denied outright. A button that silently did nothing would leave
 * someone pasting whatever was on their clipboard before.
 */
export function CopyAddressButton({ address }: { address: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  // The confirmation is transient; the button has to go back to offering the action.
  useEffect(() => {
    if (state === 'idle') {
      return;
    }
    const timer = setTimeout(() => setState('idle'), 2_000);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(address);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <button
      type="button"
      onClick={() => void copy()}
      // The full address is in the label, so a screen reader announces what will be
      // copied rather than "copy address" with no referent.
      aria-label={`Copy the full address ${address}`}
      title={state === 'failed' ? 'This browser would not allow copying' : address}
      className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
        state === 'failed'
          ? 'border-caution-line text-caution'
          : 'border-line bg-surface text-ink-muted hover:text-ink'
      }`}
    >
      {/*
        `aria-live` on the label rather than a separate region: the button's own text
        changing is the confirmation, and announcing it twice would be worse than once.
      */}
      <span aria-live="polite">
        {state === 'copied' ? 'Copied' : state === 'failed' ? 'Could not copy' : 'Copy address'}
      </span>
    </button>
  );
}
