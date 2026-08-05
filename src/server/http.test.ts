import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { ProviderError } from '@/providers/types';
import { abortError, createFetchStub, createTestContext, jsonResponse } from '@/test/helpers';

import { Deadline } from './deadline';
import { fetchJson } from './http';

const schema = z.object({ value: z.number() });

/** Retries are exercised without real waiting. */
const noSleep = () => Promise.resolve();

describe('fetchJson', () => {
  it('returns the parsed body on success', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ value: 42 }));

    const result = await fetchJson({
      url: 'https://provider.test/data',
      schema,
      providerId: 'test',
      context: createTestContext(fetchImpl),
    });

    expect(result).toEqual({ value: 42 });
    expect(calls).toHaveLength(1);
  });

  it('sends a JSON body and content-type for POST requests', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ value: 1 }));

    await fetchJson({
      url: 'https://provider.test/rpc',
      method: 'POST',
      body: { method: 'eth_chainId' },
      schema,
      providerId: 'test',
      context: createTestContext(fetchImpl),
    });

    expect(calls[0]?.body).toEqual({ method: 'eth_chainId' });
  });

  it('retries a 500 and succeeds on the next attempt', async () => {
    const { fetchImpl, calls } = createFetchStub((_url, _init, index) =>
      index === 0 ? jsonResponse({}, { status: 500 }) : jsonResponse({ value: 7 }),
    );

    const result = await fetchJson({
      url: 'https://provider.test/data',
      schema,
      providerId: 'test',
      context: createTestContext(fetchImpl),
      sleep: noSleep,
    });

    expect(result).toEqual({ value: 7 });
    expect(calls).toHaveLength(2);
  });

  it('gives up after the configured number of attempts', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}, { status: 503 }));

    await expect(
      fetchJson({
        url: 'https://provider.test/data',
        schema,
        providerId: 'test',
        context: createTestContext(fetchImpl),
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ name: 'ProviderError', kind: 'unavailable' });

    expect(calls).toHaveLength(3);
  });

  it('does not retry a 400, because the request itself is wrong', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}, { status: 400 }));

    await expect(
      fetchJson({
        url: 'https://provider.test/data',
        schema,
        providerId: 'test',
        context: createTestContext(fetchImpl),
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(calls).toHaveLength(1);
  });

  it('classifies a 429 as rate-limited', async () => {
    const { fetchImpl } = createFetchStub(() =>
      jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } }),
    );

    await expect(
      fetchJson({
        url: 'https://provider.test/data',
        schema,
        providerId: 'test',
        context: createTestContext(fetchImpl),
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: 'rate-limited', status: 429 });
  });

  it('waits for the interval a 429 asks for rather than its own backoff', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? jsonResponse({}, { status: 429, headers: { 'retry-after': '1' } })
        : jsonResponse({ value: 3 }),
    );

    await fetchJson({
      url: 'https://provider.test/data',
      schema,
      providerId: 'test',
      context: createTestContext(fetchImpl),
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('never shortens a Retry-After down to its own backoff cap', async () => {
    // Retrying earlier than a provider asked is how a client earns a longer ban,
    // so the 2 s cap must not apply to an instruction from the server.
    const sleep = vi.fn(() => Promise.resolve());
    const { fetchImpl } = createFetchStub((_url, _init, index) =>
      index === 0
        ? jsonResponse({}, { status: 503, headers: { 'retry-after': '5' } })
        : jsonResponse({ value: 1 }),
    );

    await fetchJson({
      url: 'https://provider.test/data',
      schema,
      providerId: 'test',
      context: createTestContext(fetchImpl, { deadline: new Deadline(30_000) }),
      sleep,
    });

    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('gives up rather than retrying early when Retry-After outlasts the deadline', async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const { fetchImpl, calls } = createFetchStub(() =>
      jsonResponse({}, { status: 429, headers: { 'retry-after': '120' } }),
    );

    await expect(
      fetchJson({
        url: 'https://provider.test/data',
        schema,
        providerId: 'test',
        context: createTestContext(fetchImpl, { deadline: new Deadline(15_000) }),
        sleep,
      }),
    ).rejects.toMatchObject({ kind: 'rate-limited' });

    expect(sleep).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it('does not retry a schema mismatch, which would fail identically', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ value: 'not-a-number' }));

    await expect(
      fetchJson({
        url: 'https://provider.test/data',
        schema,
        providerId: 'test',
        context: createTestContext(fetchImpl),
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-response' });

    expect(calls).toHaveLength(1);
  });

  it('reports invalid JSON as an invalid response', async () => {
    const { fetchImpl } = createFetchStub(
      () => new Response('<html>maintenance</html>', { status: 200 }),
    );

    await expect(
      fetchJson({
        url: 'https://provider.test/data',
        schema,
        providerId: 'test',
        context: createTestContext(fetchImpl),
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('classifies an aborted request as a timeout', async () => {
    const fetchImpl = (() => Promise.reject(abortError())) as typeof globalThis.fetch;

    await expect(
      fetchJson({
        url: 'https://provider.test/data',
        schema,
        providerId: 'test',
        context: createTestContext(fetchImpl),
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('never opens a connection once the request deadline is spent', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({ value: 1 }));

    await expect(
      fetchJson({
        url: 'https://provider.test/data',
        schema,
        providerId: 'test',
        context: createTestContext(fetchImpl, {
          deadline: new Deadline(1, Date.now() - 1_000),
        }),
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });

    expect(calls).toHaveLength(0);
  });

  it('stops retrying when the wait would outlast the deadline', async () => {
    const { fetchImpl, calls } = createFetchStub(() => jsonResponse({}, { status: 503 }));

    await expect(
      fetchJson({
        url: 'https://provider.test/data',
        schema,
        providerId: 'test',
        // 50 ms left: enough for one attempt, not enough to wait 250 ms.
        context: createTestContext(fetchImpl, { deadline: new Deadline(50) }),
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(calls).toHaveLength(1);
  });

  it('keeps the provider URL out of the error message except as origin and path', async () => {
    const { fetchImpl } = createFetchStub(() => jsonResponse({}, { status: 500 }));

    const error = await fetchJson({
      url: 'https://provider.test/v2/deadbeefdeadbeefdeadbeefdeadbeef?apiKey=supersecretvalue',
      schema,
      providerId: 'test',
      context: createTestContext(fetchImpl),
      sleep: noSleep,
    }).then(
      () => {
        throw new Error('Expected the request to fail');
      },
      (caught: unknown) => caught as ProviderError,
    );

    expect(error.message).not.toContain('supersecretvalue');
    expect(error.message).not.toContain('apiKey');
    expect(error.message).toContain('https://provider.test/v2/');
  });
});
