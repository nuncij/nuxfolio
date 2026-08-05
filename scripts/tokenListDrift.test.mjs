import { describe, expect, it } from 'vitest';

import {
  NET_SHRINK_FLOOR,
  REMOVAL_FLOOR,
  compareTokenLists,
  overallVerdict,
  renderDriftReport,
  renderDriftTitle,
} from './tokenListDrift.mjs';

/** A token list of `count` distinct tokens, addresses derived from the index. */
function listOf(count, overrides = {}) {
  return {
    chainId: 1,
    sourceVersion: '1.0.0',
    generatedAt: '2026-07-01T00:00:00.000Z',
    tokens: Array.from({ length: count }, (_unused, index) => ({
      address: `0x${String(index).padStart(40, '0')}`,
      name: `Token ${index}`,
      symbol: `T${index}`,
      decimals: 18,
    })),
    ...overrides,
  };
}

/**
 * A list where `count` tokens were delisted and `count` new ones listed — the ordinary
 * case, and the one that separates the two removal tests: the *gross* count moved but
 * the net size did not.
 */
function churnedList(size, count) {
  const list = listOf(size);
  list.tokens.splice(0, count);
  for (let index = 0; index < count; index += 1) {
    list.tokens.push({
      address: `0x${String(index).padStart(40, 'f')}`,
      name: `Newly listed ${index}`,
      symbol: `N${index}`,
      decimals: 18,
    });
  }
  return list;
}

/** A 5,000-token list with 2,000 dropped, optionally with a decimals change too. */
function truncatedList(withDecimalsChange = false) {
  const list = listOf(5_000);
  list.tokens.splice(0, 2_000);
  if (withDecimalsChange) {
    list.tokens[10] = { ...list.tokens[10], decimals: 6 };
  }
  return list;
}

/** A 100-token list where one token's decimals moved. */
function decimalsChangedList() {
  const list = listOf(100);
  list.tokens[7] = { ...list.tokens[7], decimals: 6 };
  return list;
}

