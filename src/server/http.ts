import { z } from 'zod';

import { ProviderError } from '@/providers/types';

import type { Deadline } from './deadline';
import { describeError, redactUrl, type Logger } from './logger';

/**
 * The single outbound HTTP path for every provider.
 *
 * Retry policy, stated explicitly so it can be argued with:
 *  - per-attempt timeout: 8 s, further capped by the request deadline;
 *  - attempts: 3 (one initial + two retries);
 *  - backoff: 250 ms * 2^n, capped at 2 s;
 *  - retried: network errors, 408, 429, 500, 502, 503, 504;
 *  - not retried: every other 4xx, and any schema failure — a malformed body
 *    will be malformed again, so retrying only wastes the deadline;
 *  - `Retry-After` overrides the backoff entirely, in both directions, and is
 *    never shortened by the 2 s cap. If honouring it would outlast the deadline,
 *    the loop gives up instead of retrying early.
 */

export const DEFAULT_ATTEMPT_TIMEOUT_MS = 8_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 2_000;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export type JsonRequest<TSchema extends z.ZodType> = {
  url: string;
  /**
   * Opaque name used in log lines and error messages instead of the URL.
   *
   * Required whenever the URL can embed a credential — a keyed RPC endpoint puts
   * its key in the path, where `redactUrl` cannot distinguish it from a route
   * segment. Callers whose URL is fixed and public may omit it.
   */
  label?: string;
  schema: TSchema;
  providerId: string;
  /**
   * How to turn a response body into something the schema can validate.
   *
   * Defaults to JSON. Parameterised so a provider that answers in another format
   * — the ECB publishes its reference rates as XML — reuses this function's
   * retry policy, deadline arithmetic and error taxonomy instead of
   * reimplementing them next to a different parser.
   */
  decode?: (response: Response) => Promise<unknown>;
  context: { deadline: Deadline; fetch: typeof globalThis.fetch; logger: Logger };
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
};

export async function fetchJson<TSchema extends z.ZodType>(
  request: JsonRequest<TSchema>,
): Promise<z.infer<TSchema>> {
  const {
    url,
    schema,
    providerId,
    context,
    method = 'GET',
    body,
    headers = {},
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sleep = defaultSleep,
    decode = decodeJson,
  } = request;

  const safeUrl = request.label ?? redactUrl(url);
  let lastError: ProviderError = new ProviderError(
    'unavailable',
    providerId,
    `No attempt was made against ${safeUrl}`,
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timeout = context.deadline.timeoutForAttempt(attemptTimeoutMs);
    if (timeout <= 0) {
      throw new ProviderError(
        'timeout',
        providerId,
        `Request deadline exhausted before attempt ${attempt} to ${safeUrl}`,
      );
    }

    try {
      return await attempt_(
        { url, safeUrl, schema, providerId, context, method, body, headers, decode },
        timeout,
      );
    } catch (error) {
      if (!(error instanceof ProviderError)) {
        throw error;
      }
      lastError = error;

      const canRetry = attempt < maxAttempts && isRetryable(error);
      if (!canRetry) {
        break;
      }

      // `Retry-After` is an instruction, not a suggestion: it is never shortened
      // by the backoff cap. Retrying earlier than a provider asked is how a
      // client earns a longer ban. Our own backoff, having no such authority,
      // stays capped. Either way, a wait that outlasts the deadline means giving
      // up now rather than sleeping into a guaranteed timeout.
      const wait =
        error.retryAfterMs ?? Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
      if (wait >= context.deadline.remainingMs()) {
        break;
      }

      context.logger.debug('http.retry', {
        providerId,
        endpoint: safeUrl,
        attempt,
        waitMs: wait,
        ...describeError(error),
      });
      await sleep(wait);
    }
  }

  throw lastError;
}

type AttemptInput<TSchema extends z.ZodType> = {
  url: string;
  safeUrl: string;
  schema: TSchema;
  providerId: string;
  context: JsonRequest<TSchema>['context'];
  method: 'GET' | 'POST';
  body: unknown;
  headers: Record<string, string>;
  decode: (response: Response) => Promise<unknown>;
};

async function attempt_<TSchema extends z.ZodType>(
  input: AttemptInput<TSchema>,
  timeoutMs: number,
): Promise<z.infer<TSchema>> {
  const { url, safeUrl, schema, providerId, context, method, body, headers, decode } = input;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await context.fetch(url, {
      method,
      headers: {
        accept: 'application/json, text/xml, */*',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      // Nuxfolio does its own caching; an intermediate cache would hide the
      // provider timestamps the UI relies on for staleness.
      cache: 'no-store',
      redirect: 'error',
    });

    if (!response.ok) {
      throw httpStatusError(providerId, safeUrl, response);
    }

    const payload: unknown = await decode(response).catch(() => {
      throw new ProviderError(
        'invalid-response',
        providerId,
        `Response from ${safeUrl} could not be decoded`,
      );
    });

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ProviderError(
        'invalid-response',
        providerId,
        `Response from ${safeUrl} did not match the expected schema: ${summarizeZodError(parsed.error)}`,
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (isAbortError(error)) {
      throw new ProviderError(
        'timeout',
        providerId,
        `Request to ${safeUrl} timed out after ${timeoutMs} ms`,
        { cause: error },
      );
    }
    throw new ProviderError('unavailable', providerId, `Request to ${safeUrl} failed`, {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

function httpStatusError(providerId: string, safeUrl: string, response: Response): ProviderError {
  const kind = response.status === 429 ? 'rate-limited' : 'unavailable';
  const error = new ProviderError(kind, providerId, `${safeUrl} responded ${response.status}`);
  error.status = response.status;
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
  if (retryAfter !== null) {
    error.retryAfterMs = retryAfter;
  }
  return error;
}

function isRetryable(error: ProviderError): boolean {
  if (error.kind === 'invalid-response' || error.kind === 'misconfigured') {
    return false;
  }
  if (error.status !== undefined) {
    return RETRYABLE_STATUS.has(error.status);
  }
  // Timeouts and transport failures carry no status and are worth one more try.
  return error.kind === 'timeout' || error.kind === 'unavailable';
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) {
    return null;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.code}`)
    .join('; ');
}

/** The default body decoder. */
function decodeJson(response: Response): Promise<unknown> {
  return response.json();
}

/**
 * Body decoder for text formats, e.g. the ECB's XML.
 *
 * The schema then validates a string, and the adapter parses it — vendor format
 * handling stays inside the adapter, as it does for every other provider.
 */
export function decodeText(response: Response): Promise<unknown> {
  return response.text();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
