import 'server-only';

import { createPublicClient, fallback, getAddress, http } from 'viem';
import { mainnet } from 'viem/chains';
import { getEnsAddress } from 'viem/ens';

import { getChainConfig } from '@/config/chains';
import type { WalletAddress } from '@/domain/address';
import { parseEnsName } from '@/domain/ensName';
import { ProviderError } from '@/providers/types';

import { TtlCache } from './cache';
import { Deadline } from './deadline';
import type { Logger } from './logger';
import { getLogger } from './portfolioService';

/**
 * ENS name resolution, server side only.
 *
 * The browser never talks to an RPC endpoint: the same privacy posture that keeps
 * price and balance lookups on the server applies to names, which would otherwise
 * tell a third party who is being looked at.
 *
 * Resolution goes through viem's ENS action against the mainnet Universal
 * Resolver, rather than through Nuxfolio's own JSON-RPC layer. That is a
 * deliberate exception: a name may resolve through a wildcard or an offchain
 * (CCIP-read) resolver, and reimplementing that walk over the bespoke requester
 * would mean re-deriving revert semantics that viem already gets right. What the
 * exception costs is retry policy, so the discipline is restored explicitly here:
 * one attempt per endpoint (viem's own retries off), each endpoint capped by the
 * shared deadline, and endpoints tried in configured order.
 *
 * **No endpoint URL ever leaves this module.** viem puts the request URL in its
 * error messages, so upstream error text is never propagated or logged — only the
 * error's class name and our own sentence. Resolved names and addresses are public
 * data, but the logger still shortens addresses on the way out.
 */

const PROVIDER_ID = 'ens';

/**
 * Budget for one resolution. Far shorter than an API request's budget: this runs
 * while a visitor waits on a page that has not started rendering, and a name that
 * cannot be resolved in a couple of seconds is better reported than waited for.
 */
const ENS_BUDGET_MS = 4_000;

/** Per-endpoint timeout, further capped by whatever the budget has left. */
const ENS_ATTEMPT_TIMEOUT_MS = 2_000;

/**
 * Names are cached briefly, not because resolution is expensive but because a
 * shared link gets opened repeatedly, and each open would otherwise cost an
 * `eth_call`. Kept short: an owner who re-points a name should not be shown a
 * stale address for long. Bounded like every other cache here — keys come from
 * the URL, so they are attacker-chosen.
 */
const ENS_CACHE_TTL_MS = 5 * 60_000;
const ENS_CACHE_MAX_ENTRIES = 500;

export type EnsResolution =
  | { ok: true; address: WalletAddress }
  /**
   * `not-found` is an answer about the name; `unavailable` is an admission about
   * Nuxfolio. Both render the same invalid-address page, but only one of them is
   * worth retrying, and telling them apart is the difference between "check the
   * spelling" and "try again".
   *
   * `rate-limited` is produced by the gate in `ensGate.ts`, never by this module:
   * resolution answers "what does this name point at", the gate answers "will we
   * look right now". It is a distinct reason rather than a reuse of `unavailable`
   * because the two ask the visitor for different things — wait, versus try again.
   */
  | { ok: false; reason: 'not-found' | 'unavailable' | 'rate-limited'; message: string };

export type EnsDependencies = {
  /** Ethereum endpoints to try, in order. Defaults to the configured mainnet ones. */
  rpcUrls?: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  logger?: Logger;
  deadline?: Deadline;
  /** Injected so a test can observe cache behaviour without module state. */
  cache?: TtlCache<WalletAddress | null>;
};

let sharedCache: TtlCache<WalletAddress | null> | undefined;

function getCache(): TtlCache<WalletAddress | null> {
  sharedCache ??= new TtlCache<WalletAddress | null>({
    ttlMs: ENS_CACHE_TTL_MS,
    maxEntries: ENS_CACHE_MAX_ENTRIES,
  });
  return sharedCache;
}

/** Visible for tests: drops resolved names. */
export function resetEnsCache(): void {
  sharedCache?.clear();
  sharedCache = undefined;
}

/**
 * Resolves an ENS name to an address, or explains why it could not.
 *
 * Never throws for an upstream failure: a page needs a sentence to render, not an
 * exception to classify. A name that does not resolve is cached as such — a
 * mistyped name in a shared link would otherwise cost an `eth_call` per visit.
 */
