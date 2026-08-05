import { z } from 'zod';

import { fetchJson } from '@/server/http';
import { describeError } from '@/server/logger';

import { ProviderError, type ProviderContext } from '../types';

/**
 * Minimal JSON-RPC client shared by the balance adapters.
 *
 * Rather than letting viem own the transport, Nuxfolio wraps its own HTTP client
 * in an EIP-1193-shaped `request` function. That keeps one retry policy, one
 * deadline and one redaction path for every outbound call, while still letting
 * viem do ABI encoding and Multicall3 aggregation.
 *
 * **Endpoints are never named in output.** A keyed RPC URL carries its
 * credential in the path (`https://host/v2/THE-KEY`), where no redaction rule can
 * tell a secret from a route segment. So each configured endpoint gets an opaque
 * label — `endpoint 1`, `endpoint 2` — and that is what reaches logs and errors.
 */

const rpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
});

const rpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0').optional(),
  id: z.union([z.number(), z.string(), z.null()]).optional(),
  result: z.unknown().optional(),
  error: rpcErrorSchema.optional(),
});

export type RpcRequest = { method: string; params?: readonly unknown[] };

export type RpcRequester = (request: RpcRequest) => Promise<unknown>;

/**
 * Builds a requester that tries each configured endpoint in order.
 *
 * The two failure classes are treated differently, because they mean different
 * things:
 *
 *  - **Endpoint-specific** — a timeout, a 5xx, a body that is not JSON, or a
 *    response that does not match the envelope schema (a captive portal or a
 *    proxy error page). Another endpoint may well answer correctly, so fall over
 *    to the next one.
 *  - **Deterministic** — a well-formed JSON-RPC `error` object, or a response
 *    with no result. Every node would answer identically, so trying another is
 *    pure waste and multiplies load during an incident.
 */
export function createRpcRequester(input: {
  urls: readonly string[];
  providerId: string;
  context: ProviderContext;
}): RpcRequester {
  const { urls, providerId, context } = input;

  if (urls.length === 0) {
    throw new ProviderError('misconfigured', providerId, 'No RPC endpoint is configured');
  }

  let requestId = 0;

  return async function request({ method, params = [] }: RpcRequest): Promise<unknown> {
    requestId += 1;
    let lastTransportError: ProviderError | undefined;

    for (const [index, url] of urls.entries()) {
      const label = `endpoint ${index + 1}`;
      let response;

      try {
        response = await fetchJson({
          url,
          label,
          method: 'POST',
          body: { jsonrpc: '2.0', id: requestId, method, params },
          schema: rpcResponseSchema,
          providerId,
          context,
        });
      } catch (error) {
        if (!(error instanceof ProviderError)) {
          throw error;
        }
        // Every failure from the transport layer — including a malformed body —
        // is specific to this endpoint. Try the next one.
        lastTransportError = error;
        context.logger.warn('rpc.endpoint_failed', {
          providerId,
          endpoint: label,
          method,
          ...describeError(error),
        });
        continue;
      }

      if (response.error) {
        throw new ProviderError(
          'invalid-response',
          providerId,
          `${label} rejected ${method}: ${response.error.code} ${response.error.message}`,
        );
      }
      if (response.result === undefined) {
        throw new ProviderError(
          'invalid-response',
          providerId,
          `${label} returned no result for ${method}`,
        );
      }
      return response.result;
    }

    throw (
      lastTransportError ??
      new ProviderError('unavailable', providerId, `No RPC endpoint answered ${method}`)
    );
  };
}
