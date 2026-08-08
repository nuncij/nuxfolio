import { describe, expect, it } from 'vitest';

import { DEPLOY_LAG_WARN_DAYS, assessDeployLag } from './deployLag.mjs';

const NOW = Date.parse('2026-09-01T00:00:00.000Z');

/** An ISO timestamp `days` before NOW. */
function daysAgo(days) {
  return new Date(NOW - days * 86_400_000).toISOString();
}

describe('assessDeployLag', () => {
  it('says it does not know before any deploy has recorded itself', () => {
    // "Probably fine" would be the same species of dishonesty as a fresh timestamp
    // on a shrunken list: an absence reported as a reassurance.
    const lag = assessDeployLag({
      deployedGeneratedAt: null,
      mainGeneratedAt: daysAgo(0),
      now: NOW,
    });

    expect(lag.status).toBe('unknown');
    expect(lag.deployedAgeDays).toBeNull();
    expect(lag.hasSomethingToShip).toBe(false);
    expect(lag.summary).toContain('No deploy has recorded itself yet');
  });

  it('says it does not know when a timestamp will not parse', () => {
    expect(
      assessDeployLag({ deployedGeneratedAt: 'not a date', mainGeneratedAt: daysAgo(0), now: NOW })
        .status,
    ).toBe('unknown');
  });

  it('reports the lists as current when they match main — and claims nothing more', () => {
    // This test used to require the words "Nothing to ship", and that assertion was the
    // defect: this function can only see token lists, so it was pinning a claim about
    // the whole deployment that it had no way to check. The summary now says what it
    // measured, and `codeSummary` answers the other half separately.
    const same = daysAgo(3);
    const lag = assessDeployLag({ deployedGeneratedAt: same, mainGeneratedAt: same, now: NOW });

    expect(lag.status).toBe('current');
    expect(lag.hasSomethingToShip).toBe(false);
    expect(lag.deployedAgeDays).toBe(3);
    expect(lag.summary).toContain('same lists as');
    expect(lag.summary).not.toContain('Nothing to ship');
  });

  it('treats a newer deployed build as current rather than as an error', () => {
    // Deploying from a branch, or main moving backwards, should not read as a problem
    // with the live site.
    const lag = assessDeployLag({
      deployedGeneratedAt: daysAgo(0),
      mainGeneratedAt: daysAgo(5),
      now: NOW,
    });

    expect(lag.status).toBe('current');
    expect(lag.hasSomethingToShip).toBe(false);
  });

  it('notes a fresh-but-superseded build without calling it a task', () => {
    // A refresh lands most Mondays, so this is the ordinary weekly state. Raising it
    // to a task every week is exactly how the previous always-ask design failed.
    const lag = assessDeployLag({
      deployedGeneratedAt: daysAgo(6),
      mainGeneratedAt: daysAgo(0),
      now: NOW,
    });

    expect(lag.status).toBe('pending');
    expect(lag.hasSomethingToShip).toBe(true);
    expect(lag.summary).toContain('a note rather than a task');
  });

  it('escalates once the deployed lists pass the threshold', () => {
    const lag = assessDeployLag({
      deployedGeneratedAt: daysAgo(DEPLOY_LAG_WARN_DAYS + 1),
      mainGeneratedAt: daysAgo(0),
      now: NOW,
    });

    expect(lag.status).toBe('behind');
    expect(lag.deployedAgeDays).toBe(DEPLOY_LAG_WARN_DAYS + 1);
    expect(lag.summary).toContain('worth acting on');
  });

  it('does not escalate exactly at the threshold', () => {
    // "Older than 30 days", matching how the app's own age warning reads its bound.
    expect(
      assessDeployLag({
        deployedGeneratedAt: daysAgo(DEPLOY_LAG_WARN_DAYS),
        mainGeneratedAt: daysAgo(0),
        now: NOW,
      }).status,
    ).toBe('pending');
  });

  it('escalates well before the app starts warning users at 60 days', () => {
    // The point of 30: a month of slack between "you should deploy" and the live site
    // telling a visitor its lists are aged.
    expect(DEPLOY_LAG_WARN_DAYS).toBeLessThan(60);
  });

  it('phrases a single day in the singular', () => {
    const lag = assessDeployLag({
      deployedGeneratedAt: daysAgo(1),
      mainGeneratedAt: daysAgo(1),
      now: NOW,
    });

    expect(lag.summary).toContain('generated 1 day ago');
  });

  it('says "today" rather than "0 days ago"', () => {
    const lag = assessDeployLag({
      deployedGeneratedAt: daysAgo(0),
      mainGeneratedAt: daysAgo(0),
      now: NOW,
    });

    expect(lag.summary).toContain('generated today');
  });
});

describe('code lag, reported separately from list age', () => {
  const SAME = '2026-08-04T19:35:02.517Z';

  it('no longer claims there is nothing to ship when only the lists match', () => {
    // The exact false comfort this reported on 2026-08-08: `current`, while the live
    // site was missing a bug fix. A person looking at the page noticed; the check did
    // not, because it said "Nothing to ship" about a question it cannot see.
    const lag = assessDeployLag({
      deployedGeneratedAt: SAME,
      mainGeneratedAt: SAME,
      commitsBehind: 2,
      now: Date.parse('2026-08-08T12:00:00.000Z'),
    });

    expect(lag.status).toBe('current');
    expect(lag.summary).not.toMatch(/nothing to ship/i);
    expect(lag.codeSummary).toMatch(/2 commits behind/);
  });

  it('says so plainly when the deployed commit is the current one', () => {
    const lag = assessDeployLag({
      deployedGeneratedAt: SAME,
      mainGeneratedAt: SAME,
      commitsBehind: 0,
      now: Date.parse('2026-08-08T12:00:00.000Z'),
    });

    expect(lag.codeSummary).toMatch(/same commit/);
  });

  it('distinguishes "could not tell" from "zero"', () => {
    // A shallow clone or an unfetched tag cannot answer. Reporting that as zero would
    // be the same species of false comfort in a different place.
    const lag = assessDeployLag({
      deployedGeneratedAt: SAME,
      mainGeneratedAt: SAME,
      commitsBehind: null,
      now: Date.parse('2026-08-08T12:00:00.000Z'),
    });

    expect(lag.commitsBehind).toBeNull();
    expect(lag.codeSummary).toMatch(/could not be determined/);
    expect(lag.codeSummary).not.toMatch(/same commit/);
  });

  it('keeps the list status independent, so one issue does not fire on the other', () => {
    // `status: 'behind'` opens a GitHub issue about token lists. Code being a few
    // minutes behind is the self-updater working, and must not open that issue.
    const lag = assessDeployLag({
      deployedGeneratedAt: SAME,
      mainGeneratedAt: SAME,
      commitsBehind: 40,
      now: Date.parse('2026-08-08T12:00:00.000Z'),
    });

    expect(lag.status).toBe('current');
  });
});
