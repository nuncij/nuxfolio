/**
 * Compares a committed token list against a freshly generated one.
 *
 * The scheduled refresh (`.github/workflows/token-lists.yml`) exists so the bundled
 * lists stop ageing silently. But automating the refresh introduces a failure mode
 * the manual one did not have: if the upstream list is truncated on the morning the
 * cron fires, the regenerated file carries a **fresh `generatedAt` with fewer
 * tokens**. The staleness warning would go quiet at exactly the moment coverage got
 * worse — a shrunken list reported as a current one, which is the class of
 * dishonesty this codebase is built to prevent (ADR-006, ADR-012).
 *
 * So a refresh is not trusted on the strength of "the fetch returned 200". It is
 * compared against what it would replace, and anything that looks less like
 * ordinary churn than like a bad upstream day is put in front of a human.
 *
 * **How much can still slip through, measured rather than asserted.** Each run compares
 * against the previous commit only, so the bound is per-run: with the net test at a
 * floor of 5 per chain, at most **25 tokens across all five lists** — 0.20 % of the
 * 12,346 bundled — can be lost without a human being shown. The first version of this
 * file used only the gross test, and independent review calculated that bound at **268
 * tokens, 2.2 %** (round 9, F-01). Both numbers are computed from the real list sizes,
 * not estimated.
 *
 * Sustained month-on-month erosion under 5 per chain would still accumulate unseen.
 * Catching that needs a baseline older than `HEAD`, which is a different mechanism; the
 * measured direction of travel does not suggest it is the risk worth building for.
 *
 * Plain JavaScript rather than TypeScript because it runs from `node` in CI with no
 * build step, like `generate-token-list.mjs` beside it. The comparison is a pure
 * function so it is testable without a network, a runner or a git checkout; the
 * calling script holds nothing but plumbing.
 */

/**
 * Removals below this count are ordinary delistings whatever the list's size.
 * Optimism's list is 247 tokens, so a share test alone would flag five removals
 * there while ignoring a hundred on Ethereum.
 */
export const REMOVAL_FLOOR = 25;

/**
 * ...and above that floor, removals still have to be a real share of the list.
 * 25 tokens out of Ethereum's 5,000 is noise; 25 out of Optimism's 247 is not.
 *
 * The margin is measured, not guessed. Regenerating on 2026-08-04 against lists
 * generated on 2026-07-30 — five days of real upstream churn — removed at most **2
 * tokens from any one chain** (24 added, 5 removed in total, no decimals changes).
 * A month at that rate is roughly a dozen per chain, so a floor of 25 sits above
 * ordinary churn while a truncated response, which loses a large fraction, clears
 * both tests easily. Five days is one sample; revisit after a few real runs.
 */
export const REMOVAL_SHARE = 0.02;

/**
 * A net decrease bigger than this is a finding on its own, whatever the removal count.
 *
 * This exists because the two thresholds above are a *gross* test, and independent
 * review (round 9, F-01) showed how much that lets through: at 25-or-2 %, the five
 * lists can shed **268 tokens in a single run** — 2.2 % of all coverage — and still
 * report no finding. The stated property was "coverage cannot shrink silently", and
 * 268 tokens is not silence-worthy.
 *
 * A net test is the sharper instrument, because additions normally mask removals:
 * measured over five days in August 2026 every chain *grew* (+2, +2, +11, +4, +0), so a
 * chain that ends up smaller than it started is already the anomaly. Five is the noise
 * floor, which bounds a silent loss at 5 per chain — 25 across all five, not 268.
 *
 * The gross test stays, because it catches what the net test cannot: a truncated
 * response whose losses are hidden by an equal number of new listings.
 */
export const NET_SHRINK_FLOOR = 5;

/** How many tokens to name individually before summarising the rest. */
const SAMPLE_SIZE = 15;

/**
 * @typedef {{ address: string, name: string, symbol: string, decimals: number }} TokenEntry
 * @typedef {{ chainId: number, sourceVersion: string, generatedAt: string, tokens: TokenEntry[] }} TokenListFile
 */

/**
 * Classifies the difference between two versions of one chain's list.
 *
 * @param {string} slug
 * @param {TokenListFile} previous
 * @param {TokenListFile} next
 */
