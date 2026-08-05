#!/usr/bin/env node
/**
 * Reports how far the running app is behind the token lists on `main`.
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
  now: Date.now(),
});

console.log(`status:            ${lag.status}`);
console.log(`deployed lists:    ${deployedGeneratedAt ?? '(no deploy recorded)'}`);
console.log(`lists on HEAD:     ${mainGeneratedAt}`);
console.log(`\n${lag.summary}`);
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
      '',
    ].join('\n'),
    'utf8',
  );
}

if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFile } = await import('node:fs/promises');
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    ['', '### Live site vs `main`', '', lag.summary, ''].join('\n'),
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
