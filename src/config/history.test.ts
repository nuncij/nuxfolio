import { describe, expect, it } from 'vitest';

import { dataDir, DEFAULT_DATA_DIR, trackedWallets } from './history';

const TEST = '0xF635aaEE995E61102Dd237Fd3AE66EEAf7EA7054';
const OTHER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

describe('trackedWallets', () => {
  it('is empty when nothing is configured, which switches history off', () => {
    // Not an error state. A deployment that wants no history sets nothing.
    expect(trackedWallets({})).toEqual([]);
  });

  it('reads a comma-separated list, trimming as it goes', () => {
    expect(trackedWallets({ NUXFOLIO_TRACKED_WALLETS: ` ${TEST} , ${OTHER} ` })).toEqual([
      TEST,
      OTHER,
    ]);
  });

  it('drops one bad entry rather than the whole deployment', () => {
    // A typo in an environment variable should cost that entry. Throwing here would
    // take the site down for a stray character.
    expect(trackedWallets({ NUXFOLIO_TRACKED_WALLETS: `${TEST},not-an-address,${OTHER}` })).toEqual(
      [TEST, OTHER],
    );
  });

  it('treats one wallet typed two ways as one wallet', () => {
    // Two spellings would otherwise be two histories for the same money.
    const both = `${TEST},${TEST.toLowerCase()}`;

    expect(trackedWallets({ NUXFOLIO_TRACKED_WALLETS: both })).toHaveLength(1);
  });
});

describe('dataDir', () => {
  it('falls back to a directory outside the app, never inside it', () => {
    // `deploy.sh` runs `rsync --delete` into the app directory and systemd grants write
    // access to `.next/cache` alone. A database under `app/` would be deleted by the
    // next deploy, and unwritable before that (review round 14, F-1).
    expect(dataDir({})).toBe(DEFAULT_DATA_DIR);
    expect(DEFAULT_DATA_DIR).not.toContain('.next');
  });

  it('takes the configured directory when there is one', () => {
    expect(dataDir({ NUXFOLIO_DATA_DIR: '/srv/nuxfolio/data' })).toBe('/srv/nuxfolio/data');
  });

  it('ignores a blank setting rather than writing to nowhere', () => {
    expect(dataDir({ NUXFOLIO_DATA_DIR: '   ' })).toBe(DEFAULT_DATA_DIR);
  });
});
