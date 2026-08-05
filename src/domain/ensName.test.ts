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
    ['another TLD', 'vitalik.com'],
    ['a near-miss TLD', 'vitalik.ethereum'],
    ['the TLD alone', '.eth'],
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
