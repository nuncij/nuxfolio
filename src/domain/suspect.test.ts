import { describe, expect, it } from 'vitest';

import { USDC, WETH } from '@/test/helpers';

import { assessSuspect, canonicalize, createListedTokenIndex, matchesBaitPattern } from './suspect';

const OFF_LIST = '0x1111111111111111111111111111111111111111';

const listed = createListedTokenIndex({
  tokens: [
    { address: USDC, symbol: 'USDC' },
    { address: WETH, symbol: 'WETH' },
  ],
  nativeSymbol: 'ETH',
});

function assess(overrides: { contractAddress?: string | null; name?: string; symbol?: string }) {
  return assessSuspect(
    { contractAddress: OFF_LIST, name: 'Some Token', symbol: 'SOME', ...overrides },
    listed,
  );
}

describe('assessSuspect', () => {
  describe('symbol spoofing', () => {
    it('fires for an off-list contract whose symbol collides with a listed one', () => {
      expect(assess({ symbol: 'USDC' })).toEqual({
        suspect: true,
        suspectReason: 'symbol-spoof',
      });
    });

    it('ignores case and surrounding whitespace, which is how the collision is hidden', () => {
      expect(assess({ symbol: ' usdc ' }).suspectReason).toBe('symbol-spoof');
    });

    it('clears a listed contract holding its own symbol', () => {
      expect(assess({ contractAddress: USDC, symbol: 'USDC' }).suspect).toBe(false);
    });

    it('matches the listed address regardless of checksum casing', () => {
      expect(assess({ contractAddress: USDC.toLowerCase(), symbol: 'USDC' }).suspect).toBe(false);
    });

    it('clears an off-list contract whose symbol collides with nothing', () => {
      expect(assess({ symbol: 'NOTLISTED' }).suspect).toBe(false);
    });

    it('fires for a fake native symbol, which no ERC-20 list can collide with', () => {
      expect(assess({ symbol: 'ETH' }).suspectReason).toBe('symbol-spoof');
    });

    it('never fires for the native asset itself', () => {
      expect(assess({ contractAddress: null, symbol: 'ETH', name: 'Ether' }).suspect).toBe(false);
    });
  });

  describe('bait naming', () => {
    it('fires on a claim URL in the name', () => {
      expect(assess({ name: 'Visit claim-usdt.com to redeem' })).toEqual({
        suspect: true,
        suspectReason: 'bait-name',
      });
    });

    it('fires on a bait word in the symbol', () => {
      expect(assess({ symbol: 'AIRDROP' }).suspectReason).toBe('bait-name');
    });

    it('does not fire on a near-miss TLD inside an ordinary word', () => {
      // "COMbat" and "commodity" contain "com" but no domain.
      expect(assess({ symbol: 'COMbat', name: 'COMbat' }).suspect).toBe(false);
      expect(assess({ name: 'Commodity Index' }).suspect).toBe(false);
    });

    it('does not fire on a word that merely ends in a bait word', () => {
      expect(assess({ name: 'Steward Token', symbol: 'STWD' }).suspect).toBe(false);
    });

    it('is never reached for a listed contract, whatever it is called', () => {
      // Real listed tokens are called "ether.fi Staked ETH" and "Venus Reward";
      // excluding them from the total would be the error this module prevents.
      expect(assess({ contractAddress: WETH, name: 'ether.fi Staked ETH' }).suspect).toBe(false);
      expect(assess({ contractAddress: WETH, name: 'Venus Reward' }).suspect).toBe(false);
    });
  });

  it('reports spoofing first when an asset trips both rules', () => {
    expect(assess({ symbol: 'USDC', name: 'Claim at usdc-airdrop.com' }).suspectReason).toBe(
      'symbol-spoof',
    );
  });
});

describe('matchesBaitPattern', () => {
  it.each([
    'http://claim.example',
    'https://x.example',
    'www.free-tokens.example',
    'usdc-rewards.io',
    'stake.xyz',
    'Claim your tokens',
    'Airdrop voucher',
    'Rewards Pool',
  ])('matches %s', (text) => {
    expect(matchesBaitPattern(text)).toBe(true);
  });

  it.each(['COMbat', 'Commodity', 'Steward', 'Financial Index', 'Wrapped Ether', 'USD Coin'])(
    'leaves %s alone',
    (text) => {
      expect(matchesBaitPattern(text)).toBe(false);
    },
  );

  it('stays stateless across repeated calls', () => {
    // A `g` flag on any pattern would make every second call disagree.
    expect(matchesBaitPattern('Claim now')).toBe(true);
    expect(matchesBaitPattern('Claim now')).toBe(true);
  });
});

