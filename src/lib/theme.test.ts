import { describe, expect, it } from 'vitest';

import {
  applyThemeMode,
  describeThemeMode,
  isThemeMode,
  parseThemeMode,
  resolveTheme,
  THEME_ATTRIBUTE,
  THEME_MODES,
  THEME_STORAGE_KEY,
  themeBootstrapScript,
} from './theme';

/** A stand-in for `document.documentElement`: only two methods are used. */
function fakeRoot() {
  const attributes = new Map<string, string>();
  return {
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    get: (name: string) => attributes.get(name),
    has: (name: string) => attributes.has(name),
  };
}

describe('parseThemeMode', () => {
  it.each(THEME_MODES)('accepts %s', (mode) => {
    expect(parseThemeMode(mode)).toBe(mode);
  });

  it.each([null, undefined, '', 'DARK', 'sepia', 42, {}, []])(
    'falls back to following the system for %o',
    (value) => {
      // localStorage holds whatever a past version of the app or the user's own
      // devtools left there; unrecognised input must not throw or pick a side.
      expect(parseThemeMode(value)).toBe('system');
    },
  );
});

describe('isThemeMode', () => {
  it('narrows only the three known modes', () => {
    expect(isThemeMode('light')).toBe(true);
    expect(isThemeMode('auto')).toBe(false);
    expect(isThemeMode(null)).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('follows the system preference in system mode', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('ignores the system preference once a mode is chosen', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('applyThemeMode', () => {
  it('writes the attribute for an explicit choice', () => {
    const root = fakeRoot();
    applyThemeMode(root as unknown as HTMLElement, 'dark');
    expect(root.get(THEME_ATTRIBUTE)).toBe('dark');
  });

  it('removes the attribute for system, rather than writing a resolved value', () => {
    // Writing "light" for a system-light visitor would freeze them in light mode
    // when their OS later switches; absence is what hands control to the
    // stylesheet's prefers-color-scheme block.
    const root = fakeRoot();
    applyThemeMode(root as unknown as HTMLElement, 'light');
    applyThemeMode(root as unknown as HTMLElement, 'system');
    expect(root.has(THEME_ATTRIBUTE)).toBe(false);
  });

  it('is idempotent', () => {
    const root = fakeRoot();
    applyThemeMode(root as unknown as HTMLElement, 'light');
    applyThemeMode(root as unknown as HTMLElement, 'light');
    expect(root.get(THEME_ATTRIBUTE)).toBe('light');
  });
});

describe('describeThemeMode', () => {
  it('labels every mode', () => {
    expect(describeThemeMode('light')).toBe('Light');
    expect(describeThemeMode('dark')).toBe('Dark');
    expect(describeThemeMode('system')).toBe('Match system');
  });
});

describe('themeBootstrapScript', () => {
  const script = themeBootstrapScript();

  it('references the same storage key and attribute as the module', () => {
    // The script is a string, so a rename elsewhere cannot break it at compile
    // time. This test is the only thing keeping the two in step.
    expect(script).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(script).toContain(JSON.stringify(THEME_ATTRIBUTE));
  });

  it('swallows a throwing localStorage rather than breaking the page', () => {
    expect(script).toContain('try{');
    expect(script).toContain('catch(e){}');
  });

  it('applies only explicit modes, never a resolved system value', () => {
    expect(script).toContain('"light"');
    expect(script).toContain('"dark"');
    expect(script).not.toContain('"system"');
  });

  it('actually applies a stored mode when evaluated', () => {
    // Runs the real string against fakes, so a syntax error or a wrong branch
    // fails here rather than silently doing nothing in a browser.
    const root = fakeRoot();
    const run = (stored: string | null) => {
      const documentStub = { documentElement: root };
      const storageStub = { getItem: () => stored };
      new Function('document', 'localStorage', script)(documentStub, storageStub);
    };

    run('dark');
    expect(root.get(THEME_ATTRIBUTE)).toBe('dark');

    run('system');
    // "system" is not an explicit mode, so the previous attribute is left alone
    // by the script; the React layer is what clears it.
    expect(root.get(THEME_ATTRIBUTE)).toBe('dark');
  });

  it('does nothing when storage throws', () => {
    const root = fakeRoot();
    const documentStub = { documentElement: root };
    const storageStub = {
      getItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() =>
      new Function('document', 'localStorage', script)(documentStub, storageStub),
    ).not.toThrow();
    expect(root.has(THEME_ATTRIBUTE)).toBe(false);
  });
});
