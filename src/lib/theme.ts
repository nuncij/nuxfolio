/**
 * Theme selection.
 *
 * Three modes rather than a light/dark switch: "system" is a real choice, and
 * collapsing it into a boolean means a visitor who never expressed a preference
 * gets whichever value the toggle happened to default to.
 *
 * The logic lives here, outside React, for two reasons. It has to run twice —
 * once in a blocking script before first paint, and again in the toggle — and
 * running the same pure function in both places is what keeps them from
 * disagreeing. It is also the only way to unit-test the resolution rules without
 * a browser.
 */

export const THEME_MODES = ['system', 'light', 'dark'] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

/** What actually gets painted, once "system" has been resolved. */
export type ResolvedTheme = 'light' | 'dark';

/** Storage key and DOM attribute, shared with the pre-paint script. */
export const THEME_STORAGE_KEY = 'nuxfolio.theme';
export const THEME_ATTRIBUTE = 'data-theme';

export const DEFAULT_THEME_MODE: ThemeMode = 'system';

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === 'string' && (THEME_MODES as readonly string[]).includes(value);
}

/**
 * Reads a stored value defensively: `localStorage` holds whatever a previous
 * version of the app — or the user's own devtools — put there, so anything
 * unrecognised falls back to following the system rather than throwing.
 */
export function parseThemeMode(value: unknown): ThemeMode {
  return isThemeMode(value) ? value : DEFAULT_THEME_MODE;
}

export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }
  return mode;
}

/**
 * The label the toggle announces. Spelled out rather than assembled in the
 * component so the wording is testable and stays consistent with the icons.
 */
export function describeThemeMode(mode: ThemeMode): string {
  switch (mode) {
    case 'light':
      return 'Light';
    case 'dark':
      return 'Dark';
    default:
      return 'Match system';
  }
}

/**
 * Applies a mode to the document.
 *
 * `system` **removes** the attribute rather than writing a resolved value, which
 * is what lets the stylesheet's `prefers-color-scheme` block take over. Writing
 * `data-theme="light"` for a system-light visitor would freeze them in light mode
 * when their OS later switches to dark.
 */
export function applyThemeMode(root: HTMLElement, mode: ThemeMode): void {
  if (mode === 'system') {
    root.removeAttribute(THEME_ATTRIBUTE);
  } else {
    root.setAttribute(THEME_ATTRIBUTE, mode);
  }
}

/**
 * The script that runs before first paint, inlined into `<head>`.
 *
 * It exists to prevent a flash of the wrong theme: styles are applied from the
 * document attribute, so the attribute has to be set before the browser paints,
 * which rules out doing it from an effect. Deliberately tiny and total: a
 * `localStorage` read can throw outright when cookies are blocked, and a theme
 * preference is never worth breaking a page load over.
 */
export function themeBootstrapScript(): string {
  return `try{var m=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(m==="light"||m==="dark"){document.documentElement.setAttribute(${JSON.stringify(THEME_ATTRIBUTE)},m)}}catch(e){}`;
}
