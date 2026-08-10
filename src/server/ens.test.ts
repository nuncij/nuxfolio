import { encodeAbiParameters, encodeFunctionResult, parseAbiParameters } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';

import { TtlCache } from './cache';
import { Deadline } from './deadline';
import { resetEnsCache, resolveEnsName } from './ens';
import type { WalletAddress } from '@/domain/address';
import {
  createFetchStub,
  createRecordingLogger,
  jsonResponse,
  rpcResult,
  silentLogger,
  TEST_ADDRESS,
} from '@/test/helpers';

/**
 * ENS resolution against a stubbed transport.
 *
 * viem's ENS action calls `resolveWithGateways` on the Universal Resolver, so the
 * fixtures below encode that function's return value. The ABI is restated rather
 * than imported from viem's internals: if the action's wire format changes under
 * us, these fixtures stop matching and the tests say so, which is the point.
 */
const universalResolverResolveAbi = [
  {
    name: 'resolveWithGateways',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'name', type: 'bytes' },
      { name: 'data', type: 'bytes' },
      { name: 'gateways', type: 'string[]' },
    ],
    outputs: [
      { name: '', type: 'bytes' },
      { name: 'address', type: 'address' },
    ],
  },
] as const;

const PUBLIC_RESOLVER: WalletAddress = '0x231b0Ee14048e9dCcD1d247744d114a4EB5E8E63';
const ZERO_ADDRESS: WalletAddress = '0x0000000000000000000000000000000000000000';

/** The Universal Resolver's answer: the inner `addr()` result plus the resolver. */
function resolverAnswer(addressResult: `0x${string}`) {
  return encodeFunctionResult({
    abi: universalResolverResolveAbi,
    functionName: 'resolveWithGateways',
    result: [addressResult, PUBLIC_RESOLVER],
  });
}

function addrRecord(address: WalletAddress): `0x${string}` {
  return encodeAbiParameters(parseAbiParameters('address'), [address]);
}

const ENDPOINTS = ['https://ens-rpc.test.invalid'];

afterEach(() => {
  resetEnsCache();
});

/** A fresh cache per test, so no test depends on another's resolutions. */
function cache() {
  return new TtlCache<WalletAddress | null>({ ttlMs: 60_000, maxEntries: 10 });
}