export function compareTokenLists(slug, previous, next) {
  const before = indexByAddress(previous.tokens);
  const after = indexByAddress(next.tokens);

  const added = [];
  const removed = [];
  const decimalsChanged = [];
  const relabelled = [];

  for (const [address, token] of after) {
    const old = before.get(address);
    if (old === undefined) {
      added.push(token);
      continue;
    }
    if (old.decimals !== token.decimals) {
      decimalsChanged.push({ ...token, from: old.decimals, to: token.decimals });
    }
    if (old.symbol !== token.symbol || old.name !== token.name) {
      relabelled.push({ ...token, fromSymbol: old.symbol, fromName: old.name });
    }
  }

  for (const [address, token] of before) {
    if (!after.has(address)) {
      removed.push(token);
    }
  }

  // Findings carry a rank, because only one of them fits in the pull request title
  // and it has to be the worst one. A rehearsal against real data had a run with a
  // mass removal *and* a decimals change announce itself as "1 token changed
  // decimals" — the trivial finding in the headline, the 80 % coverage loss buried
  // in the body. Lower rank is worse.
  const findings = [];

  // Rank 0 — a wrong chain id would serve one chain's list as another's, which
  // produces wrong balances rather than missing ones. The generator filters by chain
  // id so this should be unreachable; it is checked because of that consequence.
  if (previous.chainId !== next.chainId) {
    findings.push({
      rank: 0,
      text: `chain id changed from ${previous.chainId} to ${next.chainId}`,
    });
  }

  // Rank 1 — the failure this whole guard exists for: a truncated upstream response
  // committed with a fresh `generatedAt`, which silences the staleness warning at
  // the moment coverage shrinks. It also makes the rest of the file untrustworthy,
  // which is why it outranks a single token's metadata.
  //
  // Two tests, because neither alone is enough. Gross removals catch a truncation
  // whose losses are masked by an equal number of new listings; the net drop catches
  // the erosion the gross test is too coarse to see (round 9, F-01).
  if (isMaterial(removed.length, previous.tokens.length)) {
    findings.push({
      rank: 1,
      text:
        `${removed.length} of ${previous.tokens.length} tokens removed ` +
        `(${percent(removed.length / previous.tokens.length)}), which looks truncated rather than delisted`,
    });
  }

  const netChange = next.tokens.length - previous.tokens.length;
  if (-netChange > NET_SHRINK_FLOOR) {
    findings.push({
      rank: 1,
      text: `the list is ${-netChange} tokens smaller than the one it replaces, and these lists normally grow`,
    });
  }

  // Rank 2 — decimals is the one field where a wrong value is silently wrong by a
  // power of ten rather than visibly absent: it converts base units into the amount
  // on screen. A contract's decimals do not change, so a change here means the old
  // metadata was wrong or the new metadata is. Worth one human minute either way,
  // because one of those answers means a balance was misreported — but it is as
  // likely to be upstream fixing bad data as breaking good data, so it ranks below
  // losing a fifth of the list.
  if (decimalsChanged.length > 0) {
    findings.push({
      rank: 2,
      text: `${decimalsChanged.length} token${decimalsChanged.length === 1 ? '' : 's'} changed decimals`,
    });
  }

  // Rank 2 — a wholesale renaming. Counted since the first version but never a
  // finding, which round 9 (F-02) pointed out means every name and symbol on a chain
  // could be replaced and the title would read "+0 / -0 tokens". Names are what the
  // app shows and what M2-1's symbol-spoof check uses as its whitelist, so a mass
  // swap is a spoofing surface even though no coverage is lost.
  if (isMaterial(relabelled.length, previous.tokens.length)) {
    findings.push({
      rank: 2,
      text:
        `${relabelled.length} of ${previous.tokens.length} tokens renamed ` +
        `(${percent(relabelled.length / previous.tokens.length)}) without changing address`,
    });
  }

  const reasons = findings.map((finding) => finding.text);
  const changes = added.length + removed.length + decimalsChanged.length + relabelled.length;

  return {
    slug,
    previousCount: previous.tokens.length,
    nextCount: next.tokens.length,
    previousVersion: previous.sourceVersion,
    nextVersion: next.sourceVersion,
    added,
    removed,
    decimalsChanged,
    relabelled,
    reasons,
    // The rank of this chain's worst finding, so a run can order chains by it.
    // Infinity for a chain with nothing to report, which sorts last for free.
    severity: findings.length > 0 ? findings[0].rank : Number.POSITIVE_INFINITY,
    verdict: reasons.length > 0 ? 'attention' : changes > 0 ? 'changed' : 'unchanged',
  };
}

/**
 * Whether a count is a real share of the list rather than routine churn.
 *
 * Both tests must hold: a small list needs the absolute floor so a share test does not
 * fire on five tokens, and a large list needs the share so the floor is not noise.
 */
