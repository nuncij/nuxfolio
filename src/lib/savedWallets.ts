import { z } from 'zod';

import { parseWalletAddress, type WalletAddress } from '@/domain/address';
import { parseEnsName } from '@/domain/ensName';

/**
 * Wallets the user has saved, in this browser.
 *
 * The whole feature is a list of addresses and a click to open each, which sounds
 * like it needs no design. Most of this file is the two places that judgement is
 * actually required.
 *
 * **A read has five outcomes, not two.** The existing `parseThemeMode` and
 * `parseCurrency` fall back to a default on anything unrecognised, which is right
 * for a colour and wrong here. "You have no saved wallets" is a *claim*, and making
 * it because the store is corrupt or unreadable would be false — and would then let
 * the next save overwrite data this build never understood. Losing a wallet list is
 * not losing a theme.
 *
 * **Stored data is hostile input.** It holds whatever a previous version of this
 * app, another tab, or the user's own devtools put there. Every field is revalidated
 * and every bound is enforced on the way in; a bad entry is dropped rather than
 * repaired, and its siblings still render.
 */

export const STORAGE_KEY = 'nuxfolio.savedWallets';

/** Current schema version. Stored data outlives code, so this ships from day one. */
export const CURRENT_VERSION = 1;

/** More than anyone watches by hand, and low enough to keep the panel usable. */
export const MAX_WALLETS = 50;

/** Long enough for "Cold storage (Ledger)", short enough not to wrap a row. */
export const MAX_LABEL_LENGTH = 40;

/**
 * Ceiling on the raw stored string.
 *
 * `MAX_WALLETS` bounds the number of entries but not their size, and one enormous
 * field is enough to stall parsing and layout. 32 kB is roughly ten times what a
 * full list needs.
 */
export const MAX_RAW_BYTES = 32_768;

export type SavedWallet = {
  readonly address: WalletAddress;
  readonly label: string | null;
  /**
   * The ENS name it was entered as — a display hint, never an identity. The
   * address stays canonical: a name can stop resolving or come to point somewhere
   * else, and a saved wallet must not silently follow it.
   */
  readonly ensName: string | null;
  readonly savedAt: string;
};

/**
 * What a read established.
 *
 * `empty` is the only outcome that entitles the UI to say "nothing saved".
 * `unsupportedVersion` deliberately carries no wallets *and* forbids writing, so a
 * newer build's data is never clobbered by an older one.
 */
export type ReadResult =
  | { readonly status: 'ok'; readonly wallets: readonly SavedWallet[] }
  | { readonly status: 'empty'; readonly wallets: readonly [] }
  | {
      readonly status: 'partiallyInvalid';
      readonly wallets: readonly SavedWallet[];
      readonly droppedCount: number;
    }
  | {
      readonly status: 'unsupportedVersion';
      readonly wallets: readonly [];
      readonly version: number;
    }
  | { readonly status: 'corrupt'; readonly wallets: readonly [] }
  | { readonly status: 'unavailable'; readonly wallets: readonly [] };

/** Whether a read left the store safe to write back to. */
export function canWrite(result: ReadResult): boolean {
  return result.status !== 'unsupportedVersion' && result.status !== 'unavailable';
}

export type WriteResult =
  | { readonly ok: true; readonly wallets: readonly SavedWallet[] }
  | {
      readonly ok: false;
      readonly reason: 'full' | 'unsupportedVersion' | 'unavailable' | 'invalidAddress';
    };

/**
 * Unicode characters that can make a label rewrite what appears next to it.
 *
 * Written as escapes, never as the characters themselves. A source file containing
 * literal bidi overrides is the "Trojan Source" hazard — code that reads one way and
 * compiles another — and it would be absurd for the defence against invisible
 * characters to smuggle them into the repository.
 *
 * React escaping stops a label executing as HTML. It does nothing about a
 * right-to-left override, which can visually reverse the address in the same row —
 * so a label could make one wallet look like another. Stripped rather than
 * rejected: the intent is usually innocent and the display is what matters.
 *
 * Covers the bidi overrides and isolates (U+202A–U+202E, U+2066–U+2069) plus the
 * zero-width and BOM characters that hide differences between labels.
 */
const UNSAFE_LABEL_CHARS = /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/gu;