describe('createListedTokenIndex', () => {
  it('lowercases both lookups so casing cannot split a match', () => {
    const index = createListedTokenIndex({
      tokens: [{ address: USDC, symbol: 'UsDc' }],
      nativeSymbol: 'eth',
    });

    expect(index.addresses.has(USDC.toLowerCase())).toBe(true);
    expect(index.symbols.has('usdc')).toBe(true);
    expect(index.symbols.has('eth')).toBe(true);
  });
});

describe('disguised identity', () => {
  /**
   * Every case here rendered as the real ticker on screen while comparing unequal to
   * it, so the asset appeared in the total with no badge. Characters are written as
   * escapes: literals would make these tests unreadable, which is the point.
   *
   * Reported and fixed 2026-08-04, found while building the token-list refresh — the
   * bundled lists turned out to contain a token named with two leading zero-width
   * spaces, which is what prompted looking here at all.
   */
  it.each([
    ['USD\u200bC', 'a zero-width space inside the ticker'],
    ['USD\u0421', 'Cyrillic Es in place of the C'],
    ['\uff35\uff33\uff24\uff23', 'fullwidth letters'],
    ['\u202eUSDC', 'a right-to-left override in front'],
    ['USDC\ufeff', 'a trailing byte-order mark'],
    ['\u051d\u0435\u0442\u04bb', 'an all-Cyrillic lookalike of WETH'],
  ])('flags %o as a symbol spoof — %s', (symbol) => {
    expect(assess({ symbol }).suspectReason).toBe('symbol-spoof');
  });

  it.each([
    ['cl\u200baim your reward', 'a zero-width space inside the bait word'],
    ['\u0441laim now', 'Cyrillic Es in place of the c'],
    ['\uff57\uff57\uff57.evil.com', 'fullwidth www'],
  ])('flags %o as bait naming — %s', (name) => {
    expect(assess({ name }).suspectReason).toBe('bait-name');
  });

  it('canonicalises the listed side too, so the comparison stays symmetric', () => {
    // Canonicalising only the asset would make the equality fail for a new reason
    // rather than the old one. No listed symbol carries an invisible character today
    // — measured across all 12,366 — so only a test can hold this property.
    const index = createListedTokenIndex({
      tokens: [{ address: USDC, symbol: 'US\u200bDC' }],
      nativeSymbol: 'ETH',
    });

    expect(assessSuspect({ contractAddress: OFF_LIST, name: 'x', symbol: 'USDC' }, index)).toEqual({
      suspect: true,
      suspectReason: 'symbol-spoof',
    });
  });
});

describe('canonicalize', () => {
  it('leaves an ordinary ticker exactly as it is, bar case', () => {
    expect(canonicalize('WETH')).toBe('weth');
    expect(canonicalize(' usdc ')).toBe('usdc');
  });

  it('does not fold a character that is merely similar to a Latin one', () => {
    // Greek Xi is deliberately absent from the confusable map, and this is why:
    // `S\u039eR` is a real token on the Ethereum list that styles its ticker with the
    // ether sigil. Folding it to "SER" would risk marking a genuine holding suspect,
    // which is the same category of quiet error the heuristics exist to prevent.
    expect(canonicalize('S\u039eR')).toBe('s\u03beR'.toLowerCase());
    expect(canonicalize('S\u039eR')).not.toBe('ser');
  });

  it('is idempotent, so it can be applied wherever a comparison happens', () => {
    for (const input of ['USD\u200bC', '\uff35\uff33\uff24\uff23', 'S\u039eR', 'weth']) {
      expect(canonicalize(canonicalize(input))).toBe(canonicalize(input));
    }
  });

  it('leaves a non-Latin ticker unmatched when it resembles nothing listed', () => {
    // A token whose symbol is genuinely Han or Arabic is not impersonating a Latin
    // ticker, so nothing here should make it suspect.
    expect(assess({ symbol: '\u4ee3\u5e01' }).suspect).toBe(false);
  });
});
