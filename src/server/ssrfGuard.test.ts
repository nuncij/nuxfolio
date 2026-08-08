import { describe, expect, it } from 'vitest';

import { isPublicAddress } from './ssrfGuard';

/**
 * The control that review round 4 removed CCIP-read to avoid needing. Its whole value is
 * in the cases it refuses, so those are enumerated rather than sampled — a guard tested
 * on the addresses you thought of is a guard tested on the addresses an attacker will
 * not use.
 */

const safe = (ip: string) => isPublicAddress(ip).safe;

describe('the addresses that made this necessary', () => {
  it('refuses the cloud metadata endpoint', () => {
    // 169.254.169.254 on AWS, GCP and Azure. This is the exact address round 4's
    // regression test aimed at, and the reason CCIP was switched off.
    expect(safe('169.254.169.254')).toBe(false);
  });

  it('refuses it however it is spelled', () => {
    // An IPv4-mapped v6 address reaches the same host. Judging the v6 form by v6 rules
    // would let the whole v4 table be bypassed by prefixing `::ffff:`.
    expect(safe('::ffff:169.254.169.254')).toBe(false);
    expect(safe('::FFFF:169.254.169.254')).toBe(false);
    expect(safe('64:ff9b::169.254.169.254')).toBe(false);
  });

  it('refuses loopback in both families', () => {
    expect(safe('127.0.0.1')).toBe(false);
    expect(safe('127.1.2.3')).toBe(false);
    expect(safe('::1')).toBe(false);
    expect(safe('0:0:0:0:0:0:0:1')).toBe(false);
    expect(safe('::ffff:127.0.0.1')).toBe(false);
  });

  it('refuses every private IPv4 range', () => {
    for (const ip of [
      '10.0.0.1',
      '10.255.255.254',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
    ]) {
      expect(safe(ip), ip).toBe(false);
    }
  });

  it('allows the addresses either side of a private range', () => {
    // The boundaries are where an off-by-one lives, and being too strict is a real cost:
    // 172.15.x and 172.32.x are ordinary public space.
    expect(safe('172.15.255.255')).toBe(true);
    expect(safe('172.32.0.0')).toBe(true);
    expect(safe('9.255.255.255')).toBe(true);
    expect(safe('11.0.0.0')).toBe(true);
  });

  it('refuses the ranges people forget', () => {
    expect(safe('100.64.0.1')).toBe(false); // carrier-grade NAT
    expect(safe('0.0.0.0')).toBe(false); // "this network"
    expect(safe('255.255.255.255')).toBe(false); // broadcast
    expect(safe('224.0.0.1')).toBe(false); // multicast
    expect(safe('198.18.0.1')).toBe(false); // benchmarking
    expect(safe('192.0.0.1')).toBe(false); // IETF assignments
  });

  it('refuses private IPv6', () => {
    expect(safe('fc00::1')).toBe(false); // unique local
    expect(safe('fd12:3456::1')).toBe(false); // unique local
    expect(safe('fe80::1')).toBe(false); // link-local
    expect(safe('ff02::1')).toBe(false); // multicast
    expect(safe('::')).toBe(false); // unspecified
    expect(safe('2002:a9fe:a9fe::1')).toBe(false); // 6to4 wrapping link-local
  });
});

describe('what it still allows, because refusing everything is not a guard', () => {
  it('allows ordinary public addresses', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '104.16.0.1', '2606:4700::1111', '2a00:1450::1']) {
      expect(safe(ip), ip).toBe(true);
    }
  });
});

