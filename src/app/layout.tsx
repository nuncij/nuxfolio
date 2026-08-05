import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { ThemeToggle } from '@/components/ThemeToggle';
import { themeBootstrapScript } from '@/lib/theme';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Nuxfolio — Your crypto portfolio, clearly explained',
    template: '%s · Nuxfolio',
  },
  description:
    'A read-only crypto portfolio tracker. Enter a public wallet address to see its assets, estimated value and concentration — no wallet connection, no private keys.',
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  // Per scheme, so the browser chrome matches the page instead of staying dark
  // for a visitor reading in light mode.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f6f7f9' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0b0d' },
  ],
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    /*
     * `suppressHydrationWarning` is load-bearing and scoped to this element: the
     * script below deliberately sets `data-theme` on <html> before React runs, so
     * the server markup and the hydrated DOM differ here by design. It suppresses
     * one level only, so nothing inside the tree loses its hydration checks.
     */
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * Blocking on purpose. Styling follows `data-theme`, so the attribute has
         * to exist before the first paint; doing this in an effect would show
         * every dark-mode visitor a white flash on each navigation.
         */}
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }} />
      </head>
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-ink"
        >
          Skip to content
        </a>

        <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 sm:px-6">
          <SiteHeader />
          <main id="main" className="flex-1 py-8">
            {children}
          </main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}

function SiteHeader() {
  return (
    <header className="flex items-center justify-between gap-4 border-b border-line py-4">
      <Link href="/" className="flex items-baseline gap-2">
        <span className="text-base font-semibold tracking-tight text-ink">Nuxfolio</span>
        <span className="hidden text-xs text-ink-subtle sm:inline">
          Your crypto portfolio, clearly explained
        </span>
      </Link>

      {/*
        A standing, visible statement of what this application can do. It is the
        first thing a cautious user looks for, and it is true at the
        architectural level: there is no signing path in this codebase.
      */}
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
          Read-only
        </span>
        <ThemeToggle />
      </div>
    </header>
  );
}

function SiteFooter() {
  return (
    <footer className="border-t border-line py-6 text-xs text-ink-subtle">
      <p>
        Nuxfolio reads public blockchain data and public market prices. It never asks for a seed
        phrase or private key, cannot move funds, and shows estimates rather than advice.
      </p>
    </footer>
  );
}
