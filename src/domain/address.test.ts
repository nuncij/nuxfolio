import { describe, expect, it } from 'vitest';

import { parseWalletAddress, shortenAddress } from './address';

const CHECKSUMMED = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const LOWERCASE = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

describe('parseWalletAddress', () => {
  it('accepts a checksummed address unchanged', () => {
    const result = parseWalletAddress(CHECKSUMMED);
    expect(result).toEqual({ ok: true, address: CHECKSUMMED });
  });

  it('normalises an all-lowercase address to its checksummed form', () => {
    const result = parseWalletAddress(LOWERCASE);
    expect(result.ok && result.address).toBe(CHECKSUMMED);
  });

  it('normalises an all-uppercase address, including an uppercase 0X prefix', () => {
    const result = parseWalletAddress(`0X${LOWERCASE.slice(2).toUpperCase()}`);
    expect(result.ok && result.address).toBe(CHECKSUMMED);
  });

  it('trims surrounding whitespace, which pasting routinely introduces', () => {
    const result = parseWalletAddress(`  ${CHECKSUMMED}\n`);
    expect(result.ok && result.address).toBe(CHECKSUMMED);
  });

  it('rejects an empty input', () => {
    const result = parseWalletAddress('   ');
    expect(result).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('rejects a name, leaving ENS resolution to the layer that owns it', () => {
    // `parseWalletAddress` never resolves anything: a name-shaped input is
    // rejected here and picked up by the ENS path before this is ever reached.
    const result = parseWalletAddress('vitalik.eth');
    expect(result).toMatchObject({ ok: false, reason: 'name-like' });
    expect(result.ok === false && result.message).toContain('0x');
    expect(result.ok === false && result.message).toContain('.eth');
  });

  it('rejects a missing 0x prefix', () => {
    const result = parseWalletAddress(LOWERCASE.slice(2));
    expect(result).toMatchObject({ ok: false, reason: 'missing-prefix' });
  });

  it('rejects an address that is one character short', () => {
    const result = parseWalletAddress(LOWERCASE.slice(0, -1));
    expect(result).toMatchObject({ ok: false, reason: 'wrong-length' });
    expect(result.ok === false && result.message).toContain('39');
  });

  it('rejects an address that is one character too long', () => {
    const result = parseWalletAddress(`${LOWERCASE}0`);
    expect(result).toMatchObject({ ok: false, reason: 'wrong-length' });
  });

  it('rejects non-hex characters', () => {
    const result = parseWalletAddress(`0x${'z'.repeat(40)}`);
    expect(result).toMatchObject({ ok: false, reason: 'not-hex' });
  });

  it('rejects a mixed-case address whose checksum does not match', () => {
    // Same address, first nibble's case flipped: valid hex, invalid checksum.
    const tampered = `0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045`;
    const result = parseWalletAddress(tampered);
    expect(result).toMatchObject({ ok: false, reason: 'bad-checksum' });
  });

  it('accepts the zero address, which is a real address and not an error', () => {
    const result = parseWalletAddress(`0x${'0'.repeat(40)}`);
    expect(result.ok).toBe(true);
  });
});

describe('shortenAddress', () => {
  it('keeps the leading and trailing characters that let a user recognise an address', () => {
    expect(shortenAddress(CHECKSUMMED)).toBe('0xd8dA…6045');
  });

  it('leaves short strings alone rather than producing nonsense', () => {
    expect(shortenAddress('0x1234')).toBe('0x1234');
  });
});
