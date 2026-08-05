/**
 * One wall-clock budget shared by every upstream call a request makes.
 *
 * Without this, per-request timeouts multiply: three retries against two
 * providers can keep a connection open far longer than any user will wait. The
 * deadline is created once per API request and threaded through the provider
 * context, so retries and fan-out spend from the same budget.
 */
export class Deadline {
  private readonly expiresAt: number;

  constructor(budgetMs: number, now: number = Date.now()) {
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
      throw new RangeError(`Deadline budget must be a positive number of ms: ${budgetMs}`);
    }
    this.expiresAt = now + budgetMs;
  }

  remainingMs(now: number = Date.now()): number {
    return Math.max(0, this.expiresAt - now);
  }

  hasExpired(now: number = Date.now()): boolean {
    return this.remainingMs(now) <= 0;
  }

  /**
   * The timeout to apply to a single attempt: the smaller of the caller's
   * preferred timeout and what is left of the overall budget.
   */
  timeoutForAttempt(preferredMs: number, now: number = Date.now()): number {
    return Math.min(preferredMs, this.remainingMs(now));
  }
}
