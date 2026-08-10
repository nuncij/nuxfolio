import 'server-only';

import { parseWalletAddress, type WalletAddress } from '@/domain/address';

/**
 * Which wallets have a history, and where that history is kept.
 *
 * **Both come from the environment, not from this file.** The plan said "a config file,
 * the same shape as `aaveMarkets.ts`" — and that was written before noticing the repo is
 * public. A committed list of the owner's addresses would publish exactly the thing the
 * rest of this product is careful about: `docs/DECISIONS.md` keeps a browser from telling
 * an image host which wallet is being viewed, and a constant in `main` would tell
 * everyone which wallets are the owner's.
 *
 * **A fixed list rather than a "track this wallet" button.** That choice is what keeps
 * this milestone small: a stranger cannot add a row, so there is no cardinality cap to
 * enforce, no abuse control, no untrack path, no deletion authorisation and no question
 * of who may erase whose history. All of those return the day the site is public, and
 * they return together. See `docs/M4_PLAN.md` §3 and review round 14.
 */

/** Just the reads these two need, so a test can pass a plain object. */
type EnvSource = Readonly<Record<string, string | undefined>>;

/** Where the database file lives. Never inside the app directory — see below. */
export const DEFAULT_DATA_DIR = '.data';

/**
 * The data directory, from `NUXFOLIO_DATA_DIR`.
 *
 * It must sit **outside** the deployed application directory. `scripts/deploy.sh` copies
 * with `rsync --delete`, so a database under `app/` would be removed by the next deploy;
 * the systemd unit also grants write access to `app/.next/cache` alone, so it could not
 * be written to in the first place. Review round 14 caught this before any code existed.
 */
export function dataDir(env: EnvSource = process.env): string {
  const configured = env.NUXFOLIO_DATA_DIR?.trim();
  return configured !== undefined && configured.length > 0 ? configured : DEFAULT_DATA_DIR;
}

/**
 * Addresses to snapshot, from `NUXFOLIO_TRACKED_WALLETS` — comma separated.
 *
 * Anything that is not a well-formed address is dropped rather than throwing: a typo in
 * an environment variable should cost that one entry, not the whole deployment. An empty
 * list is a valid state and means history is switched off.
 */
export function trackedWallets(env: EnvSource = process.env): readonly WalletAddress[] {
  const raw = env.NUXFOLIO_TRACKED_WALLETS ?? '';

  const seen = new Set<string>();
  const wallets: WalletAddress[] = [];

  for (const entry of raw.split(',')) {
    const parsed = parseWalletAddress(entry.trim());
    if (!parsed.ok) {
      continue;
    }
    // Lowercase for identity, because the same wallet typed two ways is one wallet and
    // two rows would be two histories.
    const key = parsed.address.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    wallets.push(parsed.address);
  }

  return wallets;
}