describe('the notations that get past a naive parser', () => {
  it('refuses a leading zero rather than reading it as octal', () => {
    // `0177.0.0.1` is loopback to any resolver that reads octal, and 177.0.0.1 to one
    // that does not. Refusing the ambiguity is the only answer that is right either way.
    expect(safe('0177.0.0.1')).toBe(false);
    expect(safe('010.0.0.1')).toBe(false);
  });

  it('refuses a decimal or hex integer address', () => {
    // `2130706433` and `0x7f000001` are both 127.0.0.1 to `fetch`. Neither is a dotted
    // quad, so neither parses, so both are denied — which is the point of denying by
    // default rather than allowing what is not recognised.
    expect(safe('2130706433')).toBe(false);
    expect(safe('0x7f000001')).toBe(false);
    expect(safe('127.1')).toBe(false);
  });

  it('refuses an octet out of range or a malformed quad', () => {
    expect(safe('256.1.1.1')).toBe(false);
    expect(safe('1.2.3')).toBe(false);
    expect(safe('1.2.3.4.5')).toBe(false);
    expect(safe('1.2.3.-1')).toBe(false);
    expect(safe('1.2.3. 4')).toBe(false);
  });

  it('refuses anything it cannot parse at all', () => {
    // Including a hostname: this function judges addresses. Passing it a name means the
    // caller has not resolved yet, and a guard that returns "safe" for `evil.test`
    // would be worse than no guard.
    expect(safe('example.com')).toBe(false);
    expect(safe('')).toBe(false);
    expect(safe('::ffff:zzzz')).toBe(false);
    expect(safe('1:2:3:4:5:6:7:8:9')).toBe(false);
    expect(safe('1::2::3')).toBe(false);
  });

  it('ignores a zone index rather than being confused by one', () => {
    expect(safe('fe80::1%eth0')).toBe(false);
  });
});

describe('the verdict carries a reason', () => {
  it('says why, without needing the caller to guess', () => {
    const verdict = isPublicAddress('169.254.169.254');

    expect(verdict.safe).toBe(false);
    expect(verdict.safe === false && verdict.reason).toMatch(/reserved or private IPv4/);
  });
});

describe('the addresses an independent review found walking through', () => {
  /**
   * Every one of these was `safe: true` when the IPv6 half denied a list and allowed the
   * rest — while the module's own comment claimed it denied by default. They are pinned
   * individually because the fix was to invert the rule, and a future edit that reverts
   * to a deny-list would pass a test that only checked a couple of them.
   */
  it('refuses local-use NAT64, which is not the well-known prefix', () => {
    // 64:ff9b:1::/48 embeds an IPv4 address that says nothing about where the local
    // translator actually sends the packet, so unwrapping it was the mistake.
    expect(safe('64:ff9b:1::8.8.8.8')).toBe(false);
  });

  it('refuses deprecated site-local', () => {
    expect(safe('fec0::1')).toBe(false);
  });

  it('refuses the discard prefix beyond the first four groups', () => {
    // The old check required groups 1-3 to be zero, so this walked past it.
    expect(safe('100:0:0:1::1')).toBe(false);
  });

  it('refuses reserved space outside global unicast', () => {
    expect(safe('5f00::1')).toBe(false);
    expect(safe('4000::1')).toBe(false);
    expect(safe('1000::1')).toBe(false);
  });

  it('refuses benchmarking, documentation and Teredo inside global unicast', () => {
    expect(safe('2001:2::1')).toBe(false);
    expect(safe('3fff::1')).toBe(false);
    expect(safe('2001:0:c000:201::1')).toBe(false);
  });

  it('refuses the IPv4-compatible form that reached the metadata address', () => {
    // `::a.b.c.d`. Deprecated, never legitimate, and the clearest bypass of the lot.
    expect(safe('::169.254.169.254')).toBe(false);
    expect(safe('::127.0.0.1')).toBe(false);
    expect(safe('::8.8.8.8')).toBe(false);
  });

  it('refuses the 6to4 relay anycast IPv4 range', () => {
    expect(safe('192.88.99.2')).toBe(false);
  });

  it('still allows a genuine global-unicast address', () => {
    // The inversion must not have closed the door on everything.
    expect(safe('2606:4700:4700::1111')).toBe(true);
    expect(safe('2a00:1450:4001::200e')).toBe(true);
    expect(safe('64:ff9b::8.8.8.8')).toBe(true);
  });
});
