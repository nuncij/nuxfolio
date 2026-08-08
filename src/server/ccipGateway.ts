import 'server-only';

import { lookup } from 'node:dns/promises';

import { isPublicAddress } from './ssrfGuard';

/**
 * The hardened gateway fetch that CCIP-read (ERC-3668) needs.
 *
 * When an ENS resolver cannot answer on chain it reverts with a list of URLs and expects
 * the client to go and ask one. Review round 4 called that a blocker and switched CCIP
 * off: viem followed those URLs with the global `fetch`, outside the injected client and
 * outside the deadline, so anyone could register a name pointing at
 * `http://169.254.169.254/…` and make this server issue requests inside its own network.
 * The cost was that offchain-resolved names — `.cb.id`, `.base.eth`, gasless subdomains —
 * returned "not found".
 *
 * **Two controls, and the first one is the one that matters.**
 *
 * 1. **The host must be on a list this project chose.** Measured on 2026-08-08: every
 *    offchain name tested resolved through `https://ccip-v2.ens.xyz`, ENS's own batch
 *    gateway, which fans out to the per-name gateways itself. So in the path this code
 *    takes, the destination is decided by the resolver contract *this project*
 *    configured, not by whoever registered the name. An allowlist therefore costs
 *    almost nothing in coverage and removes attacker-chosen destinations entirely —
 *    which is the whole of the original vulnerability.
 * 2. **The resolved address must be publicly routable**, checked per IP rather than by
 *    hostname, as defence in depth for an allowlisted host that is compromised or whose
 *    DNS is turned against it.
 *
 * Anything else **fails closed**: the name resolves to nothing, exactly as it does today
 * with CCIP disabled. No name that works now can break; some that do not, start working.
 *
 * **Residual risk, stated rather than papered over.** A DNS answer can change between
 * the lookup here and the connection `fetch` makes — classic rebinding — and closing
 * that needs pinning the socket to the checked IP, which is not reachable through an
 * injected `fetch`. It is bounded by control 1: an attacker would have to compromise DNS
 * for a host on the list, at which point they have a better attack than this one.
 */

/**
 * Gateways this project is willing to talk to.
 *
 * One entry, because one is what the measurement found. A list rather than a constant so
 * adding the second is an edit with a reason attached rather than a redesign.
 */
export const ALLOWED_GATEWAY_HOSTS: readonly string[] = ['ccip-v2.ens.xyz'];

/** Past this the gateway is answering with something that is not a CCIP response. */
const MAX_RESPONSE_BYTES = 256 * 1024;

export type CcipRequest = {
  readonly sender: string;
  readonly data: string;
  readonly urls: readonly string[];
};

export type CcipDependencies = {
  readonly fetchImpl: typeof globalThis.fetch;
  /** Milliseconds this call may take, taken from the request's shared budget. */
  readonly timeoutMs: number;
  readonly allowedHosts?: readonly string[];
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
  readonly onRefused?: (reason: string) => void;
};

/**
 * Asks a gateway, in the order ERC-3668 specifies, and returns its `data`.
 *
 * Throws when no URL could be used. The caller turns that into "not found", which is the
 * same answer the name gives today — a gateway that cannot be reached must never become
 * a resolution that did not happen.
 */
