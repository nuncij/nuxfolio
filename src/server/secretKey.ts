import 'server-only';

import { timingSafeEqual } from 'node:crypto';

/**
 * The key posture every locked route shares (`/api/snapshot`, `/api/manual`
 * writes): constant-time comparison so the response time says nothing about how
 * much of the key was right, and lengths compared first because
 * `timingSafeEqual` throws on a mismatch. Callers answer 404 — not 401 — on
 * every failure: an endpoint that announces itself as merely locked is an
 * invitation to try the lock.
 */
export function presentedKeyMatches(presented: string | null, expected: string): boolean {
  if (presented === null) {
    return false;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
