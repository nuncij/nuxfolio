import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  AA_TEXT_CONTRAST,
  ColourParseError,
  contrastRatio,
  parseHexColour,
  readPalette,
  relativeLuminance,
  VISIBLE_BOUNDARY_CONTRAST,
  type Palette,
} from './contrast';

/**
 * The real stylesheet, read from disk.
 *
 * Not a fixture and not a copy of the values: this suite has to fail when
 * `globals.css` changes, which it cannot do if it asserts against its own
 * duplicate of the palette.
 */
const CSS = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');

const LIGHT = readPalette(CSS, 'light');
const SYSTEM_DARK = readPalette(CSS, 'system-dark');
const EXPLICIT_DARK = readPalette(CSS, 'explicit-dark');

/**
 * Which surfaces each foreground can actually appear on.
 *
 * Derived from how the components use them, not from every possible pairing —
 * asserting combinations the UI never renders would invent work and, worse, might
 * be "fixed" by changing a colour that was fine.
 */
const TEXT_ON_SURFACES: readonly { fg: string; backgrounds: readonly string[] }[] = [
  // Body copy, headings, table values: every card and table surface.
  { fg: 'ink', backgrounds: ['canvas', 'surface', 'surface-raised'] },
  // Labels, secondary values, table headers.
  { fg: 'ink-muted', backgrounds: ['canvas', 'surface', 'surface-raised'] },
  // Captions and detail lines — the token that regressed unnoticed.
  { fg: 'ink-subtle', backgrounds: ['canvas', 'surface', 'surface-raised'] },
  // Links and the active theme pill's own text sits on accent, handled below.
  { fg: 'accent', backgrounds: ['canvas', 'surface', 'surface-raised'] },
  // Button and pill labels on the filled accent.
  { fg: 'accent-ink', backgrounds: ['accent'] },
  // Warning headings and bullets, on their panel and loose on the page.
  { fg: 'caution', backgrounds: ['caution-surface', 'canvas', 'surface'] },
  // Price-direction figures in the asset table, which sits on every surface.
  { fg: 'positive', backgrounds: ['canvas', 'surface', 'surface-raised'] },
  { fg: 'negative', backgrounds: ['canvas', 'surface', 'surface-raised'] },
];

/** Boundaries only have to be perceptible, not legible. */
const BOUNDARIES: readonly { fg: string; backgrounds: readonly string[] }[] = [
  { fg: 'line-strong', backgrounds: ['canvas', 'surface'] },
  { fg: 'caution-line', backgrounds: ['caution-surface', 'canvas'] },
];

const THEMES: readonly { name: string; palette: Palette }[] = [
  { name: 'light', palette: LIGHT },
  { name: 'dark', palette: EXPLICIT_DARK },
];

