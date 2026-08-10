import { describe, expect, it, vi } from 'vitest';

import { portfolioPath } from '@/domain/portfolioPath';
import { TEST_ADDRESS } from '@/test/helpers';

import { resolvePortfolioRoute } from './addressRoute';
import type { EnsResolution } from './ens';

/**
 * Route decisions with a fake resolver: what is under test is which outcome the
 * page gets, not how a name reaches an address (that is `ens.test.ts`).
 */

function resolvesTo(address = TEST_ADDRESS) {
  return vi.fn((): Promise<EnsResolution> => Promise.resolve({ ok: true, address }));
}

function fails(reason: 'not-found' | 'unavailable', message = 'nope') {
  return vi.fn((): Promise<EnsResolution> => Promise.resolve({ ok: false, reason, message }));
}

describe('resolvePortfolioRoute', () => {
  it('renders a plain address without resolving anything', async () => {
    const resolve = resolvesTo();

    const decision = await resolvePortfolioRoute({ addressParam: TEST_ADDRESS, resolve });

    expect(decision).toEqual({ kind: 'portfolio', address: TEST_ADDRESS, ensName: null });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('normalises a lowercase address, exactly as before ENS existed', async () => {
    const decision = await resolvePortfolioRoute({
      addressParam: TEST_ADDRESS.toLowerCase(),
      resolve: resolvesTo(),
    });

    expect(decision).toMatchObject({ kind: 'portfolio', address: TEST_ADDRESS });
  });

  it('redirects a resolved name to the canonical address URL', async () => {
    const decision = await resolvePortfolioRoute({
      addressParam: 'vitalik.eth',
      resolve: resolvesTo(),
    });

    expect(decision).toEqual({
      kind: 'redirect',
      path: `/portfolio/${TEST_ADDRESS}?ens=vitalik.eth`,
    });
  });

  it('lowercases the name it puts in the redirect', async () => {
    const decision = await resolvePortfolioRoute({
      addressParam: 'Vitalik.ETH',
      resolve: resolvesTo(),
    });

    expect(decision).toMatchObject({ path: `/portfolio/${TEST_ADDRESS}?ens=vitalik.eth` });
  });

  it('keeps the selected network across the redirect', async () => {
    const decision = await resolvePortfolioRoute({
      addressParam: 'vitalik.eth',
      query: { chainId: '8453' },
      resolve: resolvesTo(),
    });

    expect(decision).toMatchObject({
      path: `/portfolio/${TEST_ADDRESS}?chainId=8453&ens=vitalik.eth`,
    });
  });

  it('drops query parameters it does not own, rather than copying them along', async () => {
    const decision = await resolvePortfolioRoute({
      addressParam: 'vitalik.eth',
      query: { next: 'https://evil.example', ens: 'someone-else.eth' },
      resolve: resolvesTo(),
    });

    expect(decision).toMatchObject({ path: `/portfolio/${TEST_ADDRESS}?ens=vitalik.eth` });
  });

  it('reports the resolver message when a name does not exist', async () => {
    const decision = await resolvePortfolioRoute({
      addressParam: 'nobody.eth',
      resolve: fails('not-found', 'nobody.eth could not be resolved to an address.'),
    });

    expect(decision).toEqual({
      kind: 'invalid',
      message: 'nobody.eth could not be resolved to an address.',
    });
  });

  it('reports the resolver message when the lookup itself failed', async () => {
    const decision = await resolvePortfolioRoute({
      addressParam: 'vitalik.eth',
      resolve: fails('unavailable', 'the ENS lookup did not answer'),
    });

    expect(decision).toMatchObject({ kind: 'invalid', message: 'the ENS lookup did not answer' });
  });

  it('renders a rate-limited lookup as its own explanation, not as a bad name', async () => {
    // The gate's refusal carries instructions ("wait", "enter the 0x address");
    // this pins that the route passes them through verbatim rather than
    // translating the refusal into "check the spelling".
    const decision = await resolvePortfolioRoute({
      addressParam: 'vitalik.eth',
      resolve: async () => ({
        ok: false,
        reason: 'rate-limited',
        message: 'Too many name lookups from your connection — wait about 60 seconds.',
      }),
    });

    expect(decision).toMatchObject({ kind: 'invalid', message: expect.stringContaining('wait') });
  });

  it('rejects a name needing normalisation, without a lookup', async () => {
    // `vitalik.com` used to be the example here, and is now recognised: ENS resolves
    // DNS-imported namespaces, so a name-shaped input gets a lookup and an honest "not
    // found". What still stops before a lookup is a name that would need UTS-46 —
    // an underscore is outside the ASCII subset the hashing is safe for.
    const resolve = resolvesTo();

    const decision = await resolvePortfolioRoute({ addressParam: 'vitalik_two.eth', resolve });

    expect(decision).toMatchObject({ kind: 'invalid' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('rejects a malformed address with the address parser message', async () => {
    const decision = await resolvePortfolioRoute({
      addressParam: '0x1234',
      resolve: resolvesTo(),
    });

    expect(decision).toMatchObject({ kind: 'invalid' });
    expect(decision.kind === 'invalid' && decision.message).toContain('40 characters');
  });

  it('rejects a link whose percent-encoding is broken instead of failing', async () => {
    const decision = await resolvePortfolioRoute({
      addressParam: '%E0%A4%A',
      resolve: resolvesTo(),
    });

    expect(decision).toMatchObject({ kind: 'invalid' });
  });

  it('decodes a percent-encoded name before resolving it', async () => {
    const resolve = resolvesTo();

    await resolvePortfolioRoute({ addressParam: 'vitalik%2Eeth', resolve });

    expect(resolve).toHaveBeenCalledWith('vitalik.eth');
  });

  describe('the display-only ens parameter', () => {
    it('is accepted when it is a valid name', async () => {
      const decision = await resolvePortfolioRoute({
        addressParam: TEST_ADDRESS,
        query: { ens: 'vitalik.eth' },
        resolve: resolvesTo(),
      });

      expect(decision).toMatchObject({ ensName: 'vitalik.eth' });
    });

    it('is dropped when it is not a name at all', async () => {
      // The parameter is whatever a link-sharer typed, and it is rendered — so
      // anything that is not a name must never reach the page.
      const decision = await resolvePortfolioRoute({
        addressParam: TEST_ADDRESS,
        query: { ens: '<script>alert(1)</script>' },
        resolve: resolvesTo(),
      });

      expect(decision).toMatchObject({ ensName: null });
    });

    it('takes the first value when the parameter is repeated', async () => {
      const decision = await resolvePortfolioRoute({
        addressParam: TEST_ADDRESS,
        query: { ens: ['vitalik.eth', 'other.eth'] },
        resolve: resolvesTo(),
      });

      expect(decision).toMatchObject({ ensName: 'vitalik.eth' });
    });

    it('is ignored on a name URL, since the redirect writes its own', async () => {
      const decision = await resolvePortfolioRoute({
        addressParam: 'vitalik.eth',
        query: { ens: 'unrelated.eth' },
        resolve: resolvesTo(),
      });

      expect(decision).toMatchObject({ path: `/portfolio/${TEST_ADDRESS}?ens=vitalik.eth` });
    });
  });
});

describe('portfolioPath', () => {
  it('builds a bare path when there is nothing to add', () => {
    expect(portfolioPath({ address: TEST_ADDRESS })).toBe(`/portfolio/${TEST_ADDRESS}`);
  });

  it('adds the network before the name, so links are stable', () => {
    expect(portfolioPath({ address: TEST_ADDRESS, ensName: 'a.eth', chainId: '1' })).toBe(
      `/portfolio/${TEST_ADDRESS}?chainId=1&ens=a.eth`,
    );
  });

  it('leaves a dotted name readable rather than escaping it', () => {
    expect(portfolioPath({ address: TEST_ADDRESS, ensName: 'pay.vitalik.eth' })).toBe(
      `/portfolio/${TEST_ADDRESS}?ens=pay.vitalik.eth`,
    );
  });
});
