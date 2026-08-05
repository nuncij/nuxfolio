import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `scripts/` is the build-free zone — plain `.mjs` run straight from `node` in
    // CI, so nothing there can be TypeScript. Its logic is still tested, and by the
    // same `pnpm verify` gate as everything else.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
    // Provider adapters must never reach the network in tests; every test that
    // needs a response injects its own fetch implementation. Enforced rather than
    // merely intended — see the file for what got past the comment.
    setupFiles: ['./src/test/noNetwork.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // `server-only` throws by design outside a React Server Component graph.
      // Point it at the package's own no-op build so server modules stay
      // testable while keeping the client-import guard in the Next.js build.
      'server-only': fileURLToPath(new URL('./node_modules/server-only/empty.js', import.meta.url)),
    },
  },
});
