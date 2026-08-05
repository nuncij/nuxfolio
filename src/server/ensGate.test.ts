import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { createRecordingLogger, silentLogger, TEST_ADDRESS } from '@/test/helpers';

import type { EnsResolution } from './ens';
import { resolveEnsNameGated, type EnsGateDependencies } from './ensGate';
import { FixedWindowRateLimiter } from './rateLimit';

/**
 * The gate, not the resolution: everything here injects a fake resolver, because
 * what is under test is the decision "will we look right now" — the lookup itself
 * has its own suite in ens.test.ts.
 */

const RESOLVED: EnsResolution = { ok: true, address: TEST_ADDRESS };

function gate(overrides: Partial<EnsGateDependencies> = {}) {
  const resolve = vi.fn(async () => RESOLVED);
  const dependencies: EnsGateDependencies = {
    limiter: new FixedWindowRateLimiter({ maxRequests: 2, windowMs: 60_000 }),
    resolve,
    trustProxyHeaders: true,
    clientIpHeader: 'x-forwarded-for',
    logger: silentLogger(),
    ...overrides,
  };
  return { dependencies, resolve };
}

function fromIp(ip: string): Headers {
  return new Headers({ 'x-forwarded-for': ip });
}

describe('resolveEnsNameGated', () => {
  it('resolves while the caller has budget', async () => {
    const { dependencies, resolve } = gate();

    const result = await resolveEnsNameGated('vitalik.eth', fromIp('10.0.0.1'), dependencies);

    expect(result).toEqual(RESOLVED);
    expect(resolve).toHaveBeenCalledWith('vitalik.eth');
  });

  it('refuses once the budget is spent — and does not resolve', async () => {
    // The refusal has to happen before the lookup, not after: the whole point is
    // that a denied request costs zero upstream calls.
    const { dependencies, resolve } = gate();
    const headers = fromIp('10.0.0.1');

    await resolveEnsNameGated('a.eth', headers, dependencies);
    await resolveEnsNameGated('b.eth', headers, dependencies);
    const third = await resolveEnsNameGated('c.eth', headers, dependencies);

    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.reason).toBe('rate-limited');
      expect(third.message).toContain('wait');
      expect(third.message).toContain('0x address');
    }
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('gives each identified caller an independent budget', async () => {
    const { dependencies, resolve } = gate();

    await resolveEnsNameGated('a.eth', fromIp('10.0.0.1'), dependencies);
    await resolveEnsNameGated('b.eth', fromIp('10.0.0.1'), dependencies);
    const otherCaller = await resolveEnsNameGated('c.eth', fromIp('10.0.0.2'), dependencies);

    expect(otherCaller.ok).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('pools unidentified callers into the shared bucket with its larger allowance', async () => {
    // With proxy headers untrusted (the default), every caller is `unknown`. The
    // bucket is shared, so its allowance is the limiter's larger unknown budget —
    // ADR-008's argument, inherited unchanged.
    const { dependencies, resolve } = gate({
      trustProxyHeaders: false,
      limiter: new FixedWindowRateLimiter({
        maxRequests: 2,
        windowMs: 60_000,
        unknownMaxRequests: 3,
      }),
    });

    // Spoofed forwarding headers must not mint fresh budgets when untrusted.
    await resolveEnsNameGated('a.eth', fromIp('1.1.1.1'), dependencies);
    await resolveEnsNameGated('b.eth', fromIp('2.2.2.2'), dependencies);
    await resolveEnsNameGated('c.eth', fromIp('3.3.3.3'), dependencies);
    const fourth = await resolveEnsNameGated('d.eth', fromIp('4.4.4.4'), dependencies);

    expect(fourth.ok).toBe(false);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('says how long to wait, in seconds a person can act on', async () => {
    const { dependencies } = gate({
      limiter: new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 45_000 }),
    });
    const headers = fromIp('10.0.0.1');

    await resolveEnsNameGated('a.eth', headers, dependencies);
    const denied = await resolveEnsNameGated('b.eth', headers, dependencies);

    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.message).toMatch(/\d+ seconds?/);
    }
  });

  it('never resolves without a limiter decision, whatever the caller passes', async () => {
    // The gate takes its limiter from the module when none is injected, so there is
    // no "skip the check" shape available to a caller — omitting dependencies must
    // not mean omitting the gate.
    const resolve = vi.fn(async () => RESOLVED);
    const limiter = new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const spy = vi.spyOn(limiter, 'check');

    await resolveEnsNameGated('a.eth', fromIp('10.0.0.1'), {
      limiter,
      resolve,
      logger: silentLogger(),
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('tells the operator, with the same signal shape as the API', async () => {
    const { logger, lines } = createRecordingLogger();
    const { dependencies } = gate({
      limiter: new FixedWindowRateLimiter({ maxRequests: 1, windowMs: 60_000 }),
      logger,
    });
    const headers = fromIp('10.0.0.1');

    await resolveEnsNameGated('a.eth', headers, dependencies);
    await resolveEnsNameGated('b.eth', headers, dependencies);

    const warned = lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.event === 'ens.rate_limited');
    expect(warned).toBeDefined();
    expect(warned).toMatchObject({ clientIdentified: true });
  });
});

/**
 * The tests above prove the gate works. These prove **the page uses it** — which is
 * the property that actually protects the deployment, and the one review round 11
 * pointed out was untested: the gate could have been perfect while `page.tsx`
 * called the ungated resolver, with all six tests still green.
 *
 * Asserted by reading the source, in the same spirit as the palette contrast guard
 * parsing `globals.css`: a stated intention turned into something that fails.
 * Rendering an App Router server component in vitest would need a request scope for
 * `headers()`, which buys a heavier test for a weaker assertion.
 */
describe('the page boundary', () => {
  const pageSource = readFileSync('src/app/portfolio/[address]/page.tsx', 'utf8');
  const routeSource = readFileSync('src/server/addressRoute.ts', 'utf8');

  it('resolves names through the gate, not the raw resolver', () => {
    expect(pageSource).toContain('resolveEnsNameGated');
  });

  // Matched against import statements rather than the whole file: both modules
  // *discuss* `resolveEnsName` in comments explaining why they must not call it, and
  // a check that forbids naming the hazard would forbid documenting it.
  const valueImportOfRawResolver = /import\s*\{[^}]*\bresolveEnsName\b[^}]*\}/;

  it('never imports the ungated resolver into the page', () => {
    // The precise failure to prevent: someone reaches for `resolveEnsName` because
    // it is the obvious name, and the rate limiter quietly stops applying.
    expect(pageSource).not.toMatch(valueImportOfRawResolver);
  });

  it('leaves the route with no ungated fallback to fall back to', () => {
    // `resolve` is mandatory in PortfolioRouteInput, so deleting the wiring in the
    // page is a type error rather than a silent regression. This pins that the
    // module keeps no default resolver of its own to fall back to.
    expect(routeSource).not.toMatch(valueImportOfRawResolver);
    expect(routeSource).toMatch(/resolve:\s*\(name: string\)/);
  });

  it('reads request headers only where a name is being resolved', () => {
    // A plain 0x render must not touch request state — cheap to keep true, and the
    // reason the gate costs nothing on the common path.
    const headerReads = pageSource.match(/await headers\(\)/g) ?? [];
    expect(headerReads).toHaveLength(1);
    expect(pageSource).toMatch(/resolveEnsNameGated\(name, await headers\(\)\)/);
  });
});
