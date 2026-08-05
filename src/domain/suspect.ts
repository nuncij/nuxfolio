import type { PortfolioAsset } from './portfolio';

/**
 * Identifying assets that are probably not the user's.
 *
 * Anyone can send anything to any address, so a wallet's contents are not the
 * same thing as a wallet's holdings. Scam airdrops exploit that: a token named
 * "USDC" with a fabricated price is the one remaining way this product could
 * **overstate** a portfolio, which is the failure mode it exists to avoid.
 *
 * The two heuristics below are deliberately narrow and deterministic. Both make
 * a claim about the asset's *identity* — that it is impersonating something, or
 * advertising at the holder — never about the quality of its price. A doubtful
 * price on a real holding stays in the total and gets a flag instead
 * (docs/DECISIONS.md, ADR-005 and ADR-014).
 *
 * **Both compare what a person sees, not what the bytes are** — see `canonicalize`.
 * Until 2026-08-04 they compared raw strings, which made them trivially evadable: a
 * symbol of `USD\u200bC` renders as "USDC", is not equal to it, and so appeared in the
 * total with no badge at all. A comparison of raw strings answers whether two things
 * *are* the same; the deception is that they *appear* the same, so appearance is what
 * has to be compared. Cyrillic and Greek lookalikes, fullwidth forms and bidi
 * overrides were the same bypass wearing different characters, and are closed by the
 * same change.
 *
 * The bundled token list acts as a **whitelist**: an asset whose contract is on
 * its chain's list is never suspect. That is not a shortcut, it is required for
 * correctness — the lists carry real tokens called "ether.fi Staked ETH",
 * "Crypto.com Staked ETH" and "Venus Reward", every one of which trips the bait
 * patterns below. Excluding a genuine holding from the total would be the same
 * category of quiet error the heuristics are meant to prevent.
 */

/** Derived from the wire schema so the two can never drift apart. */
export type SuspectReason = NonNullable<PortfolioAsset['suspectReason']>;

export type SuspectAssessment = {
  readonly suspect: boolean;
  readonly suspectReason: SuspectReason | null;
};

/** The minimum a token list entry has to expose for the heuristics to work. */
export type ListedToken = {
  readonly address: string;
  readonly symbol: string;
};

/** Lowercased lookup sets, built once per chain per portfolio build. */
export type ListedTokenIndex = {
  readonly addresses: ReadonlySet<string>;
  readonly symbols: ReadonlySet<string>;
};

/** Short label for the row badge in the UI. */
export const SUSPECT_REASON_LABEL: Record<SuspectReason, string> = {
  'symbol-spoof': 'Copied symbol',
  'bait-name': 'Bait naming',
};

/**
 * Reviewable in one screen, on purpose: every pattern here can exclude an asset
 * from the total, so the list is meant to be argued with rather than grown
 * casually.
 *
 * The TLD pattern requires a literal dot and a boundary after the suffix, so
 * "COMbat" and "commodity" do not match while "claim-usdc.com" does. The word
 * patterns are anchored only at the start, so plurals ("rewards") match while
 * "steward" does not.
 */
export const BAIT_PATTERNS: readonly RegExp[] = [
  /\bhttp/i,
  /\bwww\./i,
  /\.(com|io|net|org|xyz|fi)\b/i,
  /\b(claim|airdrop|voucher|reward)/i,
];

const NOT_SUSPECT: SuspectAssessment = { suspect: false, suspectReason: null };

/**
 * Builds the lookup sets for one chain.
 *
 * The native symbol joins the listed symbols because a fake ERC-20 calling
 * itself "ETH" is the canonical spoof, and the native asset is never on an
 * ERC-20 token list to collide with.
 */
export function createListedTokenIndex(input: {
  tokens: readonly ListedToken[];
  nativeSymbol: string;
}): ListedTokenIndex {
  const addresses = new Set<string>();
  const symbols = new Set<string>();

  for (const token of input.tokens) {
    addresses.add(token.address.toLowerCase());
    const symbol = canonicalize(token.symbol);
    if (symbol.length > 0) {
      symbols.add(symbol);
    }
  }

  const nativeSymbol = canonicalize(input.nativeSymbol);
  if (nativeSymbol.length > 0) {
    symbols.add(nativeSymbol);
  }

  return { addresses, symbols };
}

