import { dataDir, trackedWallets } from '@/config/history';
import { parseWalletAddress } from '@/domain/address';
import { toHistorySeries } from '@/domain/history';
import { openSnapshotStore } from '@/server/snapshotStore';

/**
 * `GET /api/history?address=0x…`
 *
 * What has been recorded for one wallet, one point per UTC day.
 *
 * **Only for a tracked wallet.** Answering for any address would turn the snapshot table
 * into a lookup of which wallets this deployment has ever recorded — a question nobody
 * outside it should be able to ask, and one the store exists to answer for its owner
 * rather than about them. An untracked address gets an empty series, not a 403, and the
 * store is queried either way so the response time does not say what the body declined
 * to. What this cannot hide: a currently tracked wallet with recorded days answers with
 * them, which is the feature. The guard is for everyone else — delisted wallets whose
 * rows remain, and the question "is this address one of the owner's".
 *
 * No rate limiter of its own. It reads a local file and issues no upstream call, so the
 * cost of a request is a disk read — unlike `/api/portfolio`, which fans out to providers
 * and is limited for that reason.
 */

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const parsed = parseWalletAddress(params.get('address')?.trim() ?? '');

  if (!parsed.ok) {
    return Response.json({ points: [] });
  }

  // The page shows one chain at a time, so the chart must answer for that chain — a
  // five-chain sum next to a one-chain header is two different numbers with no label
  // saying so. No parameter means the aggregate view.
  const rawChainId = params.get('chainId');
  const only = rawChainId === null ? null : Number(rawChainId);
  if (only !== null && !Number.isInteger(only)) {
    return Response.json({ points: [] });
  }

  const tracked = trackedWallets().some(
    (wallet) => wallet.toLowerCase() === parsed.address.toLowerCase(),
  );

  const store = openSnapshotStore(dataDir());
  try {
    // Queried before the tracked check is applied, not after it short-circuits:
    // answering instantly for untracked addresses and slowly for tracked ones would
    // let a stopwatch ask the question the empty body refuses to answer (round 15).
    const rows = store.history(parsed.address);
    const scoped = only === null ? rows : rows.filter((row) => row.chainId === only);
    return Response.json({ points: tracked ? toHistorySeries(scoped) : [] });
  } finally {
    store.close();
  }
}