export async function resolveEnsName(
  name: string,
  dependencies: EnsDependencies = {},
): Promise<EnsResolution> {
  const parsed = parseEnsName(name);
  if (!parsed.ok) {
    // Defence in depth: callers validate first, and nothing unvalidated should
    // ever reach a contract call. The input is not echoed back.
    return {
      ok: false,
      reason: 'not-found',
      message: 'Nuxfolio looks up ENS names ending in ".eth". Enter one of those, or a 0x address.',
    };
  }

  const cache = dependencies.cache ?? getCache();

  try {
    const { value } = await cache.getOrLoad(parsed.name, () =>
      lookupEnsAddress(parsed.name, dependencies),
    );

    if (value === null) {
      return {
        ok: false,
        reason: 'not-found',
        message: `${parsed.name} could not be resolved to an address. Check the spelling, or enter a 0x address.`,
      };
    }
    return { ok: true, address: value };
  } catch (error) {
    // A failed load is not cached, so the next visit tries again. It is logged
    // because a page that quietly stops resolving names is exactly the kind of
    // outage an operator should not have to hear about from a user.
    const logger = dependencies.logger ?? getLogger();
    logger.warn('ens.lookup_failed', {
      name: parsed.name,
      // Deliberately not the upstream message: viem embeds the endpoint URL in it.
      errorName: error instanceof Error ? error.name : 'NonError',
      kind: error instanceof ProviderError ? error.kind : 'unknown',
    });

    return {
      ok: false,
      reason: 'unavailable',
      message: `${parsed.name} could not be resolved right now: the ENS lookup did not answer. Try again, or enter a 0x address.`,
    };
  }
}

/**
 * One resolution attempt per endpoint. Returns null when the name resolves to
 * nothing, and throws a {@link ProviderError} when the lookup itself failed —
 * the distinction the cache depends on, since only the first may be remembered.
 */
async function lookupEnsAddress(
  name: string,
  dependencies: EnsDependencies,
): Promise<WalletAddress | null> {
  const rpcUrls = dependencies.rpcUrls ?? mainnetRpcUrls();
  if (rpcUrls.length === 0) {
    throw new ProviderError(
      'misconfigured',
      PROVIDER_ID,
      'No Ethereum RPC endpoint is configured for ENS resolution',
    );
  }

  const deadline = dependencies.deadline ?? new Deadline(ENS_BUDGET_MS);
  const timeout = deadline.timeoutForAttempt(ENS_ATTEMPT_TIMEOUT_MS);
  if (timeout <= 0) {
    throw new ProviderError('timeout', PROVIDER_ID, 'ENS budget was spent before the lookup began');
  }

  const client = createPublicClient({
    chain: mainnet,
    /**
     * CCIP-read (ERC-3668 offchain resolution) is disabled deliberately.
     *
     * With it enabled, viem follows a URL returned by the *resolver contract* —
     * i.e. by whoever registered the name — using the global `fetch`, outside
     * both the injected `fetchImpl` and the deadline above. Anyone can register
     * an ENS name whose resolver points at `http://169.254.169.254/…`, so
     * leaving it on would let a visitor's URL make this server issue arbitrary
     * requests from inside its own network. That is server-side request forgery,
     * and the fix is not a URL allow-list bolted onto a page render.
     *
     * The cost is that offchain-resolved names (gasless subdomains, some
     * L2-hosted names) return "not found" rather than an address. Ordinary
     * onchain `.eth` records — what the name pattern accepts — are unaffected.
     * Supporting the rest needs a hardened fetch of its own; see docs/DEV_PLAN.md.
     */
    ccipRead: false,
    transport: fallback(
      rpcUrls.map((url) =>
        http(url, {
          fetchFn: dependencies.fetchImpl,
          timeout,
          // Retries are Nuxfolio's decision, not the transport's: a name lookup
          // gets one attempt per endpoint so the budget buys breadth, not repeats.
          retryCount: 0,
          batch: false,
        }),
      ),
      { retryCount: 0 },
    ),
  });

  try {
    const address = await getEnsAddress(client, { name });
    return address === null ? null : getAddress(address);
  } catch (error) {
    throw new ProviderError(
      'unavailable',
      PROVIDER_ID,
      // Names the class of failure and the name looked up, never the endpoint.
      `ENS lookup for ${name} failed (${error instanceof Error ? error.name : 'NonError'})`,
      { cause: error },
    );
  }
}

/**
 * Ethereum mainnet endpoints from the chain registry — ENS lives on mainnet
 * regardless of which network's portfolio is being viewed.
 */
function mainnetRpcUrls(): readonly string[] {
  return getChainConfig(mainnet.id)?.rpcUrls ?? [];
}