/**
 * Assesses one asset against the two heuristics.
 *
 * Symbol spoofing is checked first: when both fire it is the more specific
 * statement about what the asset is pretending to be.
 */
export function assessSuspect(
  asset: { contractAddress: string | null; name: string; symbol: string },
  listed: ListedTokenIndex,
): SuspectAssessment {
  // The native asset's identity comes from the chain registry, not from
  // anything the wallet received, so it cannot be an airdrop.
  if (asset.contractAddress === null) {
    return NOT_SUSPECT;
  }

  if (listed.addresses.has(asset.contractAddress.toLowerCase())) {
    return NOT_SUSPECT;
  }

  const symbol = canonicalize(asset.symbol);
  if (symbol.length > 0 && listed.symbols.has(symbol)) {
    return { suspect: true, suspectReason: 'symbol-spoof' };
  }

  if (matchesBaitPattern(asset.name) || matchesBaitPattern(asset.symbol)) {
    return { suspect: true, suspectReason: 'bait-name' };
  }

  return NOT_SUSPECT;
}

/**
 * Bait matching runs on the canonical form too, for the same reason as symbols:
 * `cl\u200baim` and `\u0441laim` both render as "claim" and neither matches
 * `/\\bclaim/` as written.
 */
export function matchesBaitPattern(text: string): boolean {
  const canonical = canonicalize(text);
  return BAIT_PATTERNS.some((pattern) => pattern.test(canonical));
}

/**
 * Characters that render as nothing: C0/C1 controls, zero-width marks, bidi
 * overrides and isolates, and the byte-order mark. Written as escapes because they
 * are invisible by definition — a literal would make this line unreviewable, which
 * is exactly the property being defended against.
 *
 * Built with `new RegExp` from a string rather than written as a literal so the
 * escapes stay legible at this width; the class is used in exactly one place.
 */
const INVISIBLE_CHARACTERS = new RegExp(
  '[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]',
  'gu',
);

/**
 * Non-Latin letters that are **visually identical** to a Latin one, mapped to it.
 *
 * Without this, `USD\u0421` — Cyrillic Es in place of the C — renders as "USDC" and
 * compares unequal to it, so a spoof of a listed symbol passes unflagged. Sources are
 * lowercase because canonicalisation lowercases first; a spoof using a capital
 * (`\u0421` is the one an attacker would type, since tickers are uppercase) arrives
 * here already lowercased to `\u0441`.
 *
 * **This is a curated subset, not Unicode confusable coverage.** Only characters
 * whose glyph is indistinguishable from the Latin letter in ordinary fonts are here;
 * merely *similar* ones are deliberately absent, because each entry can only ever
 * cause an asset to be marked suspect, and a wrong entry would mark a real holding.
 * Greek Xi is the worked example: it is absent, and `S\u039eR` — a real listed token
 * that styles its ticker with the ether sigil — is the reason. A test pins that.
 *
 * The ambiguous entry is Greek nu: capital \u039d is identical to Latin N, while
 * lowercase \u03bd reads as a v. It maps to n, because a spoof typed in capitals is
 * the case worth catching and a ticker using lowercase nu as a v is not a pattern
 * that appears in the 12,366 listed symbols.
 */
