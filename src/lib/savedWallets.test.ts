import { describe, expect, it } from 'vitest';

import {
  canWrite,
  cleanLabel,
  clearWallets,
  CURRENT_VERSION,
  isSaved,
  MAX_LABEL_LENGTH,
  MAX_RAW_BYTES,
  MAX_WALLETS,
  normalizeWallets,
  readSavedWallets,
  removeWallet,
  saveWallet,
  sortWallets,
  STORAGE_KEY,
  type SavedWallet,
} from './savedWallets';
import type { WalletAddress } from '@/domain/address';

/** Real checksummed addresses, so `parseWalletAddress` accepts them. */
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' as WalletAddress;
const OTHER_WALLET = '0x3333333333333333333333333333333333333333' as WalletAddress;
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as WalletAddress;

const NOW = Date.parse('2026-08-03T12:00:00.000Z');

/** An in-memory `Storage` good enough for these tests, with optional failures. */
function fakeStorage(
  initial: string | null = null,
  failures: { read?: boolean; write?: boolean } = {},
) {
  let value = initial;
  return {
    getItem: (): string | null => {
      if (failures.read === true) {
        throw new DOMException('denied', 'SecurityError');
      }
      return value;
    },
    setItem: (_key: string, next: string): void => {
      if (failures.write === true) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      value = next;
    },
    read: () => value,
  };
}

