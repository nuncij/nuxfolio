'use client';

import { useSyncExternalStore } from 'react';

import {
  applyThemeMode,
  describeThemeMode,
  parseThemeMode,
  THEME_MODES,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from '@/lib/theme';

/**
 * Theme picker: system, light, dark.
 *
 * A segmented control rather than a single flip, because "follow my system" is a
 * state worth being able to see and return to. A two-way switch silently
 * discards it the first time it is clicked.
 *
 * **Hydration.** The preference lives in `localStorage`, which the server cannot
 * read, so the server and the first client render must agree on something else.
 * `useSyncExternalStore` is built for exactly this: its third argument is the
 * server snapshot, and React re-reads the real value immediately after hydrating.
 * Reading it in an effect instead would mean a synchronous state update during
 * mount — the pattern that hid a real bug in this codebase once already (ADR-010).
 *
 * Subscribing also buys cross-tab sync: change the theme in one tab and every
 * other tab's control follows, because `storage` fires in the others.
 */
export function ThemeToggle() {
  const mode = useSyncExternalStore(subscribeToThemeMode, readThemeMode, readServerThemeMode);

  function choose(next: ThemeMode): void {
    applyThemeMode(document.documentElement, next);
    try {
      if (next === 'system') {
        // Removing it, rather than storing "system", means a visitor who never
        // chose and one who chose to follow the system stay indistinguishable.
        window.localStorage.removeItem(THEME_STORAGE_KEY);
      } else {
        window.localStorage.setItem(THEME_STORAGE_KEY, next);
      }
    } catch {
      // The choice still applies to this page; it just will not be remembered.
    }
    // This tab's own write does not raise `storage`, so tell the store directly.
    notifyThemeModeChanged();
  }

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-full border border-line bg-surface p-0.5"
    >
      {THEME_MODES.map((option) => {
        const active = mode === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => choose(option)}
            aria-pressed={active}
            title={describeThemeMode(option)}
            className={`flex size-6 items-center justify-center rounded-full text-[11px] transition-colors ${
              active
                ? 'bg-accent text-accent-ink'
                : 'text-ink-subtle hover:bg-surface-raised hover:text-ink'
            }`}
          >
            <ThemeGlyph mode={option} />
            <span className="sr-only">{describeThemeMode(option)}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The external store backing the control.
 *
 * Module scope rather than component state, so several instances of the toggle —
 * and several tabs — cannot disagree about the current mode.
 */
const themeModeListeners = new Set<() => void>();

function subscribeToThemeMode(onChange: () => void): () => void {
  themeModeListeners.add(onChange);
  // `storage` fires in *other* tabs only, which is precisely the cross-tab case.
  window.addEventListener('storage', onChange);
  return () => {
    themeModeListeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function notifyThemeModeChanged(): void {
  for (const listener of themeModeListeners) {
    listener();
  }
}

/**
 * Returns a primitive, so React's identity comparison is a value comparison and
 * the snapshot never looks changed when it has not.
 */
function readThemeMode(): ThemeMode {
  try {
    return parseThemeMode(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Storage can be blocked outright. Following the system is a fine answer.
    return 'system';
  }
}

function readServerThemeMode(): ThemeMode {
  return 'system';
}

/**
 * Inline SVG rather than an emoji or an icon package: emoji render as full-colour
 * pictures that ignore the current text colour, and a package would be a
 * dependency for three shapes.
 */
function ThemeGlyph({ mode }: { mode: ThemeMode }) {
  const common = {
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    className: 'size-3.5',
  };

  if (mode === 'light') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1" />
      </svg>
    );
  }

  if (mode === 'dark') {
    return (
      <svg {...common}>
        <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z" />
      </svg>
    );
  }

  // System: a display, i.e. "whatever this device says".
  return (
    <svg {...common}>
      <rect x="2" y="3" width="12" height="8" rx="1.5" />
      <path d="M6 13.5h4" />
    </svg>
  );
}
