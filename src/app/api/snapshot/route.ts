import { timingSafeEqual } from 'node:crypto';

import { getServerEnv } from '@/config/env';
import { dataDir, trackedWallets } from '@/config/history';
import { getAggregatePortfolio, getLogger } from '@/server/portfolioService';
import { captureSnapshots } from '@/server/snapshotJob';
import { openSnapshotStore } from '@/server/snapshotStore';

/**
 * `POST /api/snapshot` — takes today's reading for the tracked wallets.
 *
 * Triggered by a systemd timer on the host, not by a `setInterval` inside the app: a
 * redeploy restarts the process and would silently lose an in-process schedule, and the
 * one property this job needs is that a missed or repeated run costs nothing. The store
 * is keyed on the UTC day, so running it twice writes the same rows.
 *
 * **Not reachable without the key.** Caddy serves this app to the whole tailnet, so
 * "internal" is not a property of the network here. Without `NUXFOLIO_SNAPSHOT_KEY`
 * configured the route reports 404 rather than 401 — an endpoint that announces itself as
 * merely locked is an invitation to try the lock.
 *
 * **POST, and no reply body worth reading.** The job writes; the timer only needs to know
 * whether it worked.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const env = getServerEnv();
  const expected = env.NUXFOLIO_SNAPSHOT_KEY;

  if (expected === undefined || expected.length === 0) {
    // History is not configured on this deployment. Nothing to protect, nothing to say.
    return new Response(null, { status: 404 });
  }

  if (!presentedKeyMatches(request.headers.get('x-snapshot-key'), expected)) {
    return new Response(null, { status: 404 });
  }

  const logger = getLogger(env);
  const wallets = trackedWallets();

  if (wallets.length === 0) {
    logger.info('snapshot.nothing_tracked', {});
    return Response.json({ captured: 0, skipped: 0 });
  }

  const store = openSnapshotStore(dataDir());

  try {
    const outcome = await captureSnapshots({
      wallets,
      store,
      logger,
      now: () => new Date(),
      // The lean load. A snapshot stores a total, two counts and a coverage flag, so the
      // second price opinion, the historical price batches and the euro rate are all work
      // whose answers are thrown away — and the first of them spends a quota ADR-019
      // budgets for real visitors.
      load: async (address) => {
        const { aggregate } = await getAggregatePortfolio(address, {
          env: { ...env, PRICE_HISTORY_MAX_ASSETS: 0 },
          logger,
          priceVerifier: null,
          rateProvider: null,
        });
        return aggregate;
      },
    });

    return Response.json({ captured: outcome.captured, skipped: outcome.skipped.length });
  } finally {
    store.close();
  }
}

/**
 * Constant-time comparison, so the response time says nothing about how much of the key
 * was right. Lengths are compared first because `timingSafeEqual` throws on a mismatch.
 */
function presentedKeyMatches(presented: string | null, expected: string): boolean {
  if (presented === null) {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