describe('parseHexColour', () => {
  it('parses six-digit hex in either case', () => {
    expect(parseHexColour('#ffffff')).toEqual([255, 255, 255]);
    expect(parseHexColour('#0A0B0D')).toEqual([10, 11, 13]);
  });

  it('tolerates surrounding whitespace, which CSS values carry', () => {
    expect(parseHexColour('  #123456 ')).toEqual([18, 52, 86]);
  });

  it.each(['#fff', 'white', 'rgb(0,0,0)', '#12345', '#1234567', '', '#gggggg'])(
    'rejects %o rather than guessing',
    (value) => {
      // A shorthand or named colour would resolve differently in the browser than
      // whatever this parser invented for it, so the check must refuse it.
      expect(() => parseHexColour(value)).toThrow(ColourParseError);
    },
  );
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 10);
  });

  it('weights green above red above blue, per the sRGB coefficients', () => {
    const red = relativeLuminance([255, 0, 0]);
    const green = relativeLuminance([0, 255, 0]);
    const blue = relativeLuminance([0, 0, 255]);
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

describe('contrastRatio', () => {
  it('is 21 for black on white, the theoretical maximum', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
  });

  it('is 1 for a colour against itself', () => {
    expect(contrastRatio('#8a5a00', '#8a5a00')).toBeCloseTo(1, 10);
  });

  it('is symmetric, since neither argument is privileged', () => {
    expect(contrastRatio('#12151a', '#f6f7f9')).toBeCloseTo(
      contrastRatio('#f6f7f9', '#12151a'),
      10,
    );
  });

  it('agrees with a known published value', () => {
    // #767676 on white is the canonical 4.54:1 example of a colour that just
    // clears AA; if the formula drifts, this moves.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
  });
});

describe('readPalette', () => {
  it('finds all fifteen tokens in each of the three blocks', () => {
    // The count is asserted so that a token added to one theme but forgotten in
    // another fails here rather than rendering an unstyled colour in the dark.
    expect(Object.keys(LIGHT)).toHaveLength(15);
    expect(Object.keys(SYSTEM_DARK)).toHaveLength(15);
    expect(Object.keys(EXPLICIT_DARK)).toHaveLength(15);
  });

  it('reads the values the stylesheet actually declares', () => {
    expect(LIGHT['canvas']).toBe('#f6f7f9');
    expect(EXPLICIT_DARK['canvas']).toBe('#0a0b0d');
  });

  it('fails loudly if a block it depends on is renamed or removed', () => {
    // Silence here would mean the contrast checks below pass by reading nothing.
    expect(() => readPalette('/* no palette at all */', 'light')).toThrow(/no longer contains/);
  });

  it('reads a whole block rather than a fixed window', () => {
    const css = `:root {\n  --nx-a: #000000;\n  /* a comment */\n  --nx-b: #ffffff;\n}`;
    expect(readPalette(css, 'light')).toEqual({ a: '#000000', b: '#ffffff' });
  });

  it('stops at the block it was asked for', () => {
    const css = `:root {\n  --nx-a: #000000;\n}\n:root[data-theme='dark'] {\n  --nx-a: #ffffff;\n}`;
    expect(readPalette(css, 'light')).toEqual({ a: '#000000' });
    expect(readPalette(css, 'explicit-dark')).toEqual({ a: '#ffffff' });
  });
});

describe('the shipped palette', () => {
  it('declares the same token names in every theme', () => {
    // A token present in one theme and missing in another inherits the other
    // theme's value, which is how a dark surface ends up under light text.
    const names = (palette: Palette) => Object.keys(palette).sort();
    expect(names(SYSTEM_DARK)).toEqual(names(LIGHT));
    expect(names(EXPLICIT_DARK)).toEqual(names(LIGHT));
  });

  it('keeps the two dark declarations byte-identical', () => {
    // The dark palette is written twice: once for `prefers-color-scheme: dark`,
    // once for an explicit `[data-theme="dark"]`. They must agree, or a visitor
    // whose OS is dark sees different colours from one who clicked the moon.
    // Nothing but this test enforces it.
    expect(EXPLICIT_DARK).toEqual(SYSTEM_DARK);
  });

  it('uses only strict six-digit hex, so the ratios mean something', () => {
    for (const { name, palette } of [
      { name: 'light', palette: LIGHT },
      { name: 'system-dark', palette: SYSTEM_DARK },
      { name: 'explicit-dark', palette: EXPLICIT_DARK },
    ]) {
      for (const [token, value] of Object.entries(palette)) {
        expect(() => parseHexColour(value), `${name}/${token} = ${value}`).not.toThrow();
      }
    }
  });

  describe.each(THEMES)('$name theme', ({ palette }) => {
    const pairs = TEXT_ON_SURFACES.flatMap(({ fg, backgrounds }) =>
      backgrounds.map((bg) => ({ fg, bg })),
    );

    it.each(pairs)('$fg on $bg meets AA for body text', ({ fg, bg }) => {
      const foreground = palette[fg];
      const background = palette[bg];
      expect(foreground, `missing token: ${fg}`).toBeDefined();
      expect(background, `missing token: ${bg}`).toBeDefined();

      const ratio = contrastRatio(foreground as string, background as string);
      // The message carries the numbers, so a failure says how far off it is
      // rather than only that something is wrong.
      expect(
        ratio,
        `${fg} (${foreground}) on ${bg} (${background}) is ${ratio.toFixed(2)}:1, needs ${AA_TEXT_CONTRAST}:1`,
      ).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
    });

    const boundaryPairs = BOUNDARIES.flatMap(({ fg, backgrounds }) =>
      backgrounds.map((bg) => ({ fg, bg })),
    );

    it.each(boundaryPairs)('$fg is visible against $bg', ({ fg, bg }) => {
      const ratio = contrastRatio(palette[fg] as string, palette[bg] as string);
      expect(
        ratio,
        `${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${VISIBLE_BOUNDARY_CONTRAST}:1`,
      ).toBeGreaterThanOrEqual(VISIBLE_BOUNDARY_CONTRAST);
    });
  });

  it('would have caught the ink-subtle regression that shipped in milestone 1', () => {
    // The historical value, kept as a guard on the guard: if this ever passes,
    // the check above has stopped being able to detect the bug it exists for.
    const shipped = '#6b7482';
    expect(contrastRatio(shipped, EXPLICIT_DARK['surface'] as string)).toBeLessThan(
      AA_TEXT_CONTRAST,
    );
    expect(
      contrastRatio(EXPLICIT_DARK['ink-subtle'] as string, EXPLICIT_DARK['surface'] as string),
    ).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST);
  });
});
