import 'server-only';

import { parseWalletAddress, type WalletAddress } from '@/domain/address';
import { parseEnsName } from '@/domain/ensName';
import { portfolioPath } from '@/domain/portfolioPath';

import type { EnsResolution } from './ens';

/**
 * What `/portfolio/<something>` should do.
 *
 * Kept out of the page component so the decision is testable without rendering:
 * the page is then a switch over the three outcomes, and the rule that a name
 * never stays in the URL is asserted here rather than assumed there.
 */

export type PortfolioRouteDecision =
  | { kind: 'portfolio'; address: WalletAddress; ensName: string | null }
  | { kind: 'redirect'; path: string }
  /**
   * `reason` distinguishes what the page should say. A throttled lookup is not a
   * bad address, and rendering it under "that address does not look right" told
   * the visitor to check a spelling that was fine (review round 11). Absent for
   * the genuinely-invalid cases, where the message speaks for itself.
   */
  | { kind: 'invalid'; message: string; reason?: 'rate-limited' };

/** Next.js hands over a repeated query parameter as an array. */
export type QueryValue = string | string[] | undefined;

export type PortfolioRouteInput = {
  /** The raw `[address]` path segment, still percent-encoded. */
  addressParam: string;
  query?: Readonly<Record<string, QueryValue>>;
  /**
   * How a name becomes an address. **Mandatory, and that is the security
   * property**: resolution costs an `eth_call`, so it must go through the
   * render-path rate limiter (`resolveEnsNameGated`, ADR-025). This used to
   * default to the ungated `resolveEnsName`, which meant deleting one line in
   * `page.tsx` would silently reopen the hole with every test still green —
   * review round 11 found exactly that. With no default, the caller has to name
   * its choice and the type system asks the question.
   */
  resolve: (name: string) => Promise<EnsResolution>;
};

/**
 * Resolves what the route should render or redirect to.
 *
 * An ENS name is resolved and then redirected away, so the address stays the
 * canonical identity of the URL: `/portfolio/vitalik.eth` never renders a
 * portfolio, it becomes `/portfolio/0x…?ens=vitalik.eth`. Only `chainId` survives
 * the redirect — it is the one other parameter the page understands, and copying
 * arbitrary parameters into a redirect target is how open-redirect bugs start.
 */
export async function resolvePortfolioRoute(
  input: PortfolioRouteInput,
): Promise<PortfolioRouteDecision> {
  const decoded = decodePathSegment(input.addressParam);
  if (decoded === null) {
    return { kind: 'invalid', message: 'That link is not a valid wallet address.' };
  }

  const query = input.query ?? {};
  const name = parseEnsName(decoded);

  if (name.ok) {
    const resolution = await input.resolve(name.name);

    if (!resolution.ok) {
      return resolution.reason === 'rate-limited'
        ? { kind: 'invalid', message: resolution.message, reason: 'rate-limited' }
        : { kind: 'invalid', message: resolution.message };
    }
    return {
      kind: 'redirect',
      path: portfolioPath({
        address: resolution.address,
        ensName: name.name,
        chainId: firstQueryValue(query.chainId),
      }),
    };
  }

  const parsed = parseWalletAddress(decoded);
  if (!parsed.ok) {
    return { kind: 'invalid', message: parsed.message };
  }

  // The `ens` parameter is whatever the last link-sharer put there, so it is
  // re-validated as a name before it can be rendered, and it is never treated as
  // a claim that this address owns the name — the header says "entered as".
  const claimed = parseEnsName(firstQueryValue(query.ens) ?? '');

  return {
    kind: 'portfolio',
    address: parsed.address,
    ensName: claimed.ok ? claimed.name : null,
  };
}

function firstQueryValue(value: QueryValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Percent-decodes a path segment. A malformed escape sequence is a bad link
 * rather than a server fault, so it is reported instead of thrown.
 */
function decodePathSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}