describe('compareTokenLists', () => {
  it('reports an identical list as unchanged', () => {
    const report = compareTokenLists('ethereum', listOf(100), listOf(100));

    expect(report.verdict).toBe('unchanged');
    expect(report).toMatchObject({
      added: [],
      removed: [],
      decimalsChanged: [],
      relabelled: [],
      reasons: [],
    });
  });

  it('names what was added and removed', () => {
    const previous = listOf(100);
    const next = listOf(101);
    next.tokens.splice(0, 1); // drop token 0, so 100 -> 100 with one in and one out

    const report = compareTokenLists('ethereum', previous, next);

    expect(report.added.map((token) => token.symbol)).toEqual(['T100']);
    expect(report.removed.map((token) => token.symbol)).toEqual(['T0']);
    expect(report.verdict).toBe('changed');
  });

  it('treats a handful of delistings replaced by new listings as ordinary', () => {
    const report = compareTokenLists(
      'ethereum',
      listOf(5_000),
      churnedList(5_000, REMOVAL_FLOOR - 1),
    );

    expect(report.removed).toHaveLength(REMOVAL_FLOOR - 1);
    expect(report.added).toHaveLength(REMOVAL_FLOOR - 1);
    expect(report.verdict).toBe('changed');
    expect(report.reasons).toEqual([]);
  });

  it('flags a truncated response', () => {
    const previous = listOf(5_000);
    const next = listOf(5_000);
    next.tokens.splice(0, 2_000);

    const report = compareTokenLists('ethereum', previous, next);

    expect(report.verdict).toBe('attention');
    expect(report.reasons[0]).toContain('2000 of 5000 tokens removed');
    expect(report.reasons[0]).toContain('40.0 %');
  });

  it('ranks a mass removal above a decimals change', () => {
    // A truncated list makes every other field in the file suspect, so it is the
    // finding that has to be reported first. Found by rehearsing on real data: this
    // run used to announce itself as "1 token changed decimals".
    const previous = listOf(5_000);
    const next = listOf(5_000);
    next.tokens.splice(0, 2_000);
    next.tokens[10] = { ...next.tokens[10], decimals: 6 };

    const report = compareTokenLists('ethereum', previous, next);

    // Three findings: gross removal and net shrink are both rank 1, decimals is rank 2.
    expect(report.reasons).toHaveLength(3);
    expect(report.reasons[0]).toContain('tokens removed');
    expect(report.reasons[1]).toContain('tokens smaller');
    expect(report.reasons[2]).toContain('changed decimals');
    expect(report.severity).toBe(1);
  });

  it('ranks a moved chain id above everything', () => {
    const previous = listOf(5_000);
    const next = listOf(5_000, { chainId: 8453 });
    next.tokens.splice(0, 2_000);

    const report = compareTokenLists('ethereum', previous, next);

    expect(report.reasons[0]).toContain('chain id changed');
    expect(report.severity).toBe(0);
  });

  it('gives a chain with nothing to report the lowest severity', () => {
    expect(compareTokenLists('ethereum', listOf(10), listOf(10)).severity).toBe(Infinity);
  });

  // The two tests below are the pair that pins the *gross* test to both of its
  // thresholds rather than either: a share test alone is jumpy on a 247-token list, and
  // a count test alone is meaningless on a 5,000-token one. Both use churn, so the net
  // size holds still and only the gross test is under examination.
  it('does not flag much churn that is a small share of a large list', () => {
    // 60 tokens: above the floor of 25, but 1.2 % — below the share.
    expect(compareTokenLists('ethereum', listOf(5_000), churnedList(5_000, 60)).verdict).toBe(
      'changed',
    );
  });

  it('does not flag a large share that is only a few tokens', () => {
    // 6 of 30 is 20 % of the list, but only 6 tokens — below the floor.
    expect(compareTokenLists('optimism', listOf(30), churnedList(30, 6)).verdict).toBe('changed');
  });

  it('flags erosion the gross test is too coarse to see', () => {
    // 40 removed from 5,000 clears the floor of 25 but not the 2 % share, so the gross
    // test stays quiet. The net test is what catches it — this is round 9's F-01, where
    // the five lists could shed 268 tokens in one run and report nothing.
    const previous = listOf(5_000);
    const next = listOf(5_000);
    next.tokens.splice(0, 40);

    const report = compareTokenLists('ethereum', previous, next);

    expect(report.verdict).toBe('attention');
    expect(report.reasons).toHaveLength(1);
    expect(report.reasons[0]).toContain('40 tokens smaller');
    expect(report.reasons[0]).not.toContain('removed');
  });

  it('tolerates a net drop at the noise floor and flags one past it', () => {
    const atFloor = listOf(1_000);
    atFloor.tokens.splice(0, NET_SHRINK_FLOOR);
    expect(compareTokenLists('base', listOf(1_000), atFloor).verdict).toBe('changed');

    const pastFloor = listOf(1_000);
    pastFloor.tokens.splice(0, NET_SHRINK_FLOOR + 1);
    expect(compareTokenLists('base', listOf(1_000), pastFloor).verdict).toBe('attention');
  });

  it('does not flag a list that grew', () => {
    expect(compareTokenLists('bsc', listOf(1_000), listOf(1_200)).verdict).toBe('changed');
  });

  it('flags a wholesale renaming that costs no coverage at all', () => {
    // Round 9, F-02: every name and symbol could be replaced and the title would read
    // "+0 / -0 tokens". Names are what the app displays and what M2-1's symbol-spoof
    // check treats as the whitelist, so a mass swap is a spoofing surface.
    const previous = listOf(1_000);
    const next = listOf(1_000);
    next.tokens = next.tokens.map((token) => ({ ...token, symbol: 'USDC', name: 'USD Coin' }));

    const report = compareTokenLists('ethereum', previous, next);

    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.verdict).toBe('attention');
    expect(report.reasons[0]).toContain('1000 of 1000 tokens renamed');
  });

  it('flags a single decimals change', () => {
    const previous = listOf(100);
    const next = listOf(100);
    next.tokens[7] = { ...next.tokens[7], decimals: 6 };

    const report = compareTokenLists('ethereum', previous, next);

    expect(report.verdict).toBe('attention');
    expect(report.reasons).toEqual(['1 token changed decimals']);
    expect(report.decimalsChanged).toEqual([
      expect.objectContaining({ symbol: 'T7', from: 18, to: 6 }),
    ]);
  });

  it('counts a rename without raising it to attention', () => {
    const previous = listOf(100);
    const next = listOf(100);
    next.tokens[3] = { ...next.tokens[3], symbol: 'RENAMED' };
    next.tokens[4] = { ...next.tokens[4], name: 'Renamed Token' };

    const report = compareTokenLists('ethereum', previous, next);

    expect(report.relabelled).toHaveLength(2);
    expect(report.added).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(report.verdict).toBe('changed');
  });

  it('treats an address as the same token whatever its casing', () => {
    // Address identity is case-insensitive. Keying on the checksum would turn a
    // change of checksumming into "every token removed and re-added" — the loudest
    // possible alarm for the most cosmetic possible change.
    const previous = listOf(10);
    const next = listOf(10);
    next.tokens = next.tokens.map((token) => ({
      ...token,
      address: token.address.toUpperCase().replace('0X', '0x'),
    }));

    expect(compareTokenLists('ethereum', previous, next).verdict).toBe('unchanged');
  });

  it('flags a chain id that moved', () => {
    const report = compareTokenLists('ethereum', listOf(10), listOf(10, { chainId: 8453 }));

    expect(report.verdict).toBe('attention');
    expect(report.reasons).toContain('chain id changed from 1 to 8453');
  });

  it('carries the source version through for context', () => {
    const report = compareTokenLists(
      'base',
      listOf(10, { sourceVersion: '471.0.0' }),
      listOf(10, { sourceVersion: '472.0.0' }),
    );

    expect(report.previousVersion).toBe('471.0.0');
    expect(report.nextVersion).toBe('472.0.0');
  });
});

