import 'server-only';

import { getServerEnv } from '@/config/env';

import { resolveEnsName, type EnsDependencies, type EnsResolution } from './ens';
import type { Logger } from './logger';
import { getLogger } from './portfolioService';
import { FixedWindowRateLimiter, resolveClientId, UNKNOWN_CLIENT_ID } from './rateLimit';

/**
 * Rate limiting for ENS resolution on the page-render path.
 *
 * This closes what four review rounds and two planning documents called "the one
 * hard prerequisite before going public". `/api/portfolio` has been rate limited
 * since ADR-008 — but `/portfolio/vitalik.eth` resolves the name *while rendering
 * the page*, before any API is involved, and that resolution is an `eth_call`
 * against a real Ethereum endpoint. Unguarded, a stranger with a URL generator
 * chooses how many upstream calls this server makes: `/portfolio/a1.eth`,
 * `/portfolio/a2.eth`, … — each one distinct, so the resolution cache does not
 * help, each one billed against RPC endpoints this deployment may be paying for
 * or sharing fairly with others. On a tailnet-only deployment nobody hostile can
 * reach the page; on a public one this is the first thing a crawler finds.
 *
 * The gate reuses the same limiter class and the same identity rules as the API
 * (trust forwarding headers only when an operator says a proxy overwrites them —
 * see `resolveClientId`), but holds a **separate budget pool**. Sharing the API's
 * limiter instance would mean page lookups and API calls drain one bucket, and a
 * user browsing normally could lock themselves out of their own portfolio data.
 *
 * The order of checks is deliberate: the gate runs **before** the resolution
 * cache, not after a miss. That charges cache hits against the budget too, which
 * is slightly unfair — a hot shared link costs nothing upstream — but the
 * alternative lets an attacker probe which names this server has resolved
 * recently by watching which lookups are free, and fairness to an attacker's
 * probe is not a goal. A legitimate visitor opening shared links sits far under
 * the default budget (30 per minute).
 */

let defaultLimiter: FixedWindowRateLimiter | undefined;

function getEnsLimiter(): FixedWindowRateLimiter {
  const env = getServerEnv();
  defaultLimiter ??= new FixedWindowRateLimiter({
    // The API's knobs, on purpose: one pair of numbers for an operator to reason
    // about, two independent pools spending them.
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    windowMs: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
  });
  return defaultLimiter;
}

/** Visible for tests: forgets every window. */
export function resetEnsGate(): void {
  defaultLimiter = undefined;
}

export type EnsGateDependencies = {
  /** Injected by tests; production uses the module-level instance. */
  limiter?: FixedWindowRateLimiter;
  /** Injected by tests; production resolves through {@link resolveEnsName}. */
  resolve?: (name: string, dependencies?: EnsDependencies) => Promise<EnsResolution>;
  trustProxyHeaders?: boolean;
  clientIpHeader?: string;
  logger?: Logger;
};

/**
 * Resolves an ENS name only when the caller still has budget for it.
 *
 * Takes the request's `Headers` rather than reading `next/headers` itself, so the
 * decision is testable outside a request scope — the page passes them in, and only
 * on the name path, which keeps plain `0x…` renders from touching request state
 * at all.
 */
export async function resolveEnsNameGated(
  name: string,
  requestHeaders: Headers,
  dependencies: EnsGateDependencies = {},
): Promise<EnsResolution> {
  const env = getServerEnv();

  const clientId = resolveClientId({
    headers: requestHeaders,
    trustProxyHeaders: dependencies.trustProxyHeaders ?? env.TRUST_PROXY_HEADERS,
    clientIpHeader: dependencies.clientIpHeader ?? env.CLIENT_IP_HEADER,
  });

  const limiter = dependencies.limiter ?? getEnsLimiter();
  const decision = limiter.check(clientId);

  if (!decision.allowed) {
    // The same operator signal the API emits, so one log query finds both.
    (dependencies.logger ?? getLogger()).warn('ens.rate_limited', {
      clientIdentified: clientId !== UNKNOWN_CLIENT_ID,
      limit: decision.limit,
    });

    return {
      ok: false,
      reason: 'rate-limited',
      message:
        `Too many name lookups from your connection — wait about ` +
        `${decision.resetInSeconds} second${decision.resetInSeconds === 1 ? '' : 's'} ` +
        `and try again, or enter the 0x address directly.`,
    };
  }

  const resolve = dependencies.resolve ?? resolveEnsName;
  return resolve(name);
}
