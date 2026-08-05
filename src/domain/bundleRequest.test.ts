import { describe, expect, it } from 'vitest';

import {
  BUNDLE_MAX_MEMBERS,
  BUNDLE_MAX_RAW_LENGTH,
  BUNDLE_MAX_SEGMENTS,
  bundlePath,
  parseBundleRequest,
  shouldRenderBundle,
} from './bundleRequest';
import type { WalletAddress } from './address';

const A = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const B = '0x3333333333333333333333333333333333333333';
const C = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

/** Distinct valid addresses, for the cap tests. */
function generated(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `0x${index.toString(16).padStart(40, '0')}`);
}

describe('parseBundleRequest', () => {
  it('accepts a comma-separated list and keeps the order given', () => {
    // A shared link must render identically for everyone who opens it.
    const request = parseBundleRequest(`${A},${B},${C}`);
    expect(request.addresses).toEqual([A, B, C]);
    expect(request.rejected).toEqual([]);
  });

  it('checksums an all-lowercase address', () => {
    expect(parseBundleRequest(B.toLowerCase()).addresses).toEqual([B]);
  });

  it('removes duplicates and counts them', () => {
    // The money rule: totalling one wallet twice would overstate by 100 % and look
    // entirely plausible.
    const request = parseBundleRequest(`${A},${A},${B}`);
    expect(request.addresses).toEqual([A, B]);
    expect(request.duplicateCount).toBe(1);
  });

  it('treats differently-cased forms of one address as one wallet', () => {
    const request = parseBundleRequest(`${B},${B.toLowerCase()}`);
    expect(request.addresses).toHaveLength(1);
    expect(request.duplicateCount).toBe(1);
  });

  it('names an input that is not an address rather than dropping it', () => {
    const request = parseBundleRequest(`${A},not-an-address,${B}`);
    expect(request.addresses).toEqual([A, B]);
    expect(request.rejected).toEqual([{ input: 'not-an-address', reason: 'not-an-address' }]);
  });

  it('tells an ENS name apart from nonsense, because the answer differs', () => {
    // "Use the single-wallet route" is a different message from "that is not an
    // address", and a name is a reasonable thing to have tried.
    const request = parseBundleRequest(`${A},vitalik.eth`);
    expect(request.rejected).toEqual([{ input: 'vitalik.eth', reason: 'ens-name' }]);
  });

  it('truncates a very long rejected input so it stays renderable', () => {
    const request = parseBundleRequest(`${A},${'z'.repeat(200)}`);
    expect(request.rejected[0]?.input.length).toBeLessThan(40);
    expect(request.rejected[0]?.input.endsWith('…')).toBe(true);
  });

  it('ignores empty segments from stray or trailing commas', () => {
    expect(parseBundleRequest(`${A},,${B},`).addresses).toEqual([A, B]);
    expect(parseBundleRequest(`${A},,${B},`).rejected).toEqual([]);
  });

  it('trims whitespace around segments', () => {
    expect(parseBundleRequest(` ${A} , ${B} `).addresses).toEqual([A, B]);
  });

  it('caps accepted wallets and says how many were left out', () => {
    const request = parseBundleRequest(generated(BUNDLE_MAX_MEMBERS + 3).join(','));
    expect(request.addresses).toHaveLength(BUNDLE_MAX_MEMBERS);
    expect(request.omittedCount).toBe(3);
  });

  it('applies the cap after validation, not before', () => {
    // Twelve junk segments followed by two real ones must not crowd the real ones
    // out. Capping the raw list first would do exactly that.
    const junk = Array.from({ length: 12 }, (_, index) => `junk${index}`);
    const request = parseBundleRequest([...junk, A, B].join(','));
    expect(request.addresses).toEqual([A, B]);
    expect(request.rejected).toHaveLength(12);
    expect(request.omittedCount).toBe(0);
  });

  it('bounds the raw input before parsing it', () => {
    // An unbounded segment is an attacker-controlled amount of parsing work.
    const request = parseBundleRequest('x'.repeat(BUNDLE_MAX_RAW_LENGTH * 4));
    expect(request.addresses).toEqual([]);
    // Truncated to one oversized segment, so it is reported once rather than
    // producing thousands of rejections.
    expect(request.rejected).toHaveLength(1);
  });

  it('bounds the number of segments and says how many it ignored', () => {
    const many = Array.from({ length: BUNDLE_MAX_SEGMENTS + 5 }, () => 'junk');
    const request = parseBundleRequest(many.join(','));
    const overflow = request.rejected.find((entry) => entry.reason === 'too-many-segments');
    expect(overflow?.input).toBe('5 more');
  });

  it('returns nothing for an empty path', () => {
    expect(parseBundleRequest('')).toEqual({
      addresses: [],
      rejected: [],
      duplicateCount: 0,
      omittedCount: 0,
    });
  });
});

describe('shouldRenderBundle', () => {
  it('renders two or more wallets', () => {
    expect(shouldRenderBundle(parseBundleRequest(`${A},${B}`))).toBe(true);
  });

  it('renders one wallet when there is something to report about the rest', () => {
    // Redirecting to the single-wallet view would erase the notice — the page cannot
    // say what it dropped once it is no longer the page.
    expect(shouldRenderBundle(parseBundleRequest(`${A},garbage`))).toBe(true);
    expect(shouldRenderBundle(parseBundleRequest(`${A},${A}`))).toBe(true);
  });

  it('does not render one wallet when there is nothing to report', () => {
    // Nothing was lost, so the ordinary portfolio view is the better page.
    expect(shouldRenderBundle(parseBundleRequest(A))).toBe(false);
  });

  it('does not render an empty request', () => {
    expect(shouldRenderBundle(parseBundleRequest('garbage'))).toBe(false);
    expect(shouldRenderBundle(parseBundleRequest(''))).toBe(false);
  });
});

describe('bundlePath', () => {
  it('round-trips through the parser', () => {
    const addresses = [A, B] as WalletAddress[];
    expect(parseBundleRequest(bundlePath(addresses).replace('/bundle/', '')).addresses).toEqual(
      addresses,
    );
  });
});
