import { describe, expect, it } from 'vitest';

import { FixedWindowRateLimiter, resolveClientId, UNKNOWN_CLIENT_ID } from './rateLimit';

describe('FixedWindowRateLimiter', () => {
  it('allows requests up to the limit', () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 3, windowMs: 60_000 });

    expect(limiter.check('client', 0).allowed).toBe(true);
    expect(limiter.check('client', 1).allowed).toBe(true);
    const third = limiter.check('client', 2);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
  });

  it('blocks the request after the limit and reports when to retry', () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 2, windowMs: 60_000 });
    limiter.check('client', 0);
    limiter.check('client', 0);

    const blocked = limiter.check('client', 30_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetInSeconds).toBe(30);
  });

  it('opens a fresh window once the old one has elapsed', () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 1000 });
    expect(limiter.check('client', 0).allowed).toBe(true);
    expect(limiter.check('client', 500).allowed).toBe(false);
    expect(limiter.check('client', 1000).allowed).toBe(true);
  });

  it('counts each client separately', () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    expect(limiter.check('a', 0).allowed).toBe(true);
    expect(limiter.check('b', 0).allowed).toBe(true);
    expect(limiter.check('a', 0).allowed).toBe(false);
  });

  it('gives the shared unknown bucket a higher allowance', () => {
    // Otherwise one anonymous caller exhausts the limit for every other
    // anonymous caller, and the protection becomes the outage.
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 2,
      windowMs: 60_000,
      unknownMaxRequests: 5,
    });

    for (let index = 0; index < 5; index += 1) {
      expect(limiter.check(UNKNOWN_CLIENT_ID, 0).allowed).toBe(true);
    }
    expect(limiter.check(UNKNOWN_CLIENT_ID, 0).allowed).toBe(false);
  });

  it('defaults the unknown allowance to ten times the per-client limit', () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 3, windowMs: 60_000 });
    expect(limiter.check(UNKNOWN_CLIENT_ID, 0).limit).toBe(30);
    expect(limiter.check('someone', 0).limit).toBe(3);
  });

  it('prunes elapsed windows so the map does not grow unbounded', () => {
    const limiter = new FixedWindowRateLimiter({ maxRequests: 10, windowMs: 1000 });
    limiter.check('a', 0);
    limiter.check('b', 0);
    limiter.check('c', 5000);
    expect(limiter.size()).toBe(1);
  });

  it('caps the number of tracked clients', () => {
    const limiter = new FixedWindowRateLimiter({
      maxRequests: 10,
      windowMs: 60_000,
      maxTrackedClients: 5,
    });

    for (let index = 0; index < 50; index += 1) {
      limiter.check(`client-${index}`, 0);
    }
    expect(limiter.size()).toBeLessThanOrEqual(5);
  });

  it('rejects a nonsensical configuration', () => {
    expect(() => new FixedWindowRateLimiter({ maxRequests: 0, windowMs: 1 })).toThrow(RangeError);
    expect(() => new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 0 })).toThrow(RangeError);
  });
});

describe('resolveClientId', () => {
  const headers = new Headers({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18' });

  it('ignores forwarding headers when no proxy is trusted', () => {
    // The header is caller-controlled: trusting it by default would let anyone
    // send a fresh value per request and bypass the limiter entirely.
    expect(
      resolveClientId({ headers, trustProxyHeaders: false, clientIpHeader: 'x-forwarded-for' }),
    ).toBe(UNKNOWN_CLIENT_ID);
  });

  it('takes the left-most entry of the forwarding chain when a proxy is trusted', () => {
    expect(
      resolveClientId({ headers, trustProxyHeaders: true, clientIpHeader: 'x-forwarded-for' }),
    ).toBe('203.0.113.9');
  });

  it('falls back to the shared bucket when the trusted header is absent', () => {
    expect(
      resolveClientId({
        headers: new Headers(),
        trustProxyHeaders: true,
        clientIpHeader: 'x-forwarded-for',
      }),
    ).toBe(UNKNOWN_CLIENT_ID);
  });

  it('reads a custom header name', () => {
    expect(
      resolveClientId({
        headers: new Headers({ 'cf-connecting-ip': '198.51.100.4' }),
        trustProxyHeaders: true,
        clientIpHeader: 'cf-connecting-ip',
      }),
    ).toBe('198.51.100.4');
  });

  it('refuses an over-long header value rather than using it as a map key', () => {
    expect(
      resolveClientId({
        headers: new Headers({ 'x-forwarded-for': 'a'.repeat(500) }),
        trustProxyHeaders: true,
        clientIpHeader: 'x-forwarded-for',
      }),
    ).toBe(UNKNOWN_CLIENT_ID);
  });
});
