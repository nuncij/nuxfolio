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
 * **It denies by default, in both families.** IPv4 works from a table of ranges that are
 * not public; IPv6 allows only global unicast and carves out what is not reachable
 * inside it. The IPv6 half originally denied a list and allowed the rest, and a review
 * found six addresses that walked through — `fec0::1`, `100:0:0:1::1`, `::127.0.0.1` and
 * others — while this very comment claimed otherwise. Anything unparseable is denied
 * too: a guard that cannot understand an address cannot vouch for it.
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
  [ipv4ToInt('192.88.99.0'), ipv4ToInt('192.88.99.255')], // 6to4 relay anycast, deprecated
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

/**
 * IPv6, allowed only inside global unicast.
 *
 * This was written the other way round — deny a list, allow the rest — and Codex's
 * review found six addresses that walked through it, including `fec0::1` and
 * `100:0:0:1::1`. Worse, the module's own comment claimed it denied by default while
 * this function did the opposite, which is how a guard ends up trusted for something it
 * does not do.
 *
 * Global unicast is `2000::/3`. Everything outside it is documentation, reserved,
 * link-local, unique-local, multicast or a transition prefix, and none of those is a
 * gateway. Inside it, a few carve-outs are not globally reachable either.
 */
function checkIpv6(groups: readonly number[], original: string): AddressVerdict {
  const deny = (why: string): AddressVerdict => ({ safe: false, reason: `${original} is ${why}` });

  // `::a.b.c.d` — IPv4-compatible, deprecated, and the form that reached the metadata
  // address past the old rules. Never legitimate, so refused rather than unwrapped.
  if (groups.slice(0, 6).every((group) => group === 0)) {
    return deny('an IPv4-compatible IPv6 address, which is deprecated');
  }

  // 2000::/3 is the only globally routable range. Outside it, deny without a list.
  if ((groups[0]! & 0xe000) !== 0x2000) {
    return deny('outside IPv6 global unicast (2000::/3)');
  }

  const carveOuts: readonly (readonly [string, boolean])[] = [
    ['2001::/32, Teredo', groups[0] === 0x2001 && groups[1] === 0x0000],
    ['2001:2::/48, benchmarking', groups[0] === 0x2001 && groups[1] === 0x0002],
    ['2001:db8::/32, documentation', groups[0] === 0x2001 && groups[1] === 0x0db8],
    ['2002::/16, 6to4', groups[0] === 0x2002],
    ['3fff::/20, documentation', (groups[0]! & 0xfff0) === 0x3ff0],
  ];
  const hit = carveOuts.find(([, matches]) => matches);

  return hit === undefined ? { safe: true } : deny(`in ${hit[0]}, which is not globally reachable`);
}

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

  // 64:ff9b::/96, the *well-known* NAT64 prefix, where the last 32 bits are the IPv4
  // address being translated. `64:ff9b:1::/48` is the local-use prefix and is a
  // different thing: it is denied outright by `checkIpv6` rather than unwrapped, because
  // its embedded address says nothing about where the translator sends the packet.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)) {
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
