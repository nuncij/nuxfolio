import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The lock on the one route that writes. Every case here is a control that must fail
 * when disabled: review round 15 noted the suite never exercised this route at all,
 * which is how a 404 quietly becoming a 401 — or the key check disappearing — would
 * have passed.
 */

const KEY = 'correct-horse-battery-staple';

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

beforeEach(() => {
  vi.stubEnv('LOG_LEVEL', 'error');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
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
    expect(await response.json()).toEqual({ captured: 0, skipped: 0 });
  });
});