const CONFUSABLE_LETTERS: ReadonlyMap<string, string> = new Map([
  // Cyrillic
  ['\u0430', 'a'], // а CYRILLIC SMALL LETTER A
  ['\u0432', 'b'], // в CYRILLIC SMALL LETTER VE (capital В is identical to B)
  ['\u0435', 'e'], // е CYRILLIC SMALL LETTER IE
  ['\u043a', 'k'], // к CYRILLIC SMALL LETTER KA
  ['\u043c', 'm'], // м CYRILLIC SMALL LETTER EM
  ['\u043d', 'h'], // н CYRILLIC SMALL LETTER EN (capital Н is identical to H)
  ['\u043e', 'o'], // о CYRILLIC SMALL LETTER O
  ['\u0440', 'p'], // р CYRILLIC SMALL LETTER ER
  ['\u0441', 'c'], // с CYRILLIC SMALL LETTER ES
  ['\u0442', 't'], // т CYRILLIC SMALL LETTER TE
  ['\u0443', 'y'], // у CYRILLIC SMALL LETTER U
  ['\u0445', 'x'], // х CYRILLIC SMALL LETTER HA
  ['\u0455', 's'], // ѕ CYRILLIC SMALL LETTER DZE
  ['\u0456', 'i'], // і CYRILLIC SMALL LETTER BYELORUSSIAN-UKRAINIAN I
  ['\u0458', 'j'], // ј CYRILLIC SMALL LETTER JE
  ['\u04bb', 'h'], // һ CYRILLIC SMALL LETTER SHHA
  ['\u04cf', 'l'], // ӏ CYRILLIC SMALL LETTER PALOCHKA
  ['\u0501', 'd'], // ԁ CYRILLIC SMALL LETTER KOMI DE
  ['\u051b', 'q'], // ԛ CYRILLIC SMALL LETTER QA
  ['\u051d', 'w'], // ԝ CYRILLIC SMALL LETTER WE
  // Greek
  ['\u03b1', 'a'], // α GREEK SMALL LETTER ALPHA
  ['\u03b2', 'b'], // β GREEK SMALL LETTER BETA
  ['\u03b5', 'e'], // ε GREEK SMALL LETTER EPSILON
  ['\u03b7', 'h'], // η GREEK SMALL LETTER ETA
  ['\u03b9', 'i'], // ι GREEK SMALL LETTER IOTA
  ['\u03ba', 'k'], // κ GREEK SMALL LETTER KAPPA
  ['\u03bc', 'm'], // μ GREEK SMALL LETTER MU
  ['\u03bd', 'n'], // ν GREEK SMALL LETTER NU — see the note above
  ['\u03bf', 'o'], // ο GREEK SMALL LETTER OMICRON
  ['\u03c1', 'p'], // ρ GREEK SMALL LETTER RHO
  ['\u03c4', 't'], // τ GREEK SMALL LETTER TAU
  ['\u03c5', 'y'], // υ GREEK SMALL LETTER UPSILON
  ['\u03c7', 'x'], // χ GREEK SMALL LETTER CHI
]);

/**
 * The one form in which every symbol and name is compared.
 *
 * Both heuristics answer "does this look like something it is not", and a comparison
 * of raw strings answers the wrong question: it asks whether two things *are* the
 * same, when the deception is that they *appear* the same. So everything is reduced
 * to what a person actually sees before any comparison happens.
 *
 * The steps, in an order that matters:
 *
 *  1. **NFKC**, which folds compatibility forms — fullwidth `\uff35\uff33\uff24\uff23`,
 *     mathematical and circled letters — onto their plain equivalents.
 *  2. **Strip invisible characters.** Measured on 2026-08-04: none of the 12,366
 *     listed symbols contains one, so stripping cannot break a legitimate match,
 *     while `USD\u200bC` renders as USDC and previously compared unequal to it.
 *  3. **Lowercase**, then **map confusables**, in that order — the map's keys are
 *     lowercase.
 *  4. **Trim.**
 *
 * Applied to **both sides** of every comparison. That symmetry is the correctness
 * property: canonicalising only the asset would leave the listed index holding raw
 * strings, and the equality would fail for a new reason instead of the old one.
 *
 * Measured cost, since this runs over every listed symbol when an index is built:
 * **6.7 ms against 3.4 ms** for the plain `trim().toLowerCase()` it replaced, across
 * all 12,366 symbols on all five chains. An extra 3 ms on a cold scan that takes
 * about two seconds.
 *
 * Measured effect on real data: of those 12,366 symbols, **8 canonicalise to
 * something different** from their plain lowercase form, and **no two distinct
 * symbols collapse onto the same canonical form** — so the mapping adds no ambiguity
 * to the whitelist it is compared against.
 */
export function canonicalize(text: string): string {
  const folded = text.normalize('NFKC').replace(INVISIBLE_CHARACTERS, '').toLowerCase();

  let result = '';
  for (const character of folded) {
    result += CONFUSABLE_LETTERS.get(character) ?? character;
  }
  return result.trim();
}
