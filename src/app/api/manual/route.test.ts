import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openSnapshotStore } from '@/server/snapshotStore';

/**
 * The write gate and the validation, against a real SQLite file. Prices and the
 * euro rate are mocked at the provider modules: this suite is about the route's
 * contract, and a network call inside it would test the weather.
 */

const KEY = 'correct-horse-battery-staple';

vi.mock('@/providers/prices/defiLlama', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchManualRefPrices: async () =>
    new Map([['coingecko:bitcoin', { priceUsd: '60000', updatedAt: null, confidence: 0.99 }]]),
}));

// Mocked wholesale, without importOriginal: the real registry drags every
// bundled token list through zod, which is seconds of work repeated per test
// because each one resets the module graph. The route uses only this export.
vi.mock('@/providers/registry', () => ({
  selectRateProvider: () => ({
    id: 'test-rates',
    fetchRate: async () => ({ base: 'EUR', quote: 'USD', rate: '1.25', asOf: '2026-08-13' }),
  }),
}));

// Importing the route still parses the server env and its neighbours on every
// module reset; with eight bundled token lists in the graph the default 5 s is
// too tight on a busy worker.
vi.setConfig({ testTimeout: 20_000 });

let dir: string;

async function loadRoute() {
  vi.resetModules();
  return import('./route');
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://nuxfolio.test/api/manual', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

const VALID = { label: 'Binance', symbol: 'BTC', quantity: '0.5', priceRef: 'coingecko:bitcoin' };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuxfolio-manual-'));
  vi.stubEnv('NUXFOLIO_DATA_DIR', dir);
  vi.stubEnv('NUXFOLIO_EDIT_KEY', KEY);
  vi.stubEnv('LOG_LEVEL', 'error');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

describe('POST /api/manual', () => {
  it('answers 404 without the key, and writes nothing', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post(VALID));

    expect(response.status).toBe(404);
    const store = openSnapshotStore(dir);
    expect(store.listManualEntries()).toEqual([]);
    store.close();
  });

  it('answers 404 to a wrong key', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post(VALID, { 'x-manual-key': KEY.replace(/e/g, '3') }));

    expect(response.status).toBe(404);
  });

  it('answers 404 when no key is configured, even to a caller presenting one', async () => {
    vi.stubEnv('NUXFOLIO_EDIT_KEY', '');
    const { POST } = await loadRoute();
    const response = await POST(post(VALID, { 'x-manual-key': KEY }));

    expect(response.status).toBe(404);
  });

  it('refuses a malformed quantity with a usable message', async () => {
    const { POST } = await loadRoute();
    const response = await POST(post({ ...VALID, quantity: '-1' }, { 'x-manual-key': KEY }));

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/positive/);
  });

  it('creates, updates by id, and refuses an id that does not exist', async () => {
    const { POST } = await loadRoute();

    const created = await POST(post(VALID, { 'x-manual-key': KEY }));
    expect(created.status).toBe(200);
    const { id } = (await created.json()) as { id: number };

    const updated = await POST(post({ ...VALID, id, quantity: '0.75' }, { 'x-manual-key': KEY }));
    expect(updated.status).toBe(200);

    const missing = await POST(post({ ...VALID, id: 9999 }, { 'x-manual-key': KEY }));
    expect(missing.status).toBe(400);

    const store = openSnapshotStore(dir);
    expect(store.listManualEntries()).toHaveLength(1);
    expect(store.listManualEntries()[0]?.quantity).toBe('0.75');
    store.close();
  });
});

describe('GET /api/manual', () => {
  it('answers empty without touching any provider', async () => {
    const { GET } = await loadRoute();
    const response = await GET();

    expect(await response.json()).toEqual({ entries: [], totalValueUsd: null, fxRate: null });
  });

  it('values entries at the mocked market price and carries the euro rate', async () => {
    const { GET, POST } = await loadRoute();
    await POST(post(VALID, { 'x-manual-key': KEY }));

    const body = (await (await GET()).json()) as {
      entries: readonly { valueUsd: string | null }[];
      totalValueUsd: string | null;
      fxRate: { rate: string } | null;
    };

    expect(body.entries[0]?.valueUsd).toBe('30000.00000000');
    expect(body.totalValueUsd).toBe('30000.00000000');
    expect(body.fxRate?.rate).toBe('1.25');
  });
});

describe('DELETE /api/manual', () => {
  it('is key-gated and removes exactly the named entry', async () => {
    const { DELETE, POST } = await loadRoute();
    const created = await POST(post(VALID, { 'x-manual-key': KEY }));
    const { id } = (await created.json()) as { id: number };

    const unauthorised = await DELETE(
      new Request(`https://nuxfolio.test/api/manual?id=${id}`, { method: 'DELETE' }),
    );
    expect(unauthorised.status).toBe(404);

    const deleted = await DELETE(
      new Request(`https://nuxfolio.test/api/manual?id=${id}`, {
        method: 'DELETE',
        headers: { 'x-manual-key': KEY },
      }),
    );
    expect(deleted.status).toBe(200);

    const store = openSnapshotStore(dir);
    expect(store.listManualEntries()).toEqual([]);
    store.close();
  });
});
