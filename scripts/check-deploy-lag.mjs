#!/usr/bin/env node
/**
 * Reports how far the running app is behind `main` — in token lists, and in code.
 *
 *   pnpm deploy:lag
 *
 * Reads the `deployed` tag, which `scripts/deploy.sh` force-moves and pushes after a
 * successful deploy. A tag rather than a committed file on purpose: it records
 * metadata about a commit without creating one, so a deploy leaves no diff behind.
 *
 * Plumbing only — the classification is in `deployLag.mjs`, which is pure and tested.
 * Exits 0 whatever it finds; the caller decides what a `behind` status is worth.
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assessDeployLag, deployInstruction } from './deployLag.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The tag lives on the remote — it is moved by the target after it deploys, not by
// anything local. A checkout that has never fetched it, or fetched it days ago, answers
// this question about its own stale copy: run locally with a week-old tag it reported
// twelve commits behind when the true figure was two. Non-fatal, because offline is a
// legitimate state and a stale answer clearly labelled beats no answer.
refreshDeployedTag();

// Ethereum's list stands for all five: they are regenerated in one run, so their
// timestamps move together, and reading one keeps the comparison legible.
const WITNESS = 'src/config/tokenlists/ethereum.json';

const deployedGeneratedAt = generatedAtIn(`deployed:${WITNESS}`);
const mainGeneratedAt =
  generatedAtIn(`HEAD:${WITNESS}`) ??
  JSON.parse(await readFile(join(ROOT, WITNESS), 'utf8')).generatedAt;

const lag = assessDeployLag({
  deployedGeneratedAt,
  mainGeneratedAt,
  commitsBehind: countCommitsBehind(),
  now: Date.now(),
});

console.log(`token lists:       ${lag.status}`);
console.log(`deployed lists:    ${deployedGeneratedAt ?? '(no deploy recorded)'}`);
console.log(`lists on HEAD:     ${mainGeneratedAt}`);
console.log(`deployed commit:   ${shaOf('deployed') ?? '(no deploy recorded)'}`);
console.log(`HEAD commit:       ${shaOf('HEAD') ?? '(unknown)'}`);
console.log(`\n${lag.summary}`);
console.log(lag.codeSummary);
if (lag.status === 'behind') {
  console.log(`\nTo resolve:  ${deployInstruction()}`);
}

if (process.env.GITHUB_OUTPUT) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `status=${lag.status}`,
      `age_days=${lag.deployedAgeDays ?? ''}`,
      `has_something_to_ship=${lag.hasSomethingToShip}`,
      `commits_behind=${lag.commitsBehind ?? ''}`,
      '',
    ].join('\n'),
    'utf8',
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    ['', '### Live site vs `main`', '', lag.summary, '', lag.codeSummary, ''].join('\n'),
    'utf8',
  );
}

// Also written to a file, so the workflow can put it in an issue body without
// re-deriving the wording.
const { writeFile } = await import('node:fs/promises');
const outDir = process.env.RUNNER_TEMP ?? (await import('node:os')).tmpdir();
await writeFile(
  join(outDir, 'deploy-lag.md'),
  [
    lag.summary,
    '',
    'Run this from a machine on the tailnet:',
    '',
    '```',
    deployInstruction(),
    '```',
    '',
    'GitHub cannot do it: the target is reachable only over Tailscale, and shipping a',
    'build needs `next build`, which must not run on that box — 3.7 GB, no swap, and',
    'other services on it (ADR-018).',
    '',
    'This issue closes itself on the next successful deploy.',
    '',
  ].join('\n'),
  'utf8',
);

/** Pulls the current `deployed` tag from the remote, overwriting any local copy. */
function refreshDeployedTag() {
  try {
    execFileSync(
      'git',
      ['fetch', '--quiet', '--force', 'origin', 'refs/tags/deployed:refs/tags/deployed'],
      {
        cwd: ROOT,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 15_000,
      },
    );
  } catch {
    // Offline, no remote, or no such tag yet. The comparison below still runs against
    // whatever is local and says so if it cannot resolve at all.
  }
}

/**
 * How many commits `HEAD` has that the deployed revision does not.
 *
 * Null when it cannot be counted — no `deployed` tag yet, or a shallow clone without
 * the history between the two. Null is reported as "could not tell" rather than as
 * zero, because only one of those is reassuring.
 */
function countCommitsBehind() {
  try {
    const out = execFileSync('git', ['rev-list', '--count', 'deployed..HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Number.parseInt(out.trim(), 10);
  } catch {
    return null;
  }
}

/** Short sha of a revision, or null when it does not resolve. */
function shaOf(revision) {
  try {
    return execFileSync('git', ['rev-parse', '--short', revision], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The `generatedAt` of a token list at a git revision, or null when the revision does
 * not exist — an unpushed tag, a shallow clone that lacks it, a fresh repository.
 */
function generatedAtIn(revision) {
  try {
    const raw = execFileSync('git', ['show', revision], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(raw).generatedAt ?? null;
  } catch {
    return null;
  }
}
