import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end configuration.
 *
 * What this suite is for: proving that Nuxfolio's own pieces are wired together
 * — route resolves the address, client validates the payload, components render
 * the state the payload implies. It is deliberately *not* a provider test. Every
 * `/api/portfolio` response is intercepted in the browser (see `e2e/fixtures.ts`),
 * so a run touches no RPC endpoint, no price API and no network at all. Provider
 * behaviour belongs to the unit suite and to live smoke tests.
 *
 * Kept out of `pnpm verify`: verify must stay fast and free of a browser
 * download. CI runs this as its own job.
 */

/**
 * Not 3000. A developer's own `pnpm dev` usually owns that port, and a suite
 * that quietly attached to it would be testing whatever code that server has
 * loaded rather than a fresh build of the working tree.
 */
const PORT = 3100;
/**
 * `localhost`, not `127.0.0.1`. This mattered acutely against the dev server,
 * which treats an unlisted numeric host as cross-origin and serves a page that
 * never hydrates. Kept for the built server too: `e2e/fixtures.ts` pins this
 * exact origin when deciding which requests to answer.
 */
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // Vitest owns `src/**/*.test.ts`, this suite owns `e2e/**/*.spec.ts`. The two
  // patterns cannot overlap, so neither runner can pick up the other's tests.
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  // One retry in CI absorbs a cold-compile timeout on a shared runner; locally a
  // flake should be seen rather than smoothed over.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  /*
   * A production server serves precompiled routes, so no test pays a first-hit
   * compile — but the whole first wave of workers still races the same freshly
   * booted server, and each of those page loads was measured at 22-24 s locally
   * against a 30 s ceiling. Tests in the second wave, hitting a warm server, take
   * 1-2 s. That margin was thin enough to fail intermittently, so the ceiling
   * covers the cold wave rather than the warm case.
   */
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    // A wiring failure is only diagnosable with the trace; a passing run does
    // not need the bytes.
    trace: 'retain-on-failure',
  },
  // Chromium only: whether the app is wired up correctly is not a per-engine
  // property, and cross-browser rendering is not the risk this suite addresses.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    /*
     * A production server, not `next dev`, for a reason that bites in practice:
     * Next.js allows only one dev server per project directory, so
     * `pnpm test:e2e` failed outright whenever a developer already had `pnpm dev`
     * running — which is most of the time. `next start` has no such lock.
     *
     * It is also the more faithful target. This suite asserts wiring, and the
     * wiring that ships is the built output, not the dev server's.
     */
    command: `pnpm build && pnpm start --port ${PORT}`,
    url: BASE_URL,
    // Locally, reuse a server already listening on this port; in CI there is
    // never one, and silently reusing something would hide a startup failure.
    reuseExistingServer: !process.env.CI,
    // Covers a cold `next build` plus boot on a shared runner.
    timeout: 180_000,
    env: { NEXT_TELEMETRY_DISABLED: '1' },
  },
});
