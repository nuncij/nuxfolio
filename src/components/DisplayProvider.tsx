'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { FxQuote } from '@/domain/portfolio';
import {
  toDisplayCurrency,
  USD_DISPLAY,
  type DisplayContext,
  type DisplayCurrency,
} from '@/lib/displayContext';
import { formatUsd } from '@/lib/format';

/**
 * Which currency figures render in, supplied by context rather than by props.
 *
 * A prop would have to be threaded through every component that shows money —
 * summary cards, the asset table, the network breakdown, the insights panel — and
 * review of the plan for this feature pointed out that the first draft had already
 * missed one of them. A missed component does not fail to compile; it renders
 * unconverted dollars next to euros, which is worse than either alone.
 *
 * So the rule is: **no component formats money except through `useMoney`.**
 */

const DisplayCurrencyContext = createContext<DisplayContext>(USD_DISPLAY);

export function DisplayProvider({
  currency,
  fxRate,
  children,
}: {
  currency: DisplayCurrency;
  fxRate: FxQuote | null;
  children: ReactNode;
}) {
  const value = useMemo<DisplayContext>(() => ({ currency, fxRate }), [currency, fxRate]);
  return (
    <DisplayCurrencyContext.Provider value={value}>{children}</DisplayCurrencyContext.Provider>
  );
}

export function useDisplayContext(): DisplayContext {
  return useContext(DisplayCurrencyContext);
}

/**
 * Formats a USD decimal string in the active display currency.
 *
 * Conversion happens once, in `Decimal`, and the rounding happens once after it —
 * so a euro figure is not a rounded dollar figure converted, which would compound
 * two roundings.
 */
export function useMoney(): (valueUsd: string | null) => string {
  const context = useDisplayContext();

  return useMemo(() => {
    if (context.currency === 'USD' || context.fxRate === null) {
      return formatUsd;
    }
    return (valueUsd: string | null) => {
      const converted = toDisplayCurrency(valueUsd, context);
      // A conversion that could not be done renders the same placeholder an
      // absent value does, rather than a number that is not the right one.
      return converted === null ? formatUsd(null) : formatUsd(converted).replace('$', '€');
    };
  }, [context]);
}
