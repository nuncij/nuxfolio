/**
 * Whether an address the server has been *told* to fetch is safe to fetch.
 *
 * This exists for one caller: CCIP-read (ERC-3668). When an ENS resolver cannot answer
 * on chain it reverts with a list of URLs, and the client is expected to go and ask one.
 * Those URLs are chosen by whoever registered the name — a stranger — so following one
 * unguarded lets any visitor's URL make this server issue requests from inside its own
 * network. Review round 4 called that a blocker and the fix was to turn CCIP off
 * entirely, which cost offchain-resolved names. This module is what turning it back on
 * requires.
 *
 * **Pure, and separate from anything that fetches.** The decision is the security
 * boundary; keeping it a function of a string means it can be tested exhaustively rather
 * than observed occasionally.
 *
 * **It denies by default.** Every range below is listed because it is *not* public.
 * Anything unparseable is denied too: a guard that cannot understand an address cannot
 * vouch for it.
 */

/**
 * IPv4 ranges that must never be reached from here, as `[first, last]` inclusive pairs
 * of 32-bit integers.
 *
 * `169.254.0.0/16` is the one that matters most in practice: `169.254.169.254` is the
 * cloud metadata endpoint on AWS, GCP and Azure, and it was the address round 4's
 * regression test aimed at. The rest are here because "block the metadata address" is a
 * patch and "allow only public unicast" is a rule.
 */
const IPV4_DENIED: readonly (readonly [number, number])[] = [
  [ipv4ToInt('0.0.0.0'), ipv4ToInt('0.255.255.255')], // "this network"
  [ipv4ToInt('10.0.0.0'), ipv4ToInt('10.255.255.255')], // private
  [ipv4ToInt('100.64.0.0'), ipv4ToInt('100.127.255.255')], // carrier-grade NAT
  [ipv4ToInt('127.0.0.0'), ipv4ToInt('127.255.255.255')], // loopback
  [ipv4ToInt('169.254.0.0'), ipv4ToInt('169.254.255.255')], // link-local, incl. metadata
  [ipv4ToInt('172.16.0.0'), ipv4ToInt('172.31.255.255')], // private
  [ipv4ToInt('192.0.0.0'), ipv4ToInt('192.0.0.255')], // IETF protocol assignments
  [ipv4ToInt('192.0.2.0'), ipv4ToInt('192.0.2.255')], // documentation
  [ipv4ToInt('192.168.0.0'), ipv4ToInt('192.168.255.255')], // private
  [ipv4ToInt('198.18.0.0'), ipv4ToInt('198.19.255.255')], // benchmarking
  [ipv4ToInt('198.51.100.0'), ipv4ToInt('198.51.100.255')], // documentation
  [ipv4ToInt('203.0.113.0'), ipv4ToInt('203.0.113.255')], // documentation
  [ipv4ToInt('224.0.0.0'), ipv4ToInt('255.255.255.255')], // multicast, reserved, broadcast
];

/** Why an address was refused, in words a log can carry without leaking the URL. */
export type AddressVerdict = { safe: true } | { safe: false; reason: string };

/**
 * Whether one resolved IP address may be connected to.
 *
 * Takes the address, not a hostname: a hostname is a promise about an address, and the
 * only thing worth checking is the address itself.
 */
export function isPublicAddress(ip: string): AddressVerdict {
  const v4 = parseIpv4(ip);
  if (v4 !== null) {
    return checkIpv4(v4, ip);
  }

  const v6 = parseIpv6(ip);
  if (v6 === null) {
    return { safe: false, reason: 'not an IP address this guard can parse' };
  }

  // An IPv4-mapped or IPv4-translated address is an IPv4 address wearing a hat, and
  // `::ffff:169.254.169.254` reaches the metadata endpoint exactly as the bare form
  // does. Unwrap before judging, or the v6 branch becomes a way around the v4 rules.
  const embedded = embeddedIpv4(v6);
  if (embedded !== null) {
    return checkIpv4(embedded, ip);
  }

  return checkIpv6(v6, ip);
}

