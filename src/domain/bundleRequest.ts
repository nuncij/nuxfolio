import { parseWalletAddress, type WalletAddress } from './address';
import { parseEnsName } from './ensName';

/**
 * Turning `/bundle/0xA,0xB,0xC` into a list of wallets to load.
 *
 * The result is a structured record rather than a filtered array, because every
 * input that did not make it is something the page has to be able to say out loud.
 * Silently dropping a segment of a URL somebody shared is the quiet kind of wrong
 * this product avoids: the reader would see three wallets totalled and have no way
 * to know a fourth was asked for.
 *
 * **De-duplication is a money rule, not tidiness.** `/bundle/0xA,0xA` totalling the
 * same wallet twice would overstate by 100 % and look entirely plausible.
 */

/** More than anyone bundles by hand, and low enough to bound the fan-out. */
export const BUNDLE_MAX_MEMBERS = 10;

/**
 * Bounds on the raw path segment, applied **before** anything is parsed.
 *
 * The order matters: capping accepted addresses first would let a dozen junk
 * segments crowd out two real ones, and an unbounded segment is an
 * attacker-controlled amount of parsing work.
 */
export const BUNDLE_MAX_RAW_LENGTH = 2_048;
export const BUNDLE_MAX_SEGMENTS = 32;

export type RejectedInput = {
  readonly input: string;
  readonly reason: 'not-an-address' | 'ens-name' | 'too-many-segments';
};

export type BundleRequest = {
  /** Accepted, checksummed, de-duplicated, in the order given. */
  readonly addresses: readonly WalletAddress[];
  /** Named, never silently dropped. Truncated for display, so it stays renderable. */
  readonly rejected: readonly RejectedInput[];
  /** How many repeats were removed, so "3 wallets" never means one wallet thrice. */
  readonly duplicateCount: number;
  /** Valid addresses beyond {@link BUNDLE_MAX_MEMBERS}. Stated when it bites. */
  readonly omittedCount: number;
};

/** How much of a rejected input is echoed back. Enough to recognise, not to break a layout. */
const REJECTED_INPUT_DISPLAY_LENGTH = 24;

export function parseBundleRequest(raw: string): BundleRequest {
  const rejected: RejectedInput[] = [];

  // Bounded first, and by length before by count: a single 2 MB segment is as much
  // of a problem as two thousand small ones.
  const bounded = raw.slice(0, BUNDLE_MAX_RAW_LENGTH);
  const allSegments = bounded
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const segments = allSegments.slice(0, BUNDLE_MAX_SEGMENTS);
  if (allSegments.length > BUNDLE_MAX_SEGMENTS) {
    rejected.push({
      input: `${allSegments.length - BUNDLE_MAX_SEGMENTS} more`,
      reason: 'too-many-segments',
    });
  }

  const accepted: WalletAddress[] = [];
  const seen = new Set<string>();
  let duplicateCount = 0;

  for (const segment of segments) {
    const address = parseWalletAddress(segment);
    if (!address.ok) {
      rejected.push({
        input: truncate(segment),
        // A name is worth its own message: it is a reasonable thing to have tried,
        // and the answer is "use the single-wallet route", not "that is nonsense".
        reason: parseEnsName(segment).ok ? 'ens-name' : 'not-an-address',
      });
      continue;
    }

    const key = address.address.toLowerCase();
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    accepted.push(address.address);
  }

  // Capped last, so the cap applies to real wallets rather than to whatever
  // happened to appear first in the URL.
  return {
    addresses: accepted.slice(0, BUNDLE_MAX_MEMBERS),
    rejected,
    duplicateCount,
    omittedCount: Math.max(0, accepted.length - BUNDLE_MAX_MEMBERS),
  };
}

/**
 * Whether the request is worth rendering as a bundle at all.
 *
 * One accepted address still renders **if there is anything to report** — a rejected
 * input, a duplicate, an omission. Redirecting to the single-wallet view in that case
 * would erase the notice, and the page cannot say what it dropped once it is no
 * longer the page.
 */
export function shouldRenderBundle(request: BundleRequest): boolean {
  if (request.addresses.length >= 2) {
    return true;
  }
  return (
    request.addresses.length === 1 &&
    (request.rejected.length > 0 || request.duplicateCount > 0 || request.omittedCount > 0)
  );
}

/** The canonical path for a set of addresses. */
export function bundlePath(addresses: readonly WalletAddress[]): string {
  return `/bundle/${addresses.join(',')}`;
}

function truncate(value: string): string {
  return value.length <= REJECTED_INPUT_DISPLAY_LENGTH
    ? value
    : `${value.slice(0, REJECTED_INPUT_DISPLAY_LENGTH)}…`;
}
