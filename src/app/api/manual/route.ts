import { getServerEnv, type ServerEnv } from '@/config/env';
import { dataDir } from '@/config/history';
import { manualEntryInputSchema, valueManualEntries } from '@/domain/manual';
import { fetchManualRefPrices } from '@/providers/prices/defiLlama';
import { selectRateProvider } from '@/providers/registry';
import type { ProviderContext } from '@/providers/types';
import { Deadline } from '@/server/deadline';
import type { Logger } from '@/server/logger';
import { getLogger } from '@/server/portfolioService';
import { presentedKeyMatches } from '@/server/secretKey';
import { openSnapshotStore } from '@/server/snapshotStore';

/**
 * `/api/manual` — the owner's asserted balances. See `docs/MANUAL_ENTRIES_PLAN.md`.
 *
 * **Reads are open, writes are locked.** The tailnet can read every page this app
 * serves, so `GET` answers like the rest of the site. `POST` and `DELETE` change what
 * the owner's records say and require `x-manual-key` matching `NUXFOLIO_EDIT_KEY` —
 * 404 on every failure, the `/api/snapshot` posture, for the same reason: an endpoint
 * that announces itself as merely locked is an invitation to try the lock.
 *
 * **The server validates; the form merely helps.** Every write passes
 * `manualEntryInputSchema` — a malformed quantity is refused, never coerced, because an
 * asserted balance is the one number nothing else can cross-check (round 16).
 */

export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const env = getServerEnv();
  const logger = getLogger(env);
  const store = openSnapshotStore(dataDir());

  try {
    const entries = store.listManualEntries();
    if (entries.length === 0) {
      return Response.json({ entries: [], totalValueUsd: null, fxRate: null });
    }

    const context = providerContext(env, logger);
    const refs = entries
      .map((entry) => entry.priceRef)
      .filter((ref): ref is string => ref !== null);
    const quotes = await fetchManualRefPrices({ refs, context });

    const valued = valueManualEntries(entries, quotes, {
      now: Date.now(),
      confidenceMin: env.PRICE_CONFIDENCE_MIN,
      maxAgeSeconds: env.PRICE_MAX_AGE_SECONDS,
    });

    // The euro preference must work here or this page is not part of the product.
    // A rate that cannot be fetched degrades to USD-only, exactly as elsewhere.
    const fxRate = await selectRateProvider(env)
      .fetchRate({ context })
      .catch(() => null);

    return Response.json({
      entries: valued.entries,
      totalValueUsd: valued.totalValueUsd,
      fxRate,
    });
  } finally {
    store.close();
  }
}

export async function POST(request: Request): Promise<Response> {
  const env = getServerEnv();
  const locked = requireEditKey(request, env);
  if (locked !== null) {
    return locked;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalid('The request body is not JSON.');
  }

  const parsed = manualEntryInputSchema.safeParse(body);
  if (!parsed.success) {
    return invalid(parsed.error.issues[0]?.message ?? 'The entry is not valid.');
  }

  const store = openSnapshotStore(dataDir());
  try {
    const id = store.upsertManualEntry({
      id: parsed.data.id,
      label: parsed.data.label,
      symbol: parsed.data.symbol,
      priceRef: parsed.data.priceRef,
      quantity: parsed.data.quantity,
      updatedAt: new Date().toISOString(),
    });
    if (id === null) {
      return invalid('No entry has that id.');
    }
    return Response.json({ id });
  } finally {
    store.close();
  }
}

export async function DELETE(request: Request): Promise<Response> {
  const env = getServerEnv();
  const locked = requireEditKey(request, env);
  if (locked !== null) {
    return locked;
  }

  const raw = new URL(request.url).searchParams.get('id');
  const id = raw === null ? Number.NaN : Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    return invalid('Expected a positive integer id.');
  }

  const store = openSnapshotStore(dataDir());
  try {
    if (!store.deleteManualEntry(id)) {
      return invalid('No entry has that id.');
    }
    return Response.json({ deleted: id });
  } finally {
    store.close();
  }
}

/** Null when the write may proceed; the 404 response otherwise. */
function requireEditKey(request: Request, env: ServerEnv): Response | null {
  const expected = env.NUXFOLIO_EDIT_KEY;
  if (expected === undefined || expected.length === 0) {
    return new Response(null, { status: 404 });
  }
  if (!presentedKeyMatches(request.headers.get('x-manual-key'), expected)) {
    return new Response(null, { status: 404 });
  }
  return null;
}

function invalid(message: string): Response {
  return Response.json({ error: { code: 'invalid-entry', message } }, { status: 400 });
}

function providerContext(env: ServerEnv, logger: Logger): ProviderContext {
  return {
    deadline: new Deadline(env.REQUEST_DEADLINE_MS),
    fetch: globalThis.fetch,
    logger,
    maxAssets: env.MAX_ASSETS_PER_PORTFOLIO,
    tokenListMaxAgeDays: env.TOKEN_LIST_MAX_AGE_DAYS,
  };
}