describe('resolveEnsName', () => {
  it('never follows a resolver-supplied URL, now that CCIP-read is back on', async () => {
    // ERC-3668 offchain resolution asks the caller to fetch a URL chosen by whoever
    // registered the name. Following it would let any visitor's URL make this server
    // request arbitrary hosts from inside its own network.
    //
    // This test was written when the answer was to disable CCIP entirely. CCIP is on
    // again, through `ccipGateway.ts`, and the assertion is unchanged and still passes —
    // which is the point. What refuses the link-local address is now a guard rather than
    // the absence of a feature, and the revert still costs exactly zero extra requests.
    // `OffchainLookup(address,string[],bytes,bytes4,bytes)`, selector 0x556f1830.
    const offchainLookupRevert =
      '0x556f1830' +
      encodeAbiParameters(parseAbiParameters('address, string[], bytes, bytes4, bytes'), [
        PUBLIC_RESOLVER,
        ['http://169.254.169.254/latest/meta-data/{sender}'],
        '0x',
        '0xdeadbeef',
        '0x',
      ]).slice(2);

    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        error: { code: 3, message: 'execution reverted', data: offchainLookupRevert },
      }),
    );

    const result = await resolveEnsName('attacker.eth', {
      rpcUrls: ENDPOINTS,
      fetchImpl,
      logger: silentLogger(),
      cache: cache(),
    });

    expect(result.ok).toBe(false);
    // Only the RPC call itself; no gateway fetch, and nothing aimed at the
    // link-local address the revert asked for.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).not.toContain('169.254');
    expect(calls.every((call) => !call.url.includes('169.254.169.254'))).toBe(true);
  });

  it('resolves a name to a checksummed address', async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      rpcResult(resolverAnswer(addrRecord(TEST_ADDRESS))),
    );

    const result = await resolveEnsName('vitalik.eth', {
      rpcUrls: ENDPOINTS,
      fetchImpl,
      logger: silentLogger(),
      cache: cache(),
    });

    expect(result).toEqual({ ok: true, address: TEST_ADDRESS });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({ method: 'eth_call' });
  });

  it('reports a name that resolves to nothing as not found', async () => {
    // An empty result is what the Universal Resolver returns for a name with no
    // address record at all.
    const { fetchImpl } = createFetchStub(() => rpcResult(resolverAnswer('0x')));

    const result = await resolveEnsName('nobody-owns-this-name.eth', {
      rpcUrls: ENDPOINTS,
      fetchImpl,
      logger: silentLogger(),
      cache: cache(),
    });

    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
    expect(result.ok === false && result.message).toContain('could not be resolved');
  });

  it('treats the zero address as not found rather than as a wallet', async () => {
    const { fetchImpl } = createFetchStub(() =>
      rpcResult(resolverAnswer(addrRecord(ZERO_ADDRESS))),
    );

    const result = await resolveEnsName('cleared.eth', {
      rpcUrls: ENDPOINTS,
      fetchImpl,
      logger: silentLogger(),
      cache: cache(),
    });

    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
  });

  it('separates an RPC failure from a name that does not exist', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({}, { status: 500 }));

    const result = await resolveEnsName('vitalik.eth', {
      rpcUrls: ENDPOINTS,
      fetchImpl,
      logger: silentLogger(),
      cache: cache(),
    });

    // "Try again" is only honest advice when the failure was ours.
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(result.ok === false && result.message).toContain('Try again');
  });

  it('tries the next endpoint when the first one fails', async () => {
    const { fetchImpl, calls } = createFetchStub((url) =>
      url.includes('primary')
        ? jsonResponse({}, { status: 502 })
        : rpcResult(resolverAnswer(addrRecord(TEST_ADDRESS))),
    );

    const result = await resolveEnsName('vitalik.eth', {
      rpcUrls: ['https://primary.invalid', 'https://secondary.invalid'],
      fetchImpl,
      logger: silentLogger(),
      cache: cache(),
    });

    expect(result).toEqual({ ok: true, address: TEST_ADDRESS });
    expect(calls.some((call) => call.url.includes('secondary'))).toBe(true);
  });

  it('serves a repeated lookup from the cache', async () => {
    // A shared link gets opened many times; each open must not cost an eth_call.
    const { fetchImpl, calls } = createFetchStub(() =>
      rpcResult(resolverAnswer(addrRecord(TEST_ADDRESS))),
    );
    const shared = cache();
    const dependencies = {
      rpcUrls: ENDPOINTS,
      fetchImpl,
      logger: silentLogger(),
      cache: shared,
    };

    await resolveEnsName('vitalik.eth', dependencies);
    const second = await resolveEnsName('Vitalik.ETH', dependencies);

    expect(second).toEqual({ ok: true, address: TEST_ADDRESS });
    expect(calls).toHaveLength(1);
  });

  it('caches a name that does not resolve, but not a failure', async () => {
    let mode: 'missing' | 'failing' = 'missing';
    const { fetchImpl, calls } = createFetchStub(() =>
      mode === 'missing' ? rpcResult(resolverAnswer('0x')) : jsonResponse({}, { status: 500 }),
    );
    const dependencies = {
      rpcUrls: ENDPOINTS,
      fetchImpl,
      logger: silentLogger(),
      cache: cache(),
    };

    await resolveEnsName('missing.eth', dependencies);
    await resolveEnsName('missing.eth', dependencies);
    expect(calls).toHaveLength(1);

    mode = 'failing';
    await resolveEnsName('flaky.eth', dependencies);
    await resolveEnsName('flaky.eth', dependencies);

    // The failed lookup was retried; a transient outage must not be remembered.
    expect(calls).toHaveLength(3);
  });

  it('refuses a name outside the recognised pattern without any lookup', async () => {
    // Not `vitalik.com` any more: that is recognised now and gets a real lookup. This
    // is a name the pattern still refuses, because hashing it safely would need UTS-46.
    const { fetchImpl, calls } = createFetchStub(() =>
      rpcResult(resolverAnswer(addrRecord(TEST_ADDRESS))),
    );

    const result = await resolveEnsName('vitalik_two.eth', {
      rpcUrls: ENDPOINTS,
      fetchImpl,
      logger: silentLogger(),
      cache: cache(),
    });

    expect(result).toMatchObject({ ok: false, reason: 'not-found' });
    expect(calls).toHaveLength(0);
  });

  it('gives up without a call when the budget is already spent', async () => {
    const { fetchImpl, calls } = createFetchStub(() =>
      rpcResult(resolverAnswer(addrRecord(TEST_ADDRESS))),
    );

    const result = await resolveEnsName('vitalik.eth', {
      rpcUrls: ENDPOINTS,
      fetchImpl,
      logger: silentLogger(),
      cache: cache(),
      deadline: new Deadline(1, Date.now() - 10_000),
    });

    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('reports a misconfiguration when no Ethereum endpoint is configured', async () => {
    const { fetchImpl } = createFetchStub(() => rpcResult('0x'));

    const result = await resolveEnsName('vitalik.eth', {
      rpcUrls: [],
      fetchImpl,
      logger: silentLogger(),
      cache: cache(),
    });

    expect(result).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('never writes an endpoint URL or credential into a log line', async () => {
    // viem puts the request URL in its error messages, so none of that text may
    // be logged: a keyed endpoint carries its credential in the path.
    const CREDENTIAL = 'super-secret-rpc-credential';
    const { fetchImpl } = createFetchStub(() => jsonResponse({}, { status: 500 }));
    const { logger, lines } = createRecordingLogger('debug');

    const result = await resolveEnsName('vitalik.eth', {
      rpcUrls: [`https://ens.example.invalid/v2/${CREDENTIAL}`],
      fetchImpl,
      logger,
      cache: cache(),
    });

    expect(lines.join('\n')).toContain('ens.lookup_failed');
    expect(lines.join('\n')).not.toContain(CREDENTIAL);
    expect(lines.join('\n')).not.toContain('ens.example.invalid');
    expect(result.ok === false && result.message).not.toContain(CREDENTIAL);
  });
});