function isMaterial(count, total) {
  return count >= REMOVAL_FLOOR && count >= total * REMOVAL_SHARE;
}

/** Flagged chains, worst first. Ties keep the order they were compared in. */
function flaggedBySeverity(reports) {
  return reports
    .filter((report) => report.verdict === 'attention')
    .sort((a, b) => a.severity - b.severity);
}

/**
 * The verdict for a whole run: the worst of its parts.
 *
 * `unchanged` for every chain still means the run should be committed — see
 * `renderDriftReport`, and the note there about what `generatedAt` claims.
 *
 * @param {ReturnType<typeof compareTokenLists>[]} reports
 */
export function overallVerdict(reports) {
  if (reports.some((report) => report.verdict === 'attention')) {
    return 'attention';
  }
  return reports.some((report) => report.verdict === 'changed') ? 'changed' : 'unchanged';
}

/**
 * A one-line summary for a pull request title.
 *
 * The reason for flagging goes in the title rather than only the body: the title is
 * what arrives in a notification, and a guard nobody reads is not a guard.
 *
 * @param {ReturnType<typeof compareTokenLists>[]} reports
 */
export function renderDriftTitle(reports) {
  const verdict = overallVerdict(reports);

  if (verdict === 'attention') {
    // The worst finding in the run, not the first chain alphabetically: chains are
    // compared in file order, so "the first flagged chain" would report base's
    // relabelled token and say nothing about ethereum losing a fifth of its list.
    const flagged = flaggedBySeverity(reports);
    const worst = flagged[0];
    const total = sum(flagged.map((report) => report.reasons.length));
    const rest = total > 1 ? ` (+${total - 1} more finding${total === 2 ? '' : 's'})` : '';
    return `chore(tokens): refresh token lists — REVIEW: ${worst.slug}, ${worst.reasons[0]}${rest}`;
  }

  if (verdict === 'unchanged') {
    return 'chore(tokens): refresh token lists — no token changes, timestamps only';
  }

  const added = sum(reports.map((report) => report.added.length));
  const removed = sum(reports.map((report) => report.removed.length));
  return `chore(tokens): refresh token lists — +${added} / -${removed} tokens`;
}

/**
 * The pull request body: what changed, per chain, and what to look at first.
 *
 * @param {ReturnType<typeof compareTokenLists>[]} reports
 */
export function renderDriftReport(reports) {
  const lines = [];
  const verdict = overallVerdict(reports);

  if (verdict === 'attention') {
    lines.push('## Needs a look before merging', '');
    // Same order as the title, so the thing named in the notification is the first
    // thing on the page.
    for (const report of flaggedBySeverity(reports)) {
      for (const reason of report.reasons) {
        lines.push(`- **${report.slug}** — ${reason}`);
      }
    }
    lines.push(
      '',
      'Everything below is the same report the automated check reads. The thresholds',
      'are in `scripts/tokenListDrift.mjs`; if this turns out to be ordinary churn,',
      'that is the file to adjust, and the adjustment belongs in the same pull request',
      'as the evidence for it.',
      '',
    );
  }

  if (verdict === 'unchanged') {
    lines.push(
      '## No token changed on any chain',
      '',
      'Only `generatedAt` and `sourceVersion` move in this diff, and that is the point',
      'of recording it: `generatedAt` means **when the list was last confirmed against',
      'its source**, not when its contents last changed. Leaving it stale would make the',
      'app\'s 60-day warning say "recently listed tokens may be missing" on a list that',
      'was just verified complete.',
      '',
    );
  }

  lines.push('## Per chain', '');
  lines.push('| Chain | Tokens | Added | Removed | Relabelled | Decimals | Source version |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const report of reports) {
    const delta = report.nextCount - report.previousCount;
    lines.push(
      `| ${report.slug} | ${report.nextCount.toLocaleString('en-US')}` +
        ` (${delta >= 0 ? '+' : ''}${delta}) | ${report.added.length} | ${report.removed.length}` +
        ` | ${report.relabelled.length} | ${report.decimalsChanged.length}` +
        // `sourceVersion` is upstream-controlled too: the generator interpolates
        // `version.major/minor/patch` without validating them, so a pipe or a newline
        // in there would break this table apart (round 9, F-04).
        ` | ${visible(report.previousVersion)} → ${visible(report.nextVersion)} |`,
    );
  }
  lines.push('');

  for (const report of reports) {
    if (report.verdict === 'unchanged') {
      continue;
    }

    lines.push(`### ${report.slug}`, '');

    if (report.decimalsChanged.length > 0) {
      lines.push('Decimals changed — check these against the contract before merging:', '');
      for (const token of report.decimalsChanged) {
        lines.push(`- \`${token.address}\` ${visible(token.symbol)}: ${token.from} → ${token.to}`);
      }
      lines.push('');
    }

    if (report.relabelled.length > 0) {
      // The old label beside the new one: a rename is only judgeable as a pair, and
      // without the samples a "renamed" count is a number nobody can act on.
      lines.push(`Renamed, same address (${report.relabelled.length}):`, '');
      for (const token of report.relabelled.slice(0, SAMPLE_SIZE)) {
        lines.push(
          `- \`${token.address}\` ${visible(token.fromSymbol)} → ${visible(token.symbol)}` +
            ` — ${visible(token.fromName)} → ${visible(token.name)}`,
        );
      }
      if (report.relabelled.length > SAMPLE_SIZE) {
        lines.push(`- …and ${report.relabelled.length - SAMPLE_SIZE} more, in the diff`);
      }
      lines.push('');
    }

    lines.push(...sampleList('Removed', report.removed));
    lines.push(...sampleList('Added', report.added));
  }

  return lines.join('\n');
}

