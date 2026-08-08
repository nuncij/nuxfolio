import { describe, expect, it, vi } from 'vitest';

import { ccipRequest } from './ccipGateway';

/**
 * Re-enabling CCIP-read means re-opening the door review round 4 called a blocker, so
 * these tests are mostly about what does *not* happen: which requests are never issued,
 * and which destinations are never reached.
 */

const SENDER = '0x1234567890123456789012345678901234567890';
const DATA = '0xdeadbeef';
const GATEWAY = 'https://api.coinbase.com/{sender}/{data}.json';

function deps(overrides: Partial<Parameters<typeof ccipRequest>[1]> = {}) {
  const fetchImpl = vi.fn(async () =>
    Response.json({ data: '0xabcdef' }),
  ) as unknown as typeof globalThis.fetch;

  return {
    fetchImpl,
    timeoutMs: 1_000,
    resolveHost: async () => ['104.16.0.1'],
    ...overrides,
  };
}

const ask = (urls: readonly string[], dependencies: ReturnType<typeof deps>) =>
  ccipRequest({ sender: SENDER, data: DATA, urls }, dependencies);

describe('what it refuses to fetch', () => {
  it('never contacts the metadata endpoint, whatever the name says', async () => {
    // The attack round 4 found: register a name whose resolver points here, and any
    // visitor's lookup makes the server issue a request inside its own network.
    const dependencies = deps();

    await expect(ask(['http://169.254.169.254/latest/meta-data/'], dependencies)).rejects.toThrow();

    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it('never contacts a host that is not on the list, even over https', async () => {
    const dependencies = deps();

    await expect(
      ask(['https://gateway.attacker.test/{sender}/{data}'], dependencies),
    ).rejects.toThrow();

    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses plain http even for an allowed host', async () => {
    // A gateway reached over http can be rewritten in flight by anything on the path.
    const dependencies = deps();

    await expect(ask(['http://api.coinbase.com/{sender}/{data}'], dependencies)).rejects.toThrow();

    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a URL that smuggles a different host through credentials', async () => {
    // `https://api.coinbase.com@evil.test/` parses with hostname `evil.test`; the check
    // is on the parsed hostname, and credentials are refused outright as well.
    const dependencies = deps();

    await expect(
      ask(['https://api.coinbase.com@169.254.169.254/{sender}/{data}'], dependencies),
    ).rejects.toThrow();

    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses credentials even on a host that is otherwise allowed', async () => {
    // Isolates the credentials check: the hostname here passes the allow list, so only
    // that guard can refuse it. Mutation testing found this control had no test of its
    // own — every case that exercised it was already being caught by the allow list.
    const dependencies = deps();

    await expect(
      ask(['https://user:secret@api.coinbase.com/{sender}/{data}'], dependencies),
    ).rejects.toThrow();

    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a non-standard port on an allowed host', async () => {
    // The allow list names a host, not an origin. Without a port check a name could
    // probe whatever else listens on an approved host.
    const dependencies = deps();

    await expect(
      ask(['https://api.coinbase.com:4443/{sender}/{data}'], dependencies),
    ).rejects.toThrow();

    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it('tries at most three of the URLs a revert offers', async () => {
    // The list is attacker-supplied and unbounded; each entry costs a lookup and a
    // timeout, so an unlimited loop is an availability attack on a 3.7 GB box.
    const failing = vi.fn(async () => new Response('later', { status: 503 }));
    const urls = Array.from({ length: 50 }, () => GATEWAY);

    await expect(ask(urls, deps({ fetchImpl: failing as never }))).rejects.toThrow();

    expect(failing.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('refuses an allowed host that resolves to a private address', async () => {
    // Defence in depth: the host is on the list, and DNS says something it should not.
    const dependencies = deps({ resolveHost: async () => ['10.0.0.5'] });

    await expect(ask([GATEWAY], dependencies)).rejects.toThrow();

    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses when any one of several answers is private', async () => {
    // A host with two A records, one public and one internal, must not be reachable on
    // the strength of the public one.
    const dependencies = deps({ resolveHost: async () => ['104.16.0.1', '127.0.0.1'] });

    await expect(ask([GATEWAY], dependencies)).rejects.toThrow();

    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a host that does not resolve at all', async () => {
    const dependencies = deps({ resolveHost: async () => [] });

    await expect(ask([GATEWAY], dependencies)).rejects.toThrow();

    expect(dependencies.fetchImpl).not.toHaveBeenCalled();
  });

  it('tries the next URL when the first is refused, rather than giving up', async () => {
    const dependencies = deps();

    await expect(ask(['http://169.254.169.254/', GATEWAY], dependencies)).resolves.toBe('0xabcdef');

    expect(dependencies.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('how it talks to a gateway it accepts', () => {
  it('uses the injected fetch, never the global one', async () => {
    // The original defect was viem reaching for global `fetch`, outside the deadline and
    // outside anything a test could observe.
    const dependencies = deps();

    await ask([GATEWAY], dependencies);

    expect(dependencies.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('GETs when the template wants the data in the path', async () => {
    const dependencies = deps();

    await ask([GATEWAY], dependencies);

    const [url, init] = (dependencies.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.method).toBe('GET');
    expect(String(url)).toContain(DATA);
    expect(String(url)).toContain(SENDER.toLowerCase());
  });

  it('POSTs the payload when the template does not', async () => {
    const dependencies = deps();

    await ask(['https://api.coinbase.com/lookup'], dependencies);

    const [, init] = (dependencies.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ data: DATA, sender: SENDER });
  });

  it('refuses to follow a redirect', async () => {
    // A redirect is a second destination the allow list never saw.
    const dependencies = deps();

    await ask([GATEWAY], dependencies);

    const [, init] = (dependencies.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(init.redirect).toBe('error');
  });

  it('gives up on a 4xx and moves on from a 5xx', async () => {
    // ERC-3668: a 4xx means this request is wrong and another gateway will say the same.
    const fourHundred = vi.fn(async () => new Response('no', { status: 400 }));
    await expect(
      ask([GATEWAY, GATEWAY], deps({ fetchImpl: fourHundred as never })),
    ).rejects.toThrow(/refused/);
    expect(fourHundred).toHaveBeenCalledTimes(1);

    let call = 0;
    const flaky = vi.fn(async () => {
      call += 1;
      return call === 1 ? new Response('later', { status: 503 }) : Response.json({ data: '0x01' });
    });
    await expect(ask([GATEWAY, GATEWAY], deps({ fetchImpl: flaky as never }))).resolves.toBe(
      '0x01',
    );
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('refuses an answer that is not hex', async () => {
    // The result goes straight into a contract call, so anything but hex is a failure
    // rather than something to pass along and find out about later.
    const bad = vi.fn(async () => Response.json({ data: 'not-hex' }));

    await expect(ask([GATEWAY], deps({ fetchImpl: bad as never }))).rejects.toThrow(/hex/);
  });

  it('refuses a response too large to be a CCIP answer', async () => {
    const huge = vi.fn(async () => Response.json({ data: `0x${'ab'.repeat(200_000)}` }));

    await expect(ask([GATEWAY], deps({ fetchImpl: huge as never }))).rejects.toThrow(/too large/);
  });

  it('stops reading at the cap rather than buffering past it', async () => {
    // `response.text()` buffers everything before any size check, so a gateway streaming
    // without end could exhaust the box before the limit was consulted. This asserts the
    // stream is abandoned instead: the producer is asked for far more than the cap and
    // must not be drained.
    let chunksProduced = 0;
    const endless = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              chunksProduced += 1;
              controller.enqueue(new Uint8Array(64 * 1024));
            },
          }),
        ),
    );

    await expect(ask([GATEWAY], deps({ fetchImpl: endless as never }))).rejects.toThrow(
      /too large/,
    );

    // 256 KiB cap over 64 KiB chunks: a handful, not an unbounded number.
    expect(chunksProduced).toBeLessThan(16);
  });
});
