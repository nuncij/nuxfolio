import { getServerEnv } from '@/config/env';
import { DEFAULT_CHAIN_ID, listPublicChains } from '@/config/chains';
import { parseWalletAddress } from '@/domain/address';
import { ALL_CHAINS, type ApiErrorCode } from '@/domain/portfolio';
import { isProviderError } from '@/providers/types';
import { describeError } from '@/server/logger';
import {
  getAggregatePortfolio,
  getLogger,
  getPortfolio,
  UnsupportedChainError,
} from '@/server/portfolioService';
import { FixedWindowRateLimiter, resolveClientId, UNKNOWN_CLIENT_ID } from '@/server/rateLimit';

/**
 * `GET /api/portfolio?address=0x…&chainId=1`
 *
 * The only public endpoint. Two rules govern what leaves this handler:
 *  1. every response body is either a validated portfolio or a fixed error
 *     shape — never an upstream message, URL or stack trace;
 *  2. the address is validated before any upstream work begins, so a malformed
 *     request cannot cost a provider call.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

let limiter: FixedWindowRateLimiter | undefined;

function getLimiter(): FixedWindowRateLimiter {
  const env = getServerEnv();
  limiter ??= new FixedWindowRateLimiter({
    maxRequests: env.RATE_LIMIT_MAX_REQUESTS,
    windowMs: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
  });
  return limiter;
}

export async function GET(request: Request): Promise<Response> {
  const env = getServerEnv();
  const logger = getLogger(env);
  const url = new URL(request.url);

  const clientId = resolveClientId({
    headers: request.headers,
    trustProxyHeaders: env.TRUST_PROXY_HEADERS,
    clientIpHeader: env.CLIENT_IP_HEADER,
  });

  const decision = getLimiter().check(clientId);
  if (!decision.allowed) {
    logger.warn('api.rate_limited', {
      clientIdentified: clientId !== UNKNOWN_CLIENT_ID,
      limit: decision.limit,
    });
    return errorResponse(
      'rate-limited',
      'Too many requests. Please wait a moment and try again.',
      429,
      { 'retry-after': String(decision.resetInSeconds) },
    );
  }

  const parsedAddress = parseWalletAddress(url.searchParams.get('address') ?? '');
  if (!parsedAddress.ok) {
    return errorResponse('invalid-address', parsedAddress.message, 400);
  }

  const chainIdParam = url.searchParams.get('chainId');

  const headers = {
    // The client is told the data is short-lived; shared caches must not hold a
    // wallet lookup on behalf of another user.
    'cache-control': `private, max-age=${env.PORTFOLIO_CACHE_TTL_SECONDS}`,
    'x-rate-limit-remaining': String(decision.remaining),
  };

  try {
    if (chainIdParam === ALL_CHAINS) {
      const result = await getAggregatePortfolio(parsedAddress.address);
      return Response.json({ aggregate: result.aggregate, cached: result.cached }, { headers });
    }

    const chainId = chainIdParam === null ? DEFAULT_CHAIN_ID : Number(chainIdParam);
    if (!Number.isInteger(chainId) || chainId <= 0) {
      return errorResponse(
        'invalid-chain',
        'The chain identifier must be a positive integer, or "all".',
        400,
      );
    }

    const result = await getPortfolio({ address: parsedAddress.address, chainId });
    return Response.json({ portfolio: result.portfolio, cached: result.cached }, { headers });
  } catch (error) {
    return handleFailure(error, logger.child({ route: 'api.portfolio' }));
  }
}

function handleFailure(error: unknown, logger: ReturnType<typeof getLogger>): Response {
  if (error instanceof UnsupportedChainError) {
    const supported = listPublicChains()
      .map((chain) => chain.shortName)
      .join(', ');
    return errorResponse(
      'unsupported-chain',
      `That network is not supported yet. Available today: ${supported}.`,
      400,
    );
  }

  if (isProviderError(error)) {
    // The operator gets the detail in the log; the caller gets a sentence.
    logger.error('api.provider_failed', {
      providerId: error.providerId,
      kind: error.kind,
      ...describeError(error),
    });

    switch (error.kind) {
      case 'timeout':
        return errorResponse(
          'timeout',
          'The data provider took too long to respond. Please try again.',
          504,
        );
      case 'rate-limited':
        return errorResponse(
          'upstream-rate-limited',
          'The data provider is rate limiting Nuxfolio right now. Please try again in a minute.',
          503,
          { 'retry-after': '60' },
        );
      case 'invalid-response':
        return errorResponse(
          'upstream-invalid-response',
          'The data provider returned something Nuxfolio could not read. Please try again later.',
          502,
        );
      case 'misconfigured':
        return errorResponse(
          'internal',
          'Nuxfolio is not configured correctly for this request. Please contact the operator.',
          500,
        );
      default:
        return errorResponse(
          'upstream-unavailable',
          'The data provider is unavailable right now. Please try again shortly.',
          503,
        );
    }
  }

  logger.error('api.unhandled_error', describeError(error));
  return errorResponse('internal', 'Something went wrong on our side. Please try again.', 500);
}

function errorResponse(
  code: ApiErrorCode,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return Response.json({ error: { code, message } }, { status, headers });
}