describe('overallVerdict', () => {
  it('takes the worst verdict in the run', () => {
    const unchanged = compareTokenLists('a', listOf(10), listOf(10));
    const changed = compareTokenLists('b', listOf(10), listOf(11));
    const attention = compareTokenLists('c', listOf(10), listOf(10, { chainId: 2 }));

    expect(overallVerdict([unchanged, unchanged])).toBe('unchanged');
    expect(overallVerdict([unchanged, changed])).toBe('changed');
    expect(overallVerdict([unchanged, changed, attention])).toBe('attention');
  });
});

describe('renderDriftTitle', () => {
  it('puts the reason in the title, where a notification will show it', () => {
    const previous = listOf(5_000);
    const next = listOf(5_000);
    next.tokens.splice(0, 2_000);

    const title = renderDriftTitle([compareTokenLists('ethereum', previous, next)]);

    expect(title).toContain('REVIEW');
    expect(title).toContain('ethereum');
    expect(title).toContain('2000 of 5000 tokens removed');
  });

  it('names the worst finding in the run, not the first chain compared', () => {
    // Chains are compared in file order, so `base` is seen before `ethereum`. The
    // title must still lead with the coverage collapse.
    const trivial = compareTokenLists('base', listOf(100), decimalsChangedList());
    const severe = compareTokenLists('ethereum', listOf(5_000), truncatedList());

    const title = renderDriftTitle([trivial, severe]);

    expect(title).toContain('ethereum');
    expect(title).toContain('2000 of 5000 tokens removed');
    expect(title).not.toContain('base,');
  });

  it('counts the findings it did not name', () => {
    const title = renderDriftTitle([
      compareTokenLists('base', listOf(100), decimalsChangedList()),
      compareTokenLists('ethereum', listOf(5_000), truncatedList()),
    ]);

    // base contributes 1 finding, ethereum 2 (gross removal and net shrink); one of
    // the three is named in the title.
    expect(title).toContain('(+2 more findings)');
  });

  it('uses the singular for exactly one unnamed finding', () => {
    // 40 of 5,000 trips the net test only — the gross test needs 2 % — so ethereum
    // contributes exactly one finding, and base's decimals change the other.
    const shrunk = listOf(5_000);
    shrunk.tokens.splice(0, 40);
    const title = renderDriftTitle([
      compareTokenLists('base', listOf(100), decimalsChangedList()),
      compareTokenLists('ethereum', listOf(5_000), shrunk),
    ]);

    expect(title).toContain('(+1 more finding)');
  });

  it('pluralises the count of unnamed findings', () => {
    const both = compareTokenLists('ethereum', listOf(5_000), truncatedList(true));
    const title = renderDriftTitle([both, { ...both, slug: 'base' }]);

    // Two chains × three findings each (gross removal, net shrink, decimals) = six,
    // one of which is named.
    expect(title).toContain('(+5 more findings)');
  });

  it('says plainly when only the timestamps moved', () => {
    const title = renderDriftTitle([compareTokenLists('ethereum', listOf(10), listOf(10))]);

    expect(title).toBe('chore(tokens): refresh token lists — no token changes, timestamps only');
  });

  it('totals the churn across chains', () => {
    const ethereum = compareTokenLists('ethereum', listOf(10), listOf(12));
    const base = compareTokenLists('base', listOf(10), listOf(8));

    expect(renderDriftTitle([ethereum, base])).toBe(
      'chore(tokens): refresh token lists — +2 / -2 tokens',
    );
  });
});

