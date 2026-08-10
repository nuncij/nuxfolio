import { describe, expect, it } from 'vitest';

import { ENS_NAME_MAX_LENGTH, parseEnsName } from './ensName';

describe('parseEnsName', () => {
  it('accepts a plain .eth name', () => {
    expect(parseEnsName('vitalik.eth')).toEqual({ ok: true, name: 'vitalik.eth' });
  });

  it('accepts a subdomain', () => {
    expect(parseEnsName('pay.vitalik.eth')).toEqual({ ok: true, name: 'pay.vitalik.eth' });
  });

  it('accepts digits and hyphens inside a label', () => {
    expect(parseEnsName('nux-folio-2.eth')).toMatchObject({ ok: true });
  });

  it('lowercases, because case is not part of an ENS name', () => {
    expect(parseEnsName('Vitalik.ETH')).toEqual({ ok: true, name: 'vitalik.eth' });
  });

  it('trims surrounding whitespace, as pasted input carries it', () => {
    expect(parseEnsName('  vitalik.eth\n')).toEqual({ ok: true, name: 'vitalik.eth' });
  });

  it.each([
    ['an address', '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'],
    ['a bare label', 'vitalik'],
    ['the TLD alone', '.eth'],
    ['a numeric final label, which is an address typo rather than a name', '1.2.3.4'],
    ['a final label starting with a digit', 'vitalik.4chan'],
    ['an empty leading label', '.vitalik.eth'],
    ['an empty inner label', 'pay..vitalik.eth'],
    ['a trailing dot', 'vitalik.eth.'],
    ['an underscore', 'vitalik_two.eth'],
    ['a space inside the name', 'vita lik.eth'],
    ['nothing at all', '   '],
  ])('rejects %s', (_case, input) => {
    expect(parseEnsName(input)).toEqual({ ok: false });
  });

  it('rejects an emoji name rather than hashing an unnormalised one', () => {
    // Resolving these correctly needs UTS-46 normalisation; until that is wired
    // up, refusing is the honest answer. Documented limitation, not an oversight.
    expect(parseEnsName('🚀🚀🚀.eth')).toEqual({ ok: false });
  });

  it('rejects a name longer than a DNS name may be', () => {
    const label = 'a'.repeat(ENS_NAME_MAX_LENGTH);
    expect(parseEnsName(`${label}.eth`)).toEqual({ ok: false });
  });
});

describe('namespaces beyond .eth', () => {
  /**
   * The pattern accepted only `.eth` until 2026-08-10, and the reason recorded was
   * normalisation safety. That reason belongs to the ASCII character class, not to the
   * suffix: an ASCII `.box` name needs exactly as much normalisation as an ASCII `.eth`
   * one. Measured the same day, `nick.box` resolves through ENS while the pattern was
   * rejecting it before a lookup was ever attempted.
   */
  it.each([
    ['a DNS namespace imported into ENS', 'nick.box'],
    ['a subdomain of one', 'gregskril.cb.id'],
    ['an L2 namespace', 'jesse.base.eth'],
    ['a deep subdomain', 'a.b.c.vitalik.eth'],
  ])('recognises %s', (_why, name) => {
    expect(parseEnsName(name)).toEqual({ ok: true, name });
  });

  it('still recognises an ordinary .eth name', () => {
    expect(parseEnsName('vitalik.eth')).toEqual({ ok: true, name: 'vitalik.eth' });
  });

  it('accepts a name that will simply not resolve, rather than pre-judging it', () => {
    // `vitalik.com` is name-shaped. ENS answers "not found" and the page says so, which
    // is a truer answer than refusing to look. The cost is one rate-limited lookup.
    expect(parseEnsName('vitalik.com')).toEqual({ ok: true, name: 'vitalik.com' });
  });

  it('still refuses anything needing normalisation', () => {
    // The protection that actually mattered, unchanged: emoji, mixed scripts and
    // confusables never reach a hash, whatever the suffix.
    for (const name of ['vitalik🚀.box', 'vitаlik.box', 'ｖitalik.eth']) {
      expect(parseEnsName(name)).toEqual({ ok: false });
    }
  });
});