/** ASCII and Unicode control characters, which have no business in a label. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/gu;

const storedWalletSchema = z.object({
  address: z.string().max(64),
  label: z.string().max(512).nullable().optional(),
  ensName: z.string().max(512).nullable().optional(),
  savedAt: z.string().max(64),
});

const storedListSchema = z.object({
  version: z.number().int(),
  wallets: z.array(z.unknown()),
});

/**
 * Reads and validates the list.
 *
 * `now` is injected so the future-timestamp rule is testable without a clock.
 */
export function readSavedWallets(
  storage: Pick<Storage, 'getItem'> | null,
  now: number = Date.now(),
): ReadResult {
  if (storage === null) {
    return { status: 'unavailable', wallets: [] };
  }

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    // Storage can throw rather than return null — disabled cookies, some private
    // modes, a sandboxed iframe. That is "cannot tell", not "nothing saved".
    return { status: 'unavailable', wallets: [] };
  }

  if (raw === null || raw.length === 0) {
    return { status: 'empty', wallets: [] };
  }
  if (raw.length > MAX_RAW_BYTES) {
    return { status: 'corrupt', wallets: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'corrupt', wallets: [] };
  }

  const envelope = storedListSchema.safeParse(parsed);
  if (!envelope.success) {
    return { status: 'corrupt', wallets: [] };
  }
  if (envelope.data.version > CURRENT_VERSION) {
    // Written by a newer build. Its shape is unknown, so it is neither read nor
    // overwritten — the alternative is silently discarding someone's list.
    return { status: 'unsupportedVersion', wallets: [], version: envelope.data.version };
  }
  if (envelope.data.version < CURRENT_VERSION) {
    // No older version has ever shipped, so there is nothing to migrate from. A
    // future migration branches here rather than treating old data as corrupt.
    return { status: 'corrupt', wallets: [] };
  }

  const { wallets, droppedCount } = normalizeWallets(envelope.data.wallets, now);

  if (droppedCount > 0) {
    return { status: 'partiallyInvalid', wallets, droppedCount };
  }
  return { status: 'ok', wallets };
}

/**
 * Validates, de-duplicates, bounds and orders the entries.
 *
 * Exported for tests: this is where every hostile-input rule lives, and testing it
 * directly beats reaching it through a storage stub each time.
 */
export function normalizeWallets(
  entries: readonly unknown[],
  now: number = Date.now(),
): { wallets: readonly SavedWallet[]; droppedCount: number } {
  const byAddress = new Map<string, SavedWallet>();
  let droppedCount = 0;

  for (const entry of entries) {
    const wallet = toSavedWallet(entry, now);
    if (wallet === null) {
      droppedCount += 1;
      continue;
    }

    // Case-insensitively the same wallet. The earliest save wins, so re-saving
    // an address does not reset when it was first kept.
    const key = wallet.address.toLowerCase();
    const existing = byAddress.get(key);
    if (existing === undefined || wallet.savedAt < existing.savedAt) {
      byAddress.set(key, wallet);
    }
  }

  const ordered = sortWallets([...byAddress.values()]);

  if (ordered.length > MAX_WALLETS) {
    // Over the cap is a corrupted or hand-edited store; keep the newest and count
    // the rest as dropped rather than rendering an unusable page.
    return {
      wallets: ordered.slice(0, MAX_WALLETS),
      droppedCount: droppedCount + (ordered.length - MAX_WALLETS),
    };
  }
  return { wallets: ordered, droppedCount };
}

function toSavedWallet(entry: unknown, now: number): SavedWallet | null {
  const shape = storedWalletSchema.safeParse(entry);
  if (!shape.success) {
    return null;
  }

  // A stored string is not an address until checked.
  const address = parseWalletAddress(shape.data.address);
  if (!address.ok) {
    return null;
  }

  const savedAtMs = Date.parse(shape.data.savedAt);
  if (Number.isNaN(savedAtMs)) {
    return null;
  }
  // A timestamp in the future is either a clock problem or an edit. Either way it
  // would sort above everything real, so the entry is not trusted.
  if (savedAtMs > now + FUTURE_TOLERANCE_MS) {
    return null;
  }

  return {
    address: address.address,
    label: cleanLabel(shape.data.label ?? null),
    ensName: cleanEnsName(shape.data.ensName ?? null),
    savedAt: new Date(savedAtMs).toISOString(),
  };
}

/** A minute of slack, so a marginally fast clock does not drop a fresh save. */
const FUTURE_TOLERANCE_MS = 60_000;

/**
 * Cleans a label, or returns null if nothing usable is left.
 *
 * Exported because the save path applies the same rules to fresh input: what is
 * accepted on the way in and what survives a reload must be the same thing.
 */