/**
 * Names a handful of tokens rather than all of them.
 *
 * A month of churn can be hundreds of entries; a body listing all of them is one
 * nobody scrolls through, and GitHub truncates it anyway. The files in the diff are
 * the complete record.
 *
 * @param {string} heading
 * @param {TokenEntry[]} tokens
 */
function sampleList(heading, tokens) {
  if (tokens.length === 0) {
    return [];
  }

  const shown = tokens.slice(0, SAMPLE_SIZE);
  const lines = [`${heading} (${tokens.length}):`, ''];
  for (const token of shown) {
    lines.push(`- \`${token.address}\` ${visible(token.symbol)} — ${visible(token.name)}`);
  }
  if (tokens.length > shown.length) {
    lines.push(`- …and ${tokens.length - shown.length} more, in the diff`);
  }
  lines.push('');
  return lines;
}

/**
 * Bidi overrides, zero-width marks and C0/C1 controls — written as escapes because
 * these characters are invisible by definition, and a source line containing the
 * literals would be unreviewable (the same reason M3-1 writes them this way, and the
 * shell refuses to pass them).
 */
const INVISIBLE = /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff\u0000-\u001f\u007f-\u009f]/gu;

/**
 * Markdown characters that would let a token name escape the line it is printed on:
 * a backtick closes the address's code span, `[` opens a link, `<` opens a tag, `|`
 * adds a table cell. Emphasis markers are left alone — they can only make a name
 * italic, which misleads nobody.
 */
const MARKDOWN_ACTIVE = /[\\`[\]<>|]/g;

/**
 * A token's name or symbol, made safe to print in a review.
 *
 * Upstream metadata is not typed prose, it is a string a stranger chose, and it is
 * rendered into a pull request body. Two separate problems, in order:
 *
 * **Invisible characters are stripped, and the strip is announced.** Scanning the five
 * committed lists on 2026-08-04 found this is not hypothetical: one BSC token is named
 * `U+200B U+200B Stable` — two zero-width spaces before the word. A report printing
 * that raw renders as an ordinary name, so a reviewer comparing a removal against an
 * addition could not see the two differ. Removing them *silently* would hide the thing
 * worth knowing, which is that the name contains them at all.
 *
 * **Markdown-active characters are escaped, not removed**, because they may be part of
 * a real name. Without this, a token called `[Ether](https://phish.example)` would
 * render in the pull request as a working link.
 *
 * Neither is a shell-injection guard — nothing here reaches a shell. Names travel
 * node → file → `git commit -F` / `gh --body-file`, never through an argument.
 */
function visible(text) {
  const stripped = text.replace(INVISIBLE, '');
  const escaped = stripped.replace(MARKDOWN_ACTIVE, (char) => `\\${char}`);
  return stripped === text ? escaped : `${escaped} ⚠ (invisible characters removed)`;
}

/**
 * Keyed on the lowercased address, because address identity is case-insensitive.
 *
 * Both files are checksummed by the generator today, so the raw strings would match
 * — but keying on the checksum would silently turn a change of checksumming into
 * "every token removed and re-added", which is precisely the alarm this module
 * exists to make meaningful.
 *
 * @param {TokenEntry[]} tokens
 */
function indexByAddress(tokens) {
  return new Map(tokens.map((token) => [token.address.toLowerCase(), token]));
}

/** @param {number[]} values */
function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** @param {number} fraction */
function percent(fraction) {
  return `${(fraction * 100).toFixed(1)} %`;
}
