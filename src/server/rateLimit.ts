/**
 * Fixed-window rate limiting for the public API route.
 *
 * The counter map is bounded and pruned for the same reason the cache is: the
 * key is caller-influenced, so unbounded growth is a denial-of-service vector
 * rather than a memory-tuning detail.
 *
 * Clients whose identity cannot be established share the `unknown` bucket. That
 * bucket gets its own, higher allowance — otherwise a single anonymous caller
 * could exhaust the per-client limit and lock out every other anonymous caller,
 * turning the protection into the attack. See docs/DECISIONS.md, ADR-008.
 */

export const UNKNOWN_CLIENT_ID = 'unknown';

export type RateLimitDecision = {
  allowed: boolean;
  /** Requests left in the current window. */
  remaining: number;
  /** Seconds until the window resets — the `Retry-After` value. */
  resetInSeconds: number;
  limit: number;
};

export type RateLimiterOptions = {
  maxRequests: number;
  windowMs: number;
  /** Allowance for the shared `unknown` bucket. Defaults to 10x maxRequests. */
  unknownMaxRequests?: number;
  maxTrackedClients?: number;
};

export class FixedWindowRateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly maxRequests: number;
  private readonly unknownMaxRequests: number;
  private readonly windowMs: number;
  private readonly maxTrackedClients: number;

  constructor(options: RateLimiterOptions) {
    if (options.maxRequests <= 0 || options.windowMs <= 0) {
      throw new RangeError('Rate limit and window must both be positive');
    }
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.unknownMaxRequests = options.unknownMaxRequests ?? options.maxRequests * 10;
    this.maxTrackedClients = options.maxTrackedClients ?? 10_000;
  }

  check(clientId: string, now: number = Date.now()): RateLimitDecision {
    const limit = clientId === UNKNOWN_CLIENT_ID ? this.unknownMaxRequests : this.maxRequests;
    const existing = this.windows.get(clientId);

    if (!existing || existing.resetAt <= now) {
      this.windows.delete(clientId);
      this.windows.set(clientId, { count: 1, resetAt: now + this.windowMs });
      this.prune(now);
      return {
        allowed: true,
        remaining: limit - 1,
        resetInSeconds: Math.ceil(this.windowMs / 1000),
        limit,
      };
    }

    const resetInSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

    if (existing.count >= limit) {
      return { allowed: false, remaining: 0, resetInSeconds, limit };
    }

    existing.count += 1;
    return { allowed: true, remaining: limit - existing.count, resetInSeconds, limit };
  }

  size(): number {
    return this.windows.size;
  }

  clear(): void {
    this.windows.clear();
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) {
        this.windows.delete(key);
      }
    }
    while (this.windows.size > this.maxTrackedClients) {
      const oldest = this.windows.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.windows.delete(oldest.value);
    }
  }
}

/**
 * Resolves the client identity used for rate limiting.
 *
 * Forwarding headers are caller-controlled. Trusting them by default would let
 * anyone send a random `x-forwarded-for` per request and bypass the limiter
 * entirely — protection that looks real and is not. So they are read only when
 * an operator has confirmed a proxy overwrites them.
 */
export function resolveClientId(input: {
  headers: Headers;
  trustProxyHeaders: boolean;
  clientIpHeader: string;
}): string {
  if (!input.trustProxyHeaders) {
    return UNKNOWN_CLIENT_ID;
  }
  const raw = input.headers.get(input.clientIpHeader);
  if (!raw) {
    return UNKNOWN_CLIENT_ID;
  }
  // `x-forwarded-for` is a client-to-proxy chain; the left-most entry is the
  // original client as recorded by the trusted proxy.
  const first = raw.split(',')[0]?.trim();
  return first && first.length > 0 && first.length <= 64 ? first : UNKNOWN_CLIENT_ID;
}
