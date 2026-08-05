/**
 * WCAG relative-luminance contrast, and a reader for the shipped palette.
 *
 * This exists because a colour choice is a *correctness* property here, not a
 * matter of taste: `ink-subtle` — the caption colour used in seventeen places —
 * sat below the legibility floor in the dark theme from milestone 1 until light
 * mode was added and someone finally did the arithmetic. Anything that can be
 * wrong for eight months without a failing test needs a failing test.
 *
 * The reader parses `globals.css` rather than duplicating the values in
 * TypeScript. That is the whole point: a copy would let the test prove the copy
 * is accessible while the stylesheet the browser actually loads drifted away from
 * it — protection that looks real and is not.
 */

/** The minimum ratio WCAG 2.1 requires of normal-size body text (level AA). */
export const AA_TEXT_CONTRAST = 4.5;

/**
 * A far lower bar, for borders and dividers.
 *
 * Non-text UI boundaries have no AA text requirement; this only asserts they are
 * distinguishable from what they sit on rather than invisible.
 */
export const VISIBLE_BOUNDARY_CONTRAST = 1.4;

export type Rgb = readonly [number, number, number];

export class ColourParseError extends Error {
  constructor(value: string) {
    super(`Not a 6-digit hex colour: ${JSON.stringify(value)}`);
    this.name = 'ColourParseError';
  }
}

/**
 * Parses `#rrggbb`. Deliberately strict — the palette is written by hand, and
 * silently accepting a typo'd or shorthand value would let the check pass on a
 * colour the browser resolves differently.
 */
export function parseHexColour(value: string): Rgb {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match?.[1]) {
    throw new ColourParseError(value);
  }
  const int = Number.parseInt(match[1], 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}

/** sRGB channel → linear light, per WCAG's definition. */
function toLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(colour: Rgb): number {
  const [r, g, b] = colour;
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG contrast ratio, between 1 (identical) and 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [
    relativeLuminance(parseHexColour(a)),
    relativeLuminance(parseHexColour(b)),
  ].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/** Every `--nx-*` custom property in one theme block, keyed without the prefix. */
export type Palette = Readonly<Record<string, string>>;

export type ThemeBlock =
  /** `:root` — the light palette, and the base for a document with no attribute. */
  | 'light'
  /** `@media (prefers-color-scheme: dark)` — visitors who never chose. */
  | 'system-dark'
  /** `[data-theme='dark']` — visitors who clicked the moon. */
  | 'explicit-dark';

/**
 * Where each theme block starts in the stylesheet.
 *
 * Matched on the selector text so a reordering of the file cannot silently make
 * the reader look at the wrong block.
 */
const BLOCK_ANCHORS: Readonly<Record<ThemeBlock, string>> = {
  light: ':root {',
  'system-dark': ':root:not([data-theme])',
  'explicit-dark': ":root[data-theme='dark']",
};

const TOKEN_PATTERN = /--nx-([\w-]+)\s*:\s*([^;]+);/g;

/**
 * Extracts one theme's tokens from the stylesheet source.
 *
 * Reads from the anchor to the block's closing brace by counting depth, rather
 * than with a fixed window, so adding tokens or comments to a block cannot cause
 * a silent truncation that the contrast check would then pass by omission.
 */
export function readPalette(css: string, block: ThemeBlock): Palette {
  const anchor = BLOCK_ANCHORS[block];
  const anchorIndex = css.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(`globals.css no longer contains the ${block} block ("${anchor}")`);
  }

  const openIndex = css.indexOf('{', anchorIndex + anchor.length - 1);
  if (openIndex === -1) {
    throw new Error(`The ${block} block has no opening brace`);
  }

  let depth = 0;
  let closeIndex = -1;
  for (let i = openIndex; i < css.length; i += 1) {
    if (css[i] === '{') {
      depth += 1;
    } else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        closeIndex = i;
        break;
      }
    }
  }
  if (closeIndex === -1) {
    throw new Error(`The ${block} block is unterminated`);
  }

  const body = css.slice(openIndex, closeIndex);
  const palette: Record<string, string> = {};
  for (const [, name, value] of body.matchAll(TOKEN_PATTERN)) {
    if (name !== undefined && value !== undefined) {
      palette[name] = value.trim();
    }
  }
  return palette;
}
