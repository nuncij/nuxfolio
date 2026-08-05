import type { ProviderErrorKind } from '@/providers/types';

import type { ApiErrorCode } from './portfolio';

/**
 * The sentences a cross-chain view shows for a network it could not read.
 *
 * One list, two callers. The server aggregate classifies a `ProviderError` it
 * caught; the browser's progressive aggregate classifies the API error code of a
 * per-chain request that came back a failure. Both must stay in the same voice,
 * and — the reason this lives in one module rather than in two — neither may
 * ever render an upstream message. Nothing here interpolates anything.
 */

export type ChainFailureKind =
  /** The chain's provider did not answer inside the request deadline. */
  | 'timeout'
  /** An upstream provider is rate limiting Nuxfolio. */
  | 'rate-limited'
  /** Nuxfolio's own request limit was reached before this chain was read. */
  | 'request-limited'
  /** The provider answered, but not with anything readable. */
  | 'invalid-response'
  /** An operator problem rather than a user one. */
  | 'misconfigured'
  /** Transport-level failure: unreachable endpoint, 5xx, dropped connection. */
  | 'unreachable'
  /** Anything that cannot be classified further. */
  | 'unknown';

const CHAIN_FAILURE_MESSAGE: Record<ChainFailureKind, string> = {
  timeout: 'This network took too long to respond and was skipped.',
  'rate-limited': 'This network is rate limiting Nuxfolio right now and was skipped.',
  'request-limited':
    "Nuxfolio's own request limit was reached before this network loaded. Try again in a moment.",
  'invalid-response': 'This network returned data Nuxfolio could not read and was skipped.',
  misconfigured: 'This network is not configured correctly and was skipped.',
  unreachable: 'This network could not be reached and was skipped.',
  unknown: 'This network could not be loaded and was skipped.',
};

export function chainFailureMessage(kind: ChainFailureKind): string {
  return CHAIN_FAILURE_MESSAGE[kind];
}

/** Server side: what the aggregate loader caught from a provider. */
export function chainFailureKindFromProviderError(kind: ProviderErrorKind): ChainFailureKind {
  return kind === 'unavailable' ? 'unreachable' : kind;
}

/**
 * Browser side: what one failed per-chain response tells us.
 *
 * The mapping is coarser than the server's on purpose, because the wire format
 * is coarser: a misconfigured provider reaches the browser as `internal`, which
 * is indistinguishable from any other server-side fault, so it is reported as
 * the unclassified failure it is rather than guessed at. The two rate-limit
 * codes stay distinct — `rate-limited` is Nuxfolio's own limiter refusing the
 * request, and blaming the network for that would be wrong.
 *
 * `invalid-address`, `invalid-chain` and `unsupported-chain` are not reachable
 * from a view whose address the server already validated and whose chain ids
 * come from the server's own registry; they are mapped rather than special-cased
 * so that a future mismatch degrades to one skipped network instead of a
 * rendering hole.
 */
export function chainFailureKindFromApiError(code: ApiErrorCode): ChainFailureKind {
  switch (code) {
    case 'timeout':
      return 'timeout';
    case 'upstream-rate-limited':
      return 'rate-limited';
    case 'rate-limited':
      return 'request-limited';
    case 'upstream-invalid-response':
      return 'invalid-response';
    case 'upstream-unavailable':
      return 'unreachable';
    default:
      return 'unknown';
  }
}