export async function ccipRequest(
  request: CcipRequest,
  dependencies: CcipDependencies,
): Promise<`0x${string}`> {
  const allowed = new Set(dependencies.allowedHosts ?? ALLOWED_GATEWAY_HOSTS);
  const refuse = dependencies.onRefused ?? (() => {});

  let lastError: Error | null = null;

  for (const template of request.urls) {
    const url = buildUrl(template, request);
    if (url === null) {
      refuse('gateway URL could not be parsed');
      continue;
    }

    if (url.protocol !== 'https:') {
      refuse(`gateway URL is not https (${url.protocol})`);
      continue;
    }
    if (url.username !== '' || url.password !== '') {
      refuse('gateway URL carries credentials');
      continue;
    }
    if (!allowed.has(url.hostname.toLowerCase())) {
      refuse(`gateway host is not on the allow list (${url.hostname})`);
      continue;
    }

    const addresses = await resolveAll(url.hostname, dependencies);
    if (addresses.length === 0) {
      refuse(`gateway host did not resolve (${url.hostname})`);
      continue;
    }
    const unsafe = addresses
      .map((address) => ({ address, verdict: isPublicAddress(address) }))
      .find((entry) => !entry.verdict.safe);
    if (unsafe !== undefined) {
      refuse(
        `gateway host resolved to a non-public address: ${unsafe.verdict.safe === false ? unsafe.verdict.reason : ''}`,
      );
      continue;
    }

    try {
      return await ask(url, template, request, dependencies);
    } catch (error) {
      // ERC-3668: a 4xx is the gateway saying this request is wrong, so trying another
      // is pointless. A 5xx is the gateway being unwell, and the next one may not be.
      lastError = error instanceof Error ? error : new Error('gateway request failed');
      if (error instanceof GatewayError && !error.tryNext) {
        break;
      }
    }
  }

  throw lastError ?? new Error('no usable CCIP gateway');
}

class GatewayError extends Error {
  readonly tryNext: boolean;

  constructor(message: string, tryNext: boolean) {
    super(message);
    this.name = 'GatewayError';
    this.tryNext = tryNext;
  }
}

/**
 * The URL to call, with the substitutions ERC-3668 defines.
 *
 * Both values are hex produced by the ABI decoder rather than anything a user typed, but
 * they are still checked: a template is a string from a contract, and building a URL out
 * of unvalidated pieces is how the interesting bugs start.
 */
function buildUrl(template: string, request: CcipRequest): URL | null {
  if (!/^0x[0-9a-fA-F]*$/.test(request.sender) || !/^0x[0-9a-fA-F]*$/.test(request.data)) {
    return null;
  }
  try {
    return new URL(
      template.replaceAll('{sender}', request.sender).replaceAll('{data}', request.data),
    );
  } catch {
    return null;
  }
}

async function ask(
  url: URL,
  template: string,
  request: CcipRequest,
  dependencies: CcipDependencies,
): Promise<`0x${string}`> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs);

  try {
    const response = await dependencies.fetchImpl(url, {
      // A GET when the template asked for the data in the path, a POST otherwise.
      method: template.includes('{data}') ? 'GET' : 'POST',
      ...(template.includes('{data}')
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ data: request.data, sender: request.sender }),
          }),
      // A redirect is a second destination the allow list never saw.
      redirect: 'error',
      signal: controller.signal,
    });

    if (response.status >= 400 && response.status < 500) {
      throw new GatewayError(`gateway refused the request (${response.status})`, false);
    }
    if (!response.ok) {
      throw new GatewayError(`gateway is unavailable (${response.status})`, true);
    }

    const body = await readCapped(response);
    const parsed: unknown = JSON.parse(body);
    const data = (parsed as { data?: unknown } | null)?.data;
    if (typeof data !== 'string' || !/^0x[0-9a-fA-F]*$/.test(data)) {
      throw new GatewayError('gateway answered without usable hex data', true);
    }
    return data as `0x${string}`;
  } finally {
    clearTimeout(timer);
  }
}

/** The body, refusing to buffer more than a CCIP answer could plausibly be. */
async function readCapped(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new GatewayError('gateway response is too large to be a CCIP answer', false);
  }
  return text;
}

/** Every address a hostname resolves to, because one bad answer among several is enough. */
async function resolveAll(
  hostname: string,
  dependencies: CcipDependencies,
): Promise<readonly string[]> {
  if (dependencies.resolveHost !== undefined) {
    return dependencies.resolveHost(hostname);
  }
  try {
    const results = await lookup(hostname, { all: true });
    return results.map((entry) => entry.address);
  } catch {
    return [];
  }
}
