import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiErrorSchema } from '@/domain/portfolio';
import { TEST_ADDRESS } from '@/test/helpers';

/**
 * API route contract tests.
 *
 * Only the paths that reject before any upstream work are exercised here, which
 * is deliberate: a test that reached a provider would depend on the network. The
 * orchestration behind a successful response is covered with injected fakes in
 * `portfolioService.test.ts`.
 *
 * The route holds a module-scoped rate limiter built from the environment, so
 * each test imports a fresh module graph.
 */

async function loadRoute(env: Record<string, string> = {}) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return import('./route');
}

function request(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://nuxfolio.test/api/portfolio${query}`, { headers });
}

beforeEach(() => {
  vi.stubEnv('LOG_LEVEL', 'error');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('GET /api/portfolio', () => {
  it('rejects a missing address with a usable message', async () => {
    const { GET } = await loadRoute();
    const response = await GET(request(''));

    expect(response.status).toBe(400);
    const payload = apiErrorSchema.parse(await response.json());
    expect(payload.error.code).toBe('invalid-address');
    expect(payload.error.message).toMatch(/address/i);
  });

  it('rejects a malformed address', async () => {
    const { GET } = await loadRoute();
    const response = await GET(request('?address=0x1234'));

    expect(response.status).toBe(400);
    const payload = apiErrorSchema.parse(await response.json());
    expect(payload.error.code).toBe('invalid-address');
  });

  it('rejects an ENS name, pointing the caller at a 0x address', async () => {
    const { GET } = await loadRoute();
    const response = await GET(request('?address=vitalik.eth'));

    expect(response.status).toBe(400);
    const payload = apiErrorSchema.parse(await response.json());
    expect(payload.error.message).toContain('0x');
  });

  it('rejects a non-numeric chain id', async () => {
    const { GET } = await loadRoute();
    const response = await GET(request(`?address=${TEST_ADDRESS}&chainId=mainnet`));

    expect(response.status).toBe(400);
    const payload = apiErrorSchema.parse(await response.json());
    expect(payload.error.code).toBe('invalid-chain');
  });

  it('rejects an unregistered chain before doing any upstream work', async () => {
    const { GET } = await loadRoute();
    const response = await GET(request(`?address=${TEST_ADDRESS}&chainId=424242`));

    expect(response.status).toBe(400);
    const payload = apiErrorSchema.parse(await response.json());
    expect(payload.error.code).toBe('unsupported-chain');
  });

  it('validates the address before the chain, so the clearest error wins', async () => {
    const { GET } = await loadRoute();
    const response = await GET(request('?address=nonsense&chainId=424242'));

    const payload = apiErrorSchema.parse(await response.json());
    expect(payload.error.code).toBe('invalid-address');
  });

  describe('rate limiting', () => {
    it('answers 429 with Retry-After once the limit is spent', async () => {
      const { GET } = await loadRoute({
        RATE_LIMIT_MAX_REQUESTS: '1',
        RATE_LIMIT_WINDOW_SECONDS: '60',
        TRUST_PROXY_HEADERS: 'true',
      });

      const headers = { 'x-forwarded-for': '203.0.113.7' };
      const first = await GET(request('?address=bad', headers));
      const second = await GET(request('?address=bad', headers));

      // The first request is counted even though it was rejected: rate limiting
      // has to run before validation, or invalid requests would be free.
      expect(first.status).toBe(400);
      expect(second.status).toBe(429);
      expect(second.headers.get('retry-after')).toBe('60');

      const payload = apiErrorSchema.parse(await second.json());
      expect(payload.error.code).toBe('rate-limited');
    });

    it('counts trusted clients separately', async () => {
      const { GET } = await loadRoute({
        RATE_LIMIT_MAX_REQUESTS: '1',
        TRUST_PROXY_HEADERS: 'true',
      });

      await GET(request('?address=bad', { 'x-forwarded-for': '203.0.113.7' }));
      const other = await GET(request('?address=bad', { 'x-forwarded-for': '198.51.100.2' }));

      expect(other.status).toBe(400);
    });

    it('cannot be bypassed by rotating a forwarded header when no proxy is trusted', async () => {
      const { GET } = await loadRoute({
        RATE_LIMIT_MAX_REQUESTS: '1',
        TRUST_PROXY_HEADERS: 'false',
      });

      // Every request claims a different client. Untrusted, they all land in the
      // shared bucket, whose ceiling is 10x the per-client limit — so the 11th
      // is blocked despite each request presenting a fresh identity.
      const statuses: number[] = [];
      for (let index = 0; index < 11; index += 1) {
        const response = await GET(
          request('?address=bad', { 'x-forwarded-for': `203.0.113.${index}` }),
        );
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 400));
      expect(statuses[10]).toBe(429);
    });
  });

  it('never includes provider internals in an error body', async () => {
    const { GET } = await loadRoute();
    const response = await GET(request('?address=0xnope'));
    const body = await response.text();

    expect(body).not.toMatch(/llama|alchemy|publicnode|https?:\/\//i);
    expect(Object.keys(JSON.parse(body) as object)).toEqual(['error']);
  });
});
