import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HistoryPoint } from '@/domain/history';
import { openSnapshotStore, type Snapshot } from '@/server/snapshotStore';
import { TEST_ADDRESS } from '@/test/helpers';

/**
 * Against a real SQLite file, because the route's job is glue: env → store → series. The
 * chain filter earns the coverage — it shipped once referencing a variable that did not
 * exist, and only the type checker noticed.
 */

let dir: string;

async function loadRoute() {
  vi.resetModules();
  return import('./route');
}

function request(query: string): Request {
  return new Request(`https://nuxfolio.test/api/history${query}`);
}

function row(chainId: number, totalValueUsd: string): Snapshot {
  return {
    address: TEST_ADDRESS,
    chainId,
    capturedAt: '2026-08-09T06:00:00.000Z',
    totalValueUsd,
    netOfAaveDebtUsd: totalValueUsd,
    assetCount: 1,
    pricedCount: 1,
    coverage: 'complete',
  };
}

async function points(response: Response): Promise<readonly HistoryPoint[]> {
  const body = (await response.json()) as { points: readonly HistoryPoint[] };
  return body.points;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nuxfolio-history-'));
  vi.stubEnv('NUXFOLIO_DATA_DIR', dir);
  vi.stubEnv('NUXFOLIO_TRACKED_WALLETS', TEST_ADDRESS);

  const store = openSnapshotStore(dir);
  store.record([row(1, '100.5'), row(42161, '9.25')]);
  store.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/history', () => {
  it('sums every chain when no chain is asked for', async () => {
    const { GET } = await loadRoute();
    const series = await points(await GET(request(`?address=${TEST_ADDRESS}`)));

    expect(series).toHaveLength(1);
    expect(series[0]?.totalValueUsd).toBe('109.75');
    expect(series[0]?.chainCount).toBe(2);
  });

  it('answers for one chain when the page shows one chain', async () => {
    const { GET } = await loadRoute();
    const series = await points(await GET(request(`?address=${TEST_ADDRESS}&chainId=1`)));

    expect(series).toHaveLength(1);
    expect(series[0]?.totalValueUsd).toBe('100.5');
    expect(series[0]?.chainCount).toBe(1);
  });

  it('answers empty for a chain with no rows, not the aggregate', async () => {
    const { GET } = await loadRoute();
    const series = await points(await GET(request(`?address=${TEST_ADDRESS}&chainId=10`)));

    expect(series).toHaveLength(0);
  });

  it('answers empty for a chain id that is not a number', async () => {
    const { GET } = await loadRoute();

    for (const junk of ['mainnet', '1abc']) {
      const series = await points(await GET(request(`?address=${TEST_ADDRESS}&chainId=${junk}`)));
      expect(series).toHaveLength(0);
    }
  });

  it('answers empty for an untracked wallet, identically to one with no history', async () => {
    const { GET } = await loadRoute();
    const other = '0x1111111111111111111111111111111111111111';
    const series = await points(await GET(request(`?address=${other}`)));

    expect(series).toHaveLength(0);
  });
});