function checkIpv4(value: number, original: string): AddressVerdict {
  for (const [first, last] of IPV4_DENIED) {
    if (value >= first && value <= last) {
      return { safe: false, reason: `${original} is in a reserved or private IPv4 range` };
    }
  }
  return { safe: true };
}

function checkIpv6(groups: readonly number[], original: string): AddressVerdict {
  const denied =
    isUnspecified(groups) ||
    isLoopback(groups) ||
    // fc00::/7 — unique local.
    (groups[0]! & 0xfe00) === 0xfc00 ||
    // fe80::/10 — link-local.
    (groups[0]! & 0xffc0) === 0xfe80 ||
    // ff00::/8 — multicast.
    (groups[0]! & 0xff00) === 0xff00 ||
    // 100::/64 — discard-only.
    (groups[0] === 0x0100 && groups.slice(1, 4).every((group) => group === 0)) ||
    // 2001:db8::/32 — documentation.
    (groups[0] === 0x2001 && groups[1] === 0x0db8) ||
    // 2002::/16 — 6to4 encodes an IPv4 address in the next 32 bits, which may be private.
    groups[0] === 0x2002;

  return denied
    ? { safe: false, reason: `${original} is in a reserved or private IPv6 range` }
    : { safe: true };
}

const isUnspecified = (groups: readonly number[]) => groups.every((group) => group === 0);
const isLoopback = (groups: readonly number[]) =>
  groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1;

/**
 * The IPv4 address inside an IPv4-mapped (`::ffff:a.b.c.d`) or IPv4-translated
 * (`64:ff9b::a.b.c.d`) IPv6 address, or null when there is none.
 */
function embeddedIpv4(groups: readonly number[]): number | null {
  const mapped =
    groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff
      ? ((groups[6]! << 16) | groups[7]!) >>> 0
      : null;
  if (mapped !== null) {
    return mapped;
  }

  // 64:ff9b::/96 and 64:ff9b:1::/48, the NAT64 well-known prefixes.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
    return ((groups[6]! << 16) | groups[7]!) >>> 0;
  }
  return null;
}

/** Dotted-quad to a 32-bit integer, or null when it is not a dotted quad. */
function parseIpv4(value: string): number | null {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }
  let result = 0;
  for (const part of parts) {
    // Rejects '', '01', '1e2', '+1' and anything else `Number` would be generous about.
    // A leading zero is refused rather than read as octal, which is how `0177.0.0.1`
    // reaches loopback on some resolvers.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    result = (result << 8) | octet;
  }
  return result >>> 0;
}

/** Eight 16-bit groups, or null when the string is not an IPv6 address. */
function parseIpv6(value: string): number[] | null {
  const withoutZone = value.split('%')[0] ?? '';
  if (withoutZone.length === 0 || withoutZone.split('::').length > 2) {
    return null;
  }

  const [head, tail] = withoutZone.includes('::')
    ? withoutZone.split('::')
    : [withoutZone, undefined];

  const parseSide = (side: string): number[] | null => {
    if (side.length === 0) {
      return [];
    }
    const groups: number[] = [];
    const parts = side.split(':');
    for (const [index, part] of parts.entries()) {
      // A trailing dotted quad, as in `::ffff:1.2.3.4`.
      if (part.includes('.')) {
        if (index !== parts.length - 1) {
          return null;
        }
        const v4 = parseIpv4(part);
        if (v4 === null) {
          return null;
        }
        groups.push(v4 >>> 16, v4 & 0xffff);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) {
        return null;
      }
      groups.push(Number.parseInt(part, 16));
    }
    return groups;
  };

  const left = parseSide(head ?? '');
  const right = tail === undefined ? [] : parseSide(tail);
  if (left === null || right === null) {
    return null;
  }

  if (tail === undefined) {
    return left.length === 8 ? left : null;
  }

  const missing = 8 - left.length - right.length;
  if (missing < 1) {
    return null;
  }
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function ipv4ToInt(value: string): number {
  const parsed = parseIpv4(value);
  if (parsed === null) {
    throw new Error(`not an IPv4 address: ${value}`);
  }
  return parsed;
}