export function cleanLabel(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const cleaned = value
    .replace(CONTROL_CHARS, '')
    .replace(UNSAFE_LABEL_CHARS, '')
    .trim()
    .slice(0, MAX_LABEL_LENGTH)
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cleanEnsName(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const parsed = parseEnsName(value);
  // An unusable name is dropped rather than dropping the wallet: the address is
  // the identity, and the name is only a hint.
  return parsed.ok ? parsed.name : null;
}

/**
 * Newest first, address as the tie-breaker.
 *
 * Ordering by value was considered and rejected. Beyond the fact that no value is
 * stored, ranking rows by a figure the UI does not display would leak relative
 * values and reshuffle the list for reasons the reader cannot see.
 */
export function sortWallets(wallets: readonly SavedWallet[]): SavedWallet[] {
  return [...wallets].sort((a, b) => {
    if (a.savedAt !== b.savedAt) {
      return a.savedAt < b.savedAt ? 1 : -1;
    }
    // Total and stable, so two saves in the same millisecond keep a fixed order.
    return a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1;
  });
}

/**
 * Adds or updates one wallet.
 *
 * Re-reads immediately before writing. `localStorage` has no transaction, so
 * another tab may have changed the list since this one rendered; without the
 * re-read, saving here would silently discard that change.
 */
export function saveWallet(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  input: { address: string; label?: string | null; ensName?: string | null },
  now: number = Date.now(),
): WriteResult {
  // Validated and canonicalised here, not merely typed. `WalletAddress` is
  // `0x${string}`, which the compiler cannot check a checksum against — and an
  // entry written with a bad checksum would be silently dropped by the next read,
  // so the save would appear to work and then lose the wallet. Storing the
  // canonical form also keeps every later comparison consistent.
  const parsed = parseWalletAddress(input.address);
  if (!parsed.ok) {
    return { ok: false, reason: 'invalidAddress' };
  }
  const address = parsed.address;

  return mutate(storage, now, (wallets) => {
    const key = address.toLowerCase();
    const existing = wallets.find((wallet) => wallet.address.toLowerCase() === key);

    if (existing === undefined && wallets.length >= MAX_WALLETS) {
      return { refuse: 'full' as const };
    }

    const updated: SavedWallet = {
      address,
      label: cleanLabel(input.label ?? existing?.label ?? null),
      ensName: cleanEnsName(input.ensName ?? existing?.ensName ?? null),
      // Re-saving keeps the original date: it is when the wallet was first kept,
      // not when it was last touched.
      savedAt: existing?.savedAt ?? new Date(now).toISOString(),
    };

    return {
      next: [...wallets.filter((wallet) => wallet.address.toLowerCase() !== key), updated],
    };
  });
}

export function removeWallet(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  address: string,
  now: number = Date.now(),
): WriteResult {
  const key = address.toLowerCase();
  return mutate(storage, now, (wallets) => ({
    next: wallets.filter((wallet) => wallet.address.toLowerCase() !== key),
  }));
}

export function clearWallets(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  now: number = Date.now(),
): WriteResult {
  return mutate(storage, now, () => ({ next: [] }));
}

function mutate(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  now: number,
  change: (
    wallets: readonly SavedWallet[],
  ) => { next: readonly SavedWallet[] } | { refuse: 'full' },
): WriteResult {
  if (storage === null) {
    return { ok: false, reason: 'unavailable' };
  }

  const current = readSavedWallets(storage, now);
  if (!canWrite(current)) {
    return {
      ok: false,
      reason: current.status === 'unsupportedVersion' ? 'unsupportedVersion' : 'unavailable',
    };
  }

  const outcome = change(current.wallets);
  if ('refuse' in outcome) {
    return { ok: false, reason: outcome.refuse };
  }

  const wallets = sortWallets(outcome.next);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: CURRENT_VERSION, wallets }));
  } catch {
    // Quota exceeded, or a store that refuses writes. Reported rather than
    // appearing to succeed — a save the user believes happened is worse than one
    // they know failed.
    return { ok: false, reason: 'unavailable' };
  }
  return { ok: true, wallets };
}

/** Whether an address is on the list. Drives the save control's state. */
export function isSaved(wallets: readonly SavedWallet[], address: string): boolean {
  const key = address.toLowerCase();
  return wallets.some((wallet) => wallet.address.toLowerCase() === key);
}
