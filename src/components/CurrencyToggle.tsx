'use client';

import { useSyncExternalStore } from 'react';

import type { DisplayCurrency } from '@/lib/displayContext';

/**
 * US dollars or euros.
 *
 * Two states, so one control with two labelled options rather than the theme's
 * three-way group. USD is the default because it is what the system computes in —
 * a euro figure is always a conversion, and the default should be the number that
 * is not.
 *
 * **Hydration.** Same reasoning as `ThemeToggle`: the preference lives in
 * `localStorage`, which the server cannot read, so `useSyncExternalStore` supplies
 * a server snapshot and React re-reads the real value after hydrating. Reading it
 * in an effect would be a synchronous state update during mount — the pattern that
 * has already hidden one real bug here (ADR-010, ADR-016).
 *
 * The control is only rendered when a rate exists; a currency button that cannot
 * convert is worse than no button.
 */
export function CurrencyToggle() {
  const currency = useSyncExternalStore(subscribeToCurrency, readCurrency, readServerCurrency);

  function choose(next: DisplayCurrency): void {
    try {
      if (next === DEFAULT_CURRENCY) {
        window.localStorage.removeItem(CURRENCY_STORAGE_KEY);
      } else {
        window.localStorage.setItem(CURRENCY_STORAGE_KEY, next);
      }
    } catch {
      // The choice still applies to this page; it just will not be remembered.
    }
    notifyChanged();
  }

  return (
    <div
      role="group"
      aria-label="Display currency"
      className="flex items-center gap-0.5 rounded-full border border-line bg-surface p-0.5"
    >
      {CURRENCIES.map((option) => {
        const active = currency === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => choose(option)}
            aria-pressed={active}
            title={`Show values in ${option === 'EUR' ? 'euro' : 'US dollars'}`}
            className={`flex h-6 min-w-9 items-center justify-center rounded-full px-2 text-[11px] font-medium transition-colors ${
              active
                ? 'bg-accent text-accent-ink'
                : 'text-ink-subtle hover:bg-surface-raised hover:text-ink'
            }`}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}

export const CURRENCIES = ['USD', 'EUR'] as const satisfies readonly DisplayCurrency[];
export const CURRENCY_STORAGE_KEY = 'nuxfolio.currency';
export const DEFAULT_CURRENCY: DisplayCurrency = 'USD';

/**
 * Reads the stored value defensively. `localStorage` holds whatever a previous
 * version of the app — or the user's devtools — put there, so anything
 * unrecognised falls back to the default rather than throwing.
 */
export function parseCurrency(value: unknown): DisplayCurrency {
  return value === 'EUR' ? 'EUR' : DEFAULT_CURRENCY;
}

/** Module scope, so several toggles and several tabs cannot disagree. */
const listeners = new Set<() => void>();

export function subscribeToCurrency(onChange: () => void): () => void {
  listeners.add(onChange);
  // `storage` fires in *other* tabs only, which is the cross-tab case.
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function notifyChanged(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Reads the live value. Called on every render, so it must stay cheap. */
export function readCurrency(): DisplayCurrency {
  try {
    return parseCurrency(window.localStorage.getItem(CURRENCY_STORAGE_KEY));
  } catch {
    return DEFAULT_CURRENCY;
  }
}

/**
 * The server snapshot. Always the default: the server cannot know the preference,
 * and guessing would produce markup that disagrees with the first client render.
 */
export function readServerCurrency(): DisplayCurrency {
  return DEFAULT_CURRENCY;
}