function stored(wallets: readonly unknown[], version: number = CURRENT_VERSION): string {
  return JSON.stringify({ version, wallets });
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    address: VITALIK,
    label: 'Main',
    ensName: null,
    savedAt: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('readSavedWallets — the five outcomes', () => {
  it('reports an absent key as empty, which is the only case that may say "none saved"', () => {
    const result = readSavedWallets(fakeStorage(null), NOW);
    expect(result.status).toBe('empty');
    expect(result.wallets).toEqual([]);
  });

  it('reports a clean list as ok', () => {
    const result = readSavedWallets(fakeStorage(stored([entry()])), NOW);
    expect(result.status).toBe('ok');
    expect(result.wallets).toHaveLength(1);
  });

  it('reports a corrupt store as corrupt, never as empty', () => {
    // The distinction the whole five-outcome design exists for: "I cannot read your
    // list" is not "you have no list", and treating it as empty would also let the
    // next save overwrite whatever is really there.
    for (const raw of ['not json at all', '{', '[]', '{"version":1}', 'null']) {
      const result = readSavedWallets(fakeStorage(raw), NOW);
      expect(result.status, `raw: ${raw}`).toBe('corrupt');
      expect(result.status, `raw: ${raw}`).not.toBe('empty');
    }
  });

  it('reports storage that throws as unavailable rather than empty', () => {
    // Disabled storage, a sandboxed frame, some private modes: getItem throws
    // instead of returning null. That is "cannot tell", not "nothing there".
    const result = readSavedWallets(fakeStorage(null, { read: true }), NOW);
    expect(result.status).toBe('unavailable');
  });

  it('reports a null storage object as unavailable', () => {
    expect(readSavedWallets(null, NOW).status).toBe('unavailable');
  });

  it('reports a newer version as unsupported, and refuses to write over it', () => {
    const result = readSavedWallets(fakeStorage(stored([entry()], 99)), NOW);
    expect(result.status).toBe('unsupportedVersion');
    expect(result.wallets).toEqual([]);
    // The important half: a newer build's data must not be clobbered by this one.
    expect(canWrite(result)).toBe(false);
  });

  it('reports a list with a bad entry as partially invalid, and keeps the good ones', () => {
    const result = readSavedWallets(
      fakeStorage(stored([entry(), entry({ address: 'not-an-address' }), { nonsense: true }])),
      NOW,
    );
    expect(result.status).toBe('partiallyInvalid');
    expect(result.wallets).toHaveLength(1);
    expect(result.status === 'partiallyInvalid' && result.droppedCount).toBe(2);
  });

  it('rejects a payload larger than the cap without parsing it', () => {
    // One enormous field is enough to stall parsing and layout, and MAX_WALLETS
    // bounds the count but not the size.
    const huge = stored([entry({ label: 'x'.repeat(MAX_RAW_BYTES) })]);
    expect(huge.length).toBeGreaterThan(MAX_RAW_BYTES);
    expect(readSavedWallets(fakeStorage(huge), NOW).status).toBe('corrupt');
  });

  it('allows writing after every outcome except unsupported version and unavailable', () => {
    expect(canWrite({ status: 'ok', wallets: [] })).toBe(true);
    expect(canWrite({ status: 'empty', wallets: [] })).toBe(true);
    expect(canWrite({ status: 'corrupt', wallets: [] })).toBe(true);
    expect(canWrite({ status: 'unavailable', wallets: [] })).toBe(false);
  });
});

describe('normalizeWallets — hostile input', () => {
  it('drops an entry whose address is not one, keeping its siblings', () => {
    const { wallets, droppedCount } = normalizeWallets(
      [entry(), entry({ address: '0xnope' })],
      NOW,
    );
    expect(wallets).toHaveLength(1);
    expect(droppedCount).toBe(1);
  });

  it('drops an entry with an unreadable date rather than guessing one', () => {
    expect(normalizeWallets([entry({ savedAt: 'last Tuesday' })], NOW).droppedCount).toBe(1);
  });

  it('drops an entry dated in the future, which would sort above everything real', () => {
    const future = new Date(NOW + 86_400_000).toISOString();
    expect(normalizeWallets([entry({ savedAt: future })], NOW).droppedCount).toBe(1);
  });

  it('tolerates a marginally fast clock', () => {
    // A save made a few seconds "ahead" must not be thrown away.
    const slightlyAhead = new Date(NOW + 5_000).toISOString();
    expect(normalizeWallets([entry({ savedAt: slightlyAhead })], NOW).wallets).toHaveLength(1);
  });

  it('treats the same address in different casing as one wallet', () => {
    const { wallets } = normalizeWallets(
      [
        entry({ address: VITALIK, savedAt: '2026-08-02T10:00:00.000Z' }),
        entry({ address: VITALIK.toLowerCase(), savedAt: '2026-08-01T10:00:00.000Z' }),
      ],
      NOW,
    );
    expect(wallets).toHaveLength(1);
    // The earliest save wins, so re-saving does not reset when it was first kept.
    expect(wallets[0]?.savedAt).toBe('2026-08-01T10:00:00.000Z');
  });

  it('keeps the newest when the stored list is over the cap, and counts the rest', () => {
    const many = Array.from({ length: MAX_WALLETS + 5 }, (_, index) =>
      entry({
        // Distinct valid addresses.
        address: `0x${index.toString(16).padStart(40, '0')}`,
        savedAt: new Date(NOW - index * 1000).toISOString(),
      }),
    );
    const { wallets, droppedCount } = normalizeWallets(many, NOW);
    expect(wallets).toHaveLength(MAX_WALLETS);
    expect(droppedCount).toBe(5);
  });

  it('drops an unusable ENS name without dropping the wallet', () => {
    // The address is the identity; the name is only a hint.
    const { wallets, droppedCount } = normalizeWallets(
      [entry({ ensName: 'not a valid name at all!!' })],
      NOW,
    );
    expect(droppedCount).toBe(0);
    expect(wallets[0]?.ensName).toBeNull();
    expect(wallets[0]?.address).toBe(VITALIK);
  });

  it('keeps a valid ENS name, lowercased', () => {
    expect(normalizeWallets([entry({ ensName: 'VITALIK.eth' })], NOW).wallets[0]?.ensName).toBe(
      'vitalik.eth',
    );
  });
});

describe('cleanLabel', () => {
  it('trims and caps', () => {
    expect(cleanLabel('  Main  ')).toBe('Main');
    expect(cleanLabel('x'.repeat(MAX_LABEL_LENGTH + 20))?.length).toBe(MAX_LABEL_LENGTH);
  });

  it('strips a right-to-left override, which could fake the address beside it', () => {
    // React stops a label executing as HTML. It does nothing about U+202E, which
    // reverses the text that follows — enough to make one wallet look like another.
    const spoof = `Main\u202e`;
    expect(cleanLabel(spoof)).toBe('Main');
    expect(cleanLabel(spoof)).not.toContain('\u202e');
  });

  it('strips every bidi control and zero-width character', () => {
    for (const char of [
      '\u202a',
      '\u202b',
      '\u202c',
      '\u202d',
      '\u2066',
      '\u2069',
      '\u200b',
      '\ufeff',
    ]) {
      expect(cleanLabel(`A${char}B`), `char: ${char.codePointAt(0)?.toString(16)}`).toBe('AB');
    }
  });

  it('strips control characters', () => {
    expect(cleanLabel('Main\u0000\u0007\nwallet')).toBe('Mainwallet');
  });

  it('returns null when nothing usable is left', () => {
    expect(cleanLabel('   ')).toBeNull();
    expect(cleanLabel('\u202e\u200b')).toBeNull();
    expect(cleanLabel(null)).toBeNull();
  });
});

describe('sortWallets', () => {
  function wallet(address: WalletAddress, savedAt: string): SavedWallet {
    return { address, label: null, ensName: null, savedAt };
  }

  it('puts the newest save first', () => {
    const sorted = sortWallets([
      wallet(VITALIK, '2026-08-01T00:00:00.000Z'),
      wallet(OTHER_WALLET, '2026-08-02T00:00:00.000Z'),
    ]);
    expect(sorted[0]?.address).toBe(OTHER_WALLET);
  });

  it('breaks a tie by address, so the order is total and stable', () => {
    const same = '2026-08-01T00:00:00.000Z';
    const one = sortWallets([wallet(VITALIK, same), wallet(OTHER_WALLET, same)]);
    const other = sortWallets([wallet(OTHER_WALLET, same), wallet(VITALIK, same)]);
    expect(one.map((w) => w.address)).toEqual(other.map((w) => w.address));
  });
});

describe('saveWallet', () => {
  it('adds a wallet and reads back', () => {
    const storage = fakeStorage();
    const result = saveWallet(storage, { address: VITALIK, label: 'Main' }, NOW);

    expect(result.ok).toBe(true);
    expect(readSavedWallets(storage, NOW).wallets).toEqual([
      { address: VITALIK, label: 'Main', ensName: null, savedAt: new Date(NOW).toISOString() },
    ]);
  });

  it('is idempotent, and keeps the original save date', () => {
    const storage = fakeStorage();
    saveWallet(storage, { address: VITALIK }, NOW);
    const later = saveWallet(storage, { address: VITALIK }, NOW + 86_400_000);

    expect(later.ok && later.wallets).toHaveLength(1);
    // The date is when it was first kept, not when it was last touched.
    expect(later.ok && later.wallets[0]?.savedAt).toBe(new Date(NOW).toISOString());
  });

  it('treats a differently-cased address as the same wallet', () => {
    const storage = fakeStorage();
    saveWallet(storage, { address: VITALIK }, NOW);
    saveWallet(storage, { address: VITALIK.toLowerCase() as WalletAddress }, NOW);
    expect(readSavedWallets(storage, NOW).wallets).toHaveLength(1);
  });

  it('updates a label without disturbing the save date', () => {
    const storage = fakeStorage();
    saveWallet(storage, { address: VITALIK, label: 'Main' }, NOW);
    const renamed = saveWallet(storage, { address: VITALIK, label: 'Cold storage' }, NOW + 5000);

    expect(renamed.ok && renamed.wallets[0]?.label).toBe('Cold storage');
    expect(renamed.ok && renamed.wallets[0]?.savedAt).toBe(new Date(NOW).toISOString());
  });

  it('applies the same label rules to fresh input as to stored input', () => {
    // What is accepted on the way in and what survives a reload must match.
    const storage = fakeStorage();
    saveWallet(storage, { address: VITALIK, label: `Main\u202e${'x'.repeat(80)}` }, NOW);
    const label = readSavedWallets(storage, NOW).wallets[0]?.label;
    expect(label).not.toContain('\u202e');
    expect(label?.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
  });

  it('refuses a new wallet at the cap rather than silently dropping one', () => {
    const full = Array.from({ length: MAX_WALLETS }, (_, index) => ({
      address: `0x${index.toString(16).padStart(40, '0')}`,
      label: null,
      ensName: null,
      savedAt: new Date(NOW - index * 1000).toISOString(),
    }));
    const storage = fakeStorage(stored(full));

    const result = saveWallet(storage, { address: USDC }, NOW);
    expect(result).toEqual({ ok: false, reason: 'full' });
    expect(readSavedWallets(storage, NOW).wallets).toHaveLength(MAX_WALLETS);
  });

  it('still updates an existing wallet at the cap', () => {
    // The cap bounds how many wallets exist, not whether one can be renamed.
    const full = Array.from({ length: MAX_WALLETS }, (_, index) => ({
      address: `0x${index.toString(16).padStart(40, '0')}`,
      label: null,
      ensName: null,
      savedAt: new Date(NOW - index * 1000).toISOString(),
    }));
    const storage = fakeStorage(stored(full));
    const existing = full[0]?.address as WalletAddress;

    expect(saveWallet(storage, { address: existing, label: 'Renamed' }, NOW).ok).toBe(true);
  });

  it('reports a write that throws rather than appearing to succeed', () => {
    // A save the user believes happened is worse than one they know failed.
    const storage = fakeStorage(null, { write: true });
    expect(saveWallet(storage, { address: VITALIK }, NOW)).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('refuses to write when the store holds a newer version', () => {
    const storage = fakeStorage(stored([entry()], 99));
    expect(saveWallet(storage, { address: OTHER_WALLET }, NOW)).toEqual({
      ok: false,
      reason: 'unsupportedVersion',
    });
    // Untouched.
    expect(JSON.parse(storage.read() as string).version).toBe(99);
  });

  it('re-reads before writing, so another tab’s change is not clobbered', () => {
    // localStorage has no transaction. This tab read an empty list; another tab
    // saved a wallet in the meantime; this tab must not erase it.
    const storage = fakeStorage();
    const stale = readSavedWallets(storage, NOW);
    expect(stale.wallets).toHaveLength(0);

    saveWallet(storage, { address: OTHER_WALLET }, NOW); // the "other tab"
    const result = saveWallet(storage, { address: VITALIK }, NOW); // this tab

    expect(result.ok && result.wallets).toHaveLength(2);
  });
});

describe('removeWallet and clearWallets', () => {
  it('removes one and leaves the rest', () => {
    const storage = fakeStorage();
    saveWallet(storage, { address: VITALIK }, NOW);
    saveWallet(storage, { address: OTHER_WALLET }, NOW);

    const result = removeWallet(storage, VITALIK, NOW);
    expect(result.ok && result.wallets.map((w) => w.address)).toEqual([OTHER_WALLET]);
  });

  it('removes regardless of the casing passed in', () => {
    const storage = fakeStorage();
    saveWallet(storage, { address: VITALIK }, NOW);
    expect(removeWallet(storage, VITALIK.toLowerCase(), NOW).ok).toBe(true);
    expect(readSavedWallets(storage, NOW).wallets).toHaveLength(0);
  });

  it('clears everything in one action', () => {
    const storage = fakeStorage();
    saveWallet(storage, { address: VITALIK }, NOW);
    saveWallet(storage, { address: OTHER_WALLET }, NOW);

    expect(clearWallets(storage, NOW).ok).toBe(true);
    expect(readSavedWallets(storage, NOW).wallets).toHaveLength(0);
  });

  it('removing a wallet that is not there is not an error', () => {
    const storage = fakeStorage();
    saveWallet(storage, { address: VITALIK }, NOW);
    expect(removeWallet(storage, USDC, NOW).ok).toBe(true);
  });
});

describe('saveWallet — address validation', () => {
  it('refuses an address whose checksum does not match', () => {
    // Not merely a type concern: `WalletAddress` is `0x${string}`, so the compiler
    // cannot check a checksum. An entry written with a bad one would be dropped by
    // the very next read, making the save appear to work and then lose the wallet.
    const storage = fakeStorage();
    const badChecksum = '0xfC8Bf1127AbA05e37862ea211ca23B328909c509';

    expect(saveWallet(storage, { address: badChecksum }, NOW)).toEqual({
      ok: false,
      reason: 'invalidAddress',
    });
    expect(storage.read()).toBeNull();
  });

  it('canonicalises an all-lowercase address on the way in', () => {
    const storage = fakeStorage();
    saveWallet(storage, { address: OTHER_WALLET.toLowerCase() }, NOW);

    // Stored checksummed, so it reads back rather than being dropped, and every
    // later comparison sees one form.
    expect(readSavedWallets(storage, NOW).wallets[0]?.address).toBe(OTHER_WALLET);
  });

  it('anything it writes reads back — the property the checksum guard exists for', () => {
    const storage = fakeStorage();
    for (const address of [VITALIK, OTHER_WALLET.toLowerCase(), USDC]) {
      expect(saveWallet(storage, { address }, NOW).ok, address).toBe(true);
    }
    const read = readSavedWallets(storage, NOW);
    expect(read.status).toBe('ok');
    expect(read.wallets).toHaveLength(3);
  });
});

describe('isSaved', () => {
  it('matches whatever the casing', () => {
    const wallets: SavedWallet[] = [
      { address: VITALIK, label: null, ensName: null, savedAt: new Date(NOW).toISOString() },
    ];
    expect(isSaved(wallets, VITALIK)).toBe(true);
    expect(isSaved(wallets, VITALIK.toLowerCase())).toBe(true);
    expect(isSaved(wallets, OTHER_WALLET)).toBe(false);
  });
});

describe('the storage key', () => {
  it('is namespaced alongside the other preferences', () => {
    expect(STORAGE_KEY).toBe('nuxfolio.savedWallets');
  });
});
