import { getAddress, isAddress } from 'viem';

/**
 * Wallet address parsing.
 *
 * Nuxfolio never accepts a raw address string past this module: everything
 * downstream works with a checksummed `0x`-prefixed value produced here.
 */

export type WalletAddress = `0x${string}`;

export type AddressParseResult =
  | { ok: true; address: WalletAddress }
  | { ok: false; reason: AddressRejectionReason; message: string };

export type AddressRejectionReason =
  'empty' | 'name-like' | 'missing-prefix' | 'wrong-length' | 'not-hex' | 'bad-checksum';

const HEX_BODY = /^[0-9a-fA-F]*$/;

/**
 * Validates and normalises a user-supplied EVM address.
 *
 * Mixed-case input is checksum-verified, because a mistyped character in a
 * checksummed address is exactly what the checksum exists to catch. All-lower
 * and all-upper input carries no checksum information and is accepted, then
 * normalised.
 */
export function parseWalletAddress(input: string): AddressParseResult {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return reject('empty', 'Enter a public EVM wallet address.');
  }

  // A dot cannot appear in an address, so this input was meant as a name. ENS
  // names are resolved elsewhere (`src/server/ens.ts`); this function stays pure
  // and ENS-free, and only says what a name that got this far needs to hear.
  if (trimmed.includes('.')) {
    return reject(
      'name-like',
      'That looks like a name rather than an address. Nuxfolio resolves ENS names ending in ".eth"; anything else has to be a 0x address.',
    );
  }

  if (!trimmed.startsWith('0x') && !trimmed.startsWith('0X')) {
    return reject('missing-prefix', 'An EVM address must start with "0x".');
  }

  const body = trimmed.slice(2);

  if (!HEX_BODY.test(body)) {
    return reject('not-hex', 'An EVM address may only contain the characters 0-9 and a-f.');
  }

  if (body.length !== 40) {
    return reject(
      'wrong-length',
      `An EVM address has 40 characters after "0x"; this one has ${body.length}.`,
    );
  }

  // Case-insensitive input carries no checksum, so normalise before validating.
  const candidate = isCaseAmbiguous(body) ? `0x${body.toLowerCase()}` : `0x${body}`;

  if (!isAddress(candidate, { strict: true })) {
    return reject(
      'bad-checksum',
      'This address fails its checksum. Copy it again from your wallet.',
    );
  }

  return { ok: true, address: getAddress(candidate) };
}

/** Shortens an address for display and for logs: `0x1234…cdef`. */
export function shortenAddress(address: string): string {
  if (address.length <= 12) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** True when the hex body is single-case and therefore checksum-free. */
function isCaseAmbiguous(body: string): boolean {
  return body === body.toLowerCase() || body === body.toUpperCase();
}

function reject(reason: AddressRejectionReason, message: string): AddressParseResult {
  return { ok: false, reason, message };
}
