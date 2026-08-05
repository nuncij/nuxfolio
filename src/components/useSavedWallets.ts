'use client';

import { useCallback, useSyncExternalStore } from 'react';

import {
  clearWallets,
  readSavedWallets,
  removeWallet,
  saveWallet,
  STORAGE_KEY,
  type ReadResult,
  type WriteResult,
} from '@/lib/savedWallets';

/**
 * The saved-wallet list, as a React store.
 *
 * Follows `ThemeToggle` and `CurrencyToggle` in using `useSyncExternalStore` with a
 * server snapshot — the server cannot read `localStorage`, so the empty list is what
 * it renders and React re-reads after hydrating. Reading in an effect would be a
 * synchronous state update during mount, the pattern that has already hidden two
 * real bugs here (ADR-010, ADR-016).
 *
 * **But it cannot copy those two literally, and this is the whole reason this file
 * exists.** They return a *string*. `getSnapshot` is called on every render, and
 * React compares results by identity: a string compares equal, so re-reading storage
 * each time is harmless. A list is an object, and a freshly parsed array is a new
 * reference every call — which React sees as "changed again", re-renders, reads
 * again, forever.
 *
 * So the snapshot is memoised against the **raw stored string**. Same string, same
 * object; the parse happens only when the underlying text actually differs. Review
 * of the plan caught this before it was written; it would have been an immediate
 * render loop.
 */

/** Frozen, so the server snapshot is one stable reference for every render. */
const EMPTY: ReadResult = Object.freeze({
  status: 'empty',
  wallets: Object.freeze([]) as readonly [],
});

/** The memo: the raw text a snapshot was parsed from, and the snapshot itself. */
let cachedRaw: string | null | undefined;
let cachedResult: ReadResult = EMPTY;

const listeners = new Set<() => void>();

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // Access itself can throw when storage is blocked by policy.
    return null;
  }
}

/**
 * Exported so the memoisation can be tested directly.
 *
 * The property that matters — same stored text, same object reference — is what
 * keeps `useSyncExternalStore` from looping, and it is not observable through the
 * hook without a DOM test environment this project deliberately does not have.
 */
export function readSnapshot(): ReadResult {
  const storage = localStorageOrNull();
  if (storage === null) {
    // Recomputed rather than cached: `unavailable` is cheap and the reason for it
    // can change (a permission granted mid-session).
    return readSavedWallets(null);
  }

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return readSavedWallets(null);
  }

  if (raw === cachedRaw) {
    return cachedResult;
  }
  cachedRaw = raw;
  cachedResult = readSavedWallets(storage);
  return cachedResult;
}

function readServerSnapshot(): ReadResult {
  return EMPTY;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  // `storage` fires in *other* tabs, which is exactly the cross-tab case: save in
  // one tab and every other tab's list follows.
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** Invalidates the memo and tells React, after this tab changed the list itself. */
function notifyChanged(): void {
  cachedRaw = undefined;
  for (const listener of listeners) {
    listener();
  }
}

export type SavedWalletsStore = {
  /** The full read result, so the UI can distinguish empty from unreadable. */
  readonly state: ReadResult;
  readonly save: (input: {
    address: string;
    label?: string | null;
    ensName?: string | null;
  }) => WriteResult;
  readonly remove: (address: string) => WriteResult;
  readonly clear: () => WriteResult;
};

export function useSavedWallets(): SavedWalletsStore {
  const state = useSyncExternalStore(subscribe, readSnapshot, readServerSnapshot);

  const save = useCallback((input: Parameters<SavedWalletsStore['save']>[0]): WriteResult => {
    const result = saveWallet(localStorageOrNull(), input);
    notifyChanged();
    return result;
  }, []);

  const remove = useCallback((address: string): WriteResult => {
    const result = removeWallet(localStorageOrNull(), address);
    notifyChanged();
    return result;
  }, []);

  const clear = useCallback((): WriteResult => {
    const result = clearWallets(localStorageOrNull());
    notifyChanged();
    return result;
  }, []);

  return { state, save, remove, clear };
}

/** Visible for tests: drops the memo between cases. */
export function resetSavedWalletsCache(): void {
  cachedRaw = undefined;
  cachedResult = EMPTY;
}
