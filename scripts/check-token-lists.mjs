#!/usr/bin/env node
/**
 * Compares the regenerated token lists in the working tree against the committed
 * ones, and writes the pull request text for the monthly refresh.
 *
 *   pnpm tokens:generate && pnpm tokens:check
 *
 * Run after the generator, before anything is committed. The comparison itself lives
 * in `tokenListDrift.mjs` and is unit tested; this file is plumbing — read HEAD, read
 * the working tree, print, write two files.
 *
 * **It exits 0 even when it flags something.** A large change in an upstream list is
 * a finding, not a broken build, and a red run for "CoinGecko delisted a lot this
 * month" would teach whoever sees it to ignore red runs. The flag is carried in the
 * pull request title instead, which is what arrives in a notification.
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compareTokenLists,
  overallVerdict,
  renderDriftReport,
  renderDriftTitle,
} from './tokenListDrift.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIST_DIR = join(ROOT, 'src/config/tokenlists');
const OUT_DIR = process.env.RUNNER_TEMP ?? tmpdir();

// Derived from the files on disk rather than a second copy of the chain list, so
// adding a chain to the generator does not silently leave it unchecked here.
const slugs = (await readdir(LIST_DIR))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''))
  .sort();

if (slugs.length === 0) {
  throw new Error(`No token lists found in ${LIST_DIR}`);
}

const reports = [];

for (const slug of slugs) {
  const relative = `src/config/tokenlists/${slug}.json`;
  const next = JSON.parse(await readFile(join(LIST_DIR, `${slug}.json`), 'utf8'));
  reports.push(compareTokenLists(slug, readCommitted(relative, next.chainId), next));
}

const verdict = overallVerdict(reports);
const title = renderDriftTitle(reports);
const body = renderDriftReport(reports);

const titlePath = join(OUT_DIR, 'token-list-title.txt');
const bodyPath = join(OUT_DIR, 'token-list-body.md');
// A ready-made `git commit -F` message, so the workflow never has to combine a
// subject and a body in shell — `git commit` refuses `-F` together with `-m`, and
// the report is worth having in `git log` regardless of what happens to the pull
// request body afterwards.
const commitPath = join(OUT_DIR, 'token-list-commit.txt');
await writeFile(titlePath, title, 'utf8');
await writeFile(bodyPath, body, 'utf8');
await writeFile(commitPath, `${title}\n\n${body}\n`, 'utf8');

console.log(body);
console.log(`\nverdict: ${verdict}`);
console.log(`title:   ${title}`);

// The workflow reads these rather than parsing stdout.
if (process.env.GITHUB_OUTPUT) {
  await writeFile(
    process.env.GITHUB_OUTPUT,
    [
      `verdict=${verdict}`,
      `title_path=${titlePath}`,
      `body_path=${bodyPath}`,
      `commit_path=${commitPath}`,
      '',
    ].join('\n'),
    { encoding: 'utf8', flag: 'a' },
  );
}

/**
 * The committed version of a list, as of HEAD.
 *
 * A chain whose list is not in HEAD yet is new, not broken: everything in it counts
 * as added, and there is nothing to have lost.
 */
function readCommitted(relative, chainId) {
  try {
    const raw = execFileSync('git', ['show', `HEAD:${relative}`], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return JSON.parse(raw);
  } catch {
    console.log(`${relative} is not in HEAD — treating it as a new chain.`);
    return { chainId, sourceVersion: 'new', generatedAt: 'new', tokens: [] };
  }
}