describe('renderDriftReport', () => {
  it('leads with what needs looking at', () => {
    const previous = listOf(100);
    const next = listOf(100);
    next.tokens[7] = { ...next.tokens[7], decimals: 6 };

    const body = renderDriftReport([compareTokenLists('ethereum', previous, next)]);

    expect(body.startsWith('## Needs a look before merging')).toBe(true);
    expect(body).toContain('1 token changed decimals');
    // The address is spelled out, because checking it against the contract is the
    // action the flag is asking for.
    expect(body).toContain('T7: 18 → 6');
    expect(body).toContain(next.tokens[7].address);
  });

  it('explains why an all-timestamps diff is still worth merging', () => {
    const body = renderDriftReport([compareTokenLists('ethereum', listOf(10), listOf(10))]);

    expect(body).toContain('No token changed on any chain');
    expect(body).toContain('when the list was last confirmed against');
    expect(body).not.toContain('Needs a look');
  });

  it('always tabulates every chain, including the unchanged ones', () => {
    const ethereum = compareTokenLists('ethereum', listOf(10), listOf(12));
    const base = compareTokenLists('base', listOf(10), listOf(10));

    const body = renderDriftReport([ethereum, base]);

    expect(body).toContain('| ethereum | 12 (+2) | 2 | 0 | 0 | 0 |');
    expect(body).toContain('| base | 10 (+0) | 0 | 0 | 0 | 0 |');
  });

  it('samples a long list instead of printing all of it', () => {
    const previous = listOf(400);
    const next = listOf(400);
    next.tokens.splice(0, 200);

    const body = renderDriftReport([compareTokenLists('ethereum', previous, next)]);

    expect(body).toContain('Removed (200):');
    expect(body).toContain('…and 185 more, in the diff');
    // 15 sampled + 1 summary line, so the body cannot grow with the churn.
    expect(body.split('\n').filter((line) => line.startsWith('- `0x')).length).toBe(15);
  });

  it('strips invisible characters out of a token name, and says it did', () => {
    // Not hypothetical: BSC's committed list contains a token named
    // "U+200B U+200B Stable". A raw name renders as an ordinary one, so a reviewer
    // comparing a removal against an addition could not see they differ.
    const previous = listOf(10);
    const next = listOf(10);
    next.tokens[0] = { ...next.tokens[0], address: '0xdeadbeef', name: '\u200b\u200bStable' };

    const body = renderDriftReport([compareTokenLists('bsc', previous, next)]);

    expect(body).toContain('Stable ⚠ (invisible characters removed)');
    expect(body).not.toContain('\u200b');
  });

  it('leaves an ordinary name exactly as it is', () => {
    const previous = listOf(10);
    const next = listOf(10);
    next.tokens[0] = { ...next.tokens[0], address: '0xdeadbeef', name: 'Wrapped Ether' };

    const body = renderDriftReport([compareTokenLists('ethereum', previous, next)]);

    expect(body).toContain('Wrapped Ether');
    expect(body).not.toContain('invisible characters');
  });

  it('strips a right-to-left override, the address-spoofing character', () => {
    const previous = listOf(10);
    const next = listOf(10);
    next.tokens[0] = { ...next.tokens[0], address: '0xdeadbeef', symbol: 'US\u202eDC' };

    const body = renderDriftReport([compareTokenLists('ethereum', previous, next)]);

    expect(body).toContain('USDC ⚠ (invisible characters removed)');
    expect(body).not.toContain('\u202e');
  });

  it('escapes a name that would render as a link', () => {
    const previous = listOf(10);
    const next = listOf(10);
    next.tokens[0] = {
      ...next.tokens[0],
      address: '0xdeadbeef',
      name: '[Ether](https://phish.example)',
    };

    const body = renderDriftReport([compareTokenLists('ethereum', previous, next)]);

    expect(body).toContain('\\[Ether\\](https://phish.example)');
    // The literal `[Ether](` sequence must not survive, or GitHub renders a link.
    expect(body).not.toContain('[Ether](');
  });

  it('escapes a backtick that would close the address code span', () => {
    const previous = listOf(10);
    const next = listOf(10);
    next.tokens[0] = { ...next.tokens[0], address: '0xdeadbeef', name: 'Ether`s' };

    const body = renderDriftReport([compareTokenLists('ethereum', previous, next)]);

    expect(body).toContain('Ether\\`s');
  });

  it('shows a rename as a pair, old label beside new', () => {
    // A rename is only judgeable as a pair; a bare count is a number nobody can act on.
    const previous = listOf(10);
    const next = listOf(10);
    next.tokens[0] = { ...next.tokens[0], symbol: 'USDC', name: 'USD Coin' };

    const body = renderDriftReport([compareTokenLists('ethereum', previous, next)]);

    expect(body).toContain('Renamed, same address (1):');
    expect(body).toContain('T0 → USDC — Token 0 → USD Coin');
  });

  it('gives an unchanged chain no section of its own', () => {
    const body = renderDriftReport([
      compareTokenLists('ethereum', listOf(10), listOf(12)),
      compareTokenLists('base', listOf(10), listOf(10)),
    ]);

    expect(body).toContain('### ethereum');
    expect(body).not.toContain('### base');
  });
});
