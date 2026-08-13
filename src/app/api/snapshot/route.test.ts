import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The lock on the one route that writes. Every case here is a control that must fail
 * when disabled: review round 15 noted the suite never exercised this route at all,
 * which is how a 404 quietly becoming a 401 — or the key check disappearing — would
 * have passed.
 */

const KEY = 'correct-horse-battery-staple';

// Each test resets the module graph, and importing the route re-parses all
// eight bundled token lists through zod — seconds of work the default 5 s
// timeout no longer covers since the 2026-08-12 chains landed.
vi.setConfig({ testTimeout: 20_000 });

async function loadRoute(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return import('./route');
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://nuxfolio.test/api/snapshot', { method: 'POST', headers });
}

let dir: string;

beforeEach(() => {
  // A real directory even for the auth tests: the route now opens the store
  // whenever a run happens, because the manual pseudo-row is independent of the
  // wallet list (round 16), and the default data dir must not appear in the repo.
  dir = mkdtempSync(join(tmpdir(), 'nuxfolio-snapshot-'));
  vi.stubEnv('NUXFOLIO_DATA_DIR', dir);
  vi.stubEnv('LOG_LEVEL', 'error');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/snapshot', () => {
  it('answers 404 when no key is configured, even to a caller presenting one', async () => {
    const { POST } = await loadRoute();
    const response = await POST(request({ 'x-snapshot-key': KEY }));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('answers 404 without the header', async () => {
    const { POST } = await loadRoute({ NUXFOLIO_SNAPSHOT_KEY: KEY });
    const response = await POST(request());

    expect(response.status).toBe(404);
  });

  it('answers 404 to a wrong key of the same length', async () => {
    const { POST } = await loadRoute({ NUXFOLIO_SNAPSHOT_KEY: KEY });
    const response = await POST(request({ 'x-snapshot-key': KEY.replace(/e/g, '3') }));

    expect(response.status).toBe(404);
  });

  it('answers 404, not an exception, to a key of a different length', async () => {
    // timingSafeEqual throws on mismatched lengths; the length guard in front of it is
    // the thing under test.
    const { POST } = await loadRoute({ NUXFOLIO_SNAPSHOT_KEY: KEY });
    const response = await POST(request({ 'x-snapshot-key': 'short' }));

    expect(response.status).toBe(404);
  });

  it('accepts the right key and reports an empty run when nothing is tracked', async () => {
    const { POST } = await loadRoute({ NUXFOLIO_SNAPSHOT_KEY: KEY, NUXFOLIO_TRACKED_WALLETS: '' });
    const response = await POST(request({ 'x-snapshot-key': KEY }));

    expect(response.status).toBe(200);
    // manual: 'none' — the pseudo-row runs even with zero wallets tracked, and
    // with zero entries it records nothing (round 16).
    expect(await response.json()).toEqual({ captured: 0, skipped: 0, manual: 'none' });
  });
});
