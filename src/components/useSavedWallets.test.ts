import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CURRENT_VERSION, STORAGE_KEY } from '@/lib/savedWallets';

import { readSnapshot, resetSavedWalletsCache } from './useSavedWallets';

/**
 * The one property this file exists to protect.
 *
 * `useSyncExternalStore` calls `getSnapshot` on every render and compares the
 * result by identity. `ThemeToggle` and `CurrencyToggle` return a string, so
 * re-reading storage each time is free. A list is an object: a freshly parsed array
 * is a new reference every call, React reads "changed", re-renders, reads again —
 * an endless loop rather than a wrong value, which is why a type checker and a
 * component test would both miss it.
 */

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

function install(value: string | null, options: { throwOnRead?: boolean } = {}): void {
  let stored = value;
  const storage = {
    getItem: (key: string): string | null => {
      if (options.throwOnRead === true) {
        throw new DOMException('denied', 'SecurityError');
      }
      return key === STORAGE_KEY ? stored : null;
    },
    setItem: (_key: string, next: string): void => {
      stored = next;
    },
  };
  // The suite runs in the node environment, so `window` is ours to define.
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: storage },
    configurable: true,
    writable: true,
  });
}

function payload(addresses: readonly string[]): string {
  return JSON.stringify({
    version: CURRENT_VERSION,
    wallets: addresses.map((address) => ({
      address,
      label: null,
      ensName: null,
      savedAt: '2026-08-01T10:00:00.000Z',
    })),
  });
}

beforeEach(() => {
  resetSavedWalletsCache();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('readSnapshot', () => {
  it('returns the identical object when the stored text has not changed', () => {
    // The loop guard. Two reads with nothing changed in between must be `===`.
    install(payload([VITALIK]));

    const first = readSnapshot();
    const second = readSnapshot();

    expect(second).toBe(first);
    expect(second.wallets).toBe(first.wallets);
  });

  it('stays identical across many reads, as a render would do', () => {
    install(payload([VITALIK]));
    const first = readSnapshot();
    for (let index = 0; index < 20; index += 1) {
      expect(readSnapshot()).toBe(first);
    }
  });

  it('returns a different object once the stored text changes', () => {
    // The other half: memoising must not make a real change invisible.
    install(payload([VITALIK]));
    const before = readSnapshot();

    install(payload([]));
    const after = readSnapshot();

    expect(after).not.toBe(before);
    expect(after.wallets).toHaveLength(0);
  });

  it('is identical for an absent key too, so an empty list does not loop either', () => {
    install(null);
    expect(readSnapshot()).toBe(readSnapshot());
  });

  it('reports unavailable when storage throws, rather than an empty list', () => {
    install(null, { throwOnRead: true });
    expect(readSnapshot().status).toBe('unavailable');
  });

  it('reports unavailable when there is no window at all', () => {
    // Server-side, or a locked-down embed.
    Reflect.deleteProperty(globalThis, 'window');
    expect(readSnapshot().status).toBe('unavailable');
  });

  it('carries the read outcome through, not just the wallets', () => {
    // The panel needs to tell "nothing saved" from "cannot read your list".
    install('not json');
    expect(readSnapshot().status).toBe('corrupt');
  });
});
