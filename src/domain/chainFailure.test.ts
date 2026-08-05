import { describe, expect, it } from 'vitest';

import type { ProviderErrorKind } from '@/providers/types';

import {
  chainFailureKindFromApiError,
  chainFailureKindFromProviderError,
  chainFailureMessage,
} from './chainFailure';
import { apiErrorSchema, type ApiErrorCode } from './portfolio';

/**
 * Both sides of the wire classify the same failures, so these tests pin the
 * wording (the server sentences predate the extraction and must not drift) and
 * the completeness of the mapping (an unmapped code would render a network's
 * failure as something it is not).
 */

const PROVIDER_SENTENCES: Record<ProviderErrorKind, string> = {
  timeout: 'This network took too long to respond and was skipped.',
  'rate-limited': 'This network is rate limiting Nuxfolio right now and was skipped.',
  'invalid-response': 'This network returned data Nuxfolio could not read and was skipped.',
  misconfigured: 'This network is not configured correctly and was skipped.',
  unavailable: 'This network could not be reached and was skipped.',
};

/** Every code the error payload can carry, read from the schema itself. */
const API_ERROR_CODES = apiErrorSchema.shape.error.shape.code.options as readonly ApiErrorCode[];

describe('chainFailureKindFromProviderError', () => {
  for (const [kind, sentence] of Object.entries(PROVIDER_SENTENCES) as [
    ProviderErrorKind,
    string,
  ][]) {
    it(`describes a ${kind} provider failure as before the extraction`, () => {
      expect(chainFailureMessage(chainFailureKindFromProviderError(kind))).toBe(sentence);
    });
  }

  it('describes an error that is not a provider error at all', () => {
    expect(chainFailureMessage('unknown')).toBe(
      'This network could not be loaded and was skipped.',
    );
  });
});

describe('chainFailureKindFromApiError', () => {
  it('maps every code the API can return to a sentence', () => {
    expect(API_ERROR_CODES.length).toBeGreaterThan(0);

    for (const code of API_ERROR_CODES) {
      const message = chainFailureMessage(chainFailureKindFromApiError(code));
      expect(message.length).toBeGreaterThan(0);
      // A network-level sentence, never a bare restatement of the code.
      expect(message).not.toContain(code);
    }
  });

  it('does not blame the network for Nuxfolio’s own request limit', () => {
    const ours = chainFailureMessage(chainFailureKindFromApiError('rate-limited'));
    const upstream = chainFailureMessage(chainFailureKindFromApiError('upstream-rate-limited'));

    expect(ours).not.toBe(upstream);
    expect(ours).toContain('Nuxfolio');
    expect(upstream).toContain('This network is rate limiting');
  });

  it('keeps the classifiable failures distinct', () => {
    expect(chainFailureKindFromApiError('timeout')).toBe('timeout');
    expect(chainFailureKindFromApiError('upstream-invalid-response')).toBe('invalid-response');
    expect(chainFailureKindFromApiError('upstream-unavailable')).toBe('unreachable');
  });

  it('reports a server-side fault as unclassified rather than guessing', () => {
    // `internal` covers a misconfiguration and an unhandled bug alike; the wire
    // format cannot tell them apart, so neither does the sentence.
    expect(chainFailureKindFromApiError('internal')).toBe('unknown');
    expect(chainFailureKindFromApiError('unsupported-chain')).toBe('unknown');
  });
});
