import { expect, test } from '@playwright/test';

/**
 * A saved wallet the landing page does not otherwise mention.
 *
 * Distinct from `E2E_ADDRESS` on purpose: that one is the page's own public example
 * link, and reusing it would make a leak indistinguishable from a link that has
 * always been there.
 */
const PRIVATE_ADDRESS = '0x3333333333333333333333333333333333333333';

import {
  allNetworksPlan,
  bundleMemberAggregate,
  crossCheckedPlan,
  E2E_ADDRESS,
  emptyWalletPlan,
  emptyWithOneNetworkFailingPlan,
  insightfulPlan,
  mockPortfolioApi,
  oneNetworkFailingPlan,
  RATE_LIMITED,
  unconfirmedPricesPlan,
} from './fixtures';

/**
 * Wiring smoke tests: route → browser client → components.
 *
 * The unit suite already covers the maths, the state machine and every provider
 * adapter. What it cannot cover is whether those parts are actually connected —
 * that a validated payload reaches the table, that a 429 becomes the retryable
 * error state rather than a blank screen. That is all this file asserts, with the
 * API mocked in the browser (`fixtures.ts`) so no provider is involved.
 *
 * Assertions go through roles and visible text, not CSS classes: those are the
 * things a user relies on, and a class name changing is not a regression.
 */

test('takes an address from the landing page through to a rendered portfolio', async ({ page }) => {
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto('/');
  await page.getByLabel('Public wallet address').fill(E2E_ADDRESS);
  await page.getByRole('button', { name: 'View portfolio' }).click();

  // No `chainId`, so the route resolves to every supported network.
  await expect(page).toHaveURL(`/portfolio/${E2E_ADDRESS}`);

  const summary = page.getByRole('region', { name: 'Portfolio summary' });
  await expect(summary).toContainText('$5,400.00');
  await expect(summary).toContainText('5 networks');
  // The largest position is the 3,000 ETH holding, not the 5,000 of fake USDC.
  await expect(summary).toContainText('$3,000.00');
  await expect(summary).toContainText('1 flagged as likely spam');

  const assets = page.getByRole('region', { name: 'Assets' });
  await expect(assets.getByRole('cell', { name: 'BNB Smart Chain' })).toBeVisible();

  // The spoofed row is out of the main table and behind its own disclosure, with
  // the withheld amount stated rather than merely omitted.
  const flagged = assets.getByRole('button', { name: /1 flagged as likely spam/ });
  await expect(flagged).toContainText('$5,000.00 excluded');
  await expect(assets.getByText('Copied symbol')).toBeHidden();
  await flagged.click();
  await expect(assets.getByText('Copied symbol')).toBeVisible();

  const limitations = page.getByRole('region', { name: 'Data limitations' });
  await limitations.getByRole('group').click();
  // Five identical coverage warnings are combined into one line naming the total.
  await expect(limitations).toContainText('12,346 tokens across');
  await expect(limitations).toContainText('Ethereum Mainnet: 1 asset looks like spam');
});

test('folds the caveats away without hiding that there are any', async ({ page }) => {
  // A keyless load carries several of these on every request. Left expanded they
  // become wallpaper — the failure mode where an honest warning stops being read
  // because it is always there. Collapsed, the count still has to survive: the
  // difference between "there are caveats" and "there are five" is the whole claim.
  await mockPortfolioApi(page, crossCheckedPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}?chainId=1`);

  const limitations = page.getByRole('region', { name: 'Data limitations' });
  const disclosure = limitations.getByRole('group');

  await expect(limitations).toContainText('What this view does not include');
  await expect(limitations).toContainText('note');
  // Collapsed by default, so the detail is present in the DOM but not readable.
  await expect(disclosure).not.toHaveAttribute('open', /.*/);
  await expect(limitations.getByRole('listitem').first()).toBeHidden();

  await disclosure.click();
  await expect(limitations.getByRole('listitem').first()).toBeVisible();

  // The landmark survives the change: `<details>` alone carries role `group`, not
  // `region`, so a bare disclosure would have removed a navigation target.
  await expect(limitations).toBeVisible();
});

test('names a network it could not read instead of dropping it silently', async ({ page }) => {
  await mockPortfolioApi(page, oneNetworkFailingPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);

  const networks = page.getByRole('region', { name: 'Value by network' });
  const unreadable = networks.getByRole('listitem').filter({ hasText: 'BNB Smart Chain' });
  await expect(unreadable).toContainText('Unavailable');
  await expect(unreadable).toContainText('Not counted in the total');

  const summary = page.getByRole('region', { name: 'Portfolio summary' });
  // 5,400 less the 600 on the network that failed, and the gap is labelled.
  await expect(summary).toContainText('$4,800.00');
  await expect(summary).toContainText('1 unavailable');
});

test('rejects a malformed address inline, without navigating or calling the API', async ({
  page,
}) => {
  const api = await mockPortfolioApi(page, allNetworksPlan());

  await page.goto('/');
  await page.getByLabel('Public wallet address').fill('0x123');
  await page.getByRole('button', { name: 'View portfolio' }).click();

  // Scoped to `main`: Next.js keeps its own always-present `role="alert"` route
  // announcer at the end of the body.
  await expect(page.getByRole('main').getByRole('alert')).toContainText('40 characters after "0x"');
  await expect(page).toHaveURL('/');
  // A typo must not cost a provider call.
  expect(api.requestCount()).toBe(0);
});

test('surfaces a rate limit as a retryable error state, and recovers on retry', async ({
  page,
}) => {
  // A single-network view on purpose: one view, one request shape, whether or not
  // the aggregate view has moved to per-chain fan-out (M2-3).
  const api = await mockPortfolioApi(page, allNetworksPlan(), { failWith: RATE_LIMITED });

  await page.goto(`/portfolio/${E2E_ADDRESS}?chainId=1`);

  const error = page.getByRole('main').getByRole('alert');
  await expect(error).toContainText('This portfolio could not be loaded');
  await expect(error).toContainText('Too many requests. Please wait a moment and try again.');

  api.stopFailing();
  await error.getByRole('button', { name: 'Try again' }).click();

  await expect(page.getByRole('region', { name: 'Portfolio summary' })).toContainText('$4,000.00');
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
});

test('shows the empty state for a wallet that holds nothing it can see', async ({ page }) => {
  await mockPortfolioApi(page, emptyWalletPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);

  await expect(page.getByRole('heading', { name: 'No assets found' })).toBeVisible();
  await expect(
    page.getByText('none of the tokens Nuxfolio checks on any supported network'),
  ).toBeVisible();
  // Empty means empty: no table of nothing, and no total presented as $0.00.
  await expect(page.getByRole('region', { name: 'Assets' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Portfolio summary' })).toHaveCount(0);
});

test('does not claim a network is empty when it could not be read', async ({ page }) => {
  await mockPortfolioApi(page, emptyWithOneNetworkFailingPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);

  await expect(page.getByRole('heading', { name: 'No assets found' })).toBeVisible();
  // The claim is scoped to the networks that answered, and the one that did not
  // is named rather than silently counted as empty.
  await expect(page.getByText('networks that could be read')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Value by network' })).toBeVisible();
  await expect(page.getByText('Unavailable')).toBeVisible();
  await expect(
    page.getByText('none of the tokens Nuxfolio checks on any supported network'),
  ).toHaveCount(0);
});

test('marks a disputed price, keeps it in the total, and credits the second source', async ({
  page,
}) => {
  await mockPortfolioApi(page, crossCheckedPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);

  const summary = page.getByRole('region', { name: 'Portfolio summary' });
  // The disagreement does not move the money: doubt about a number is not doubt
  // about whether the holding is the user's.
  await expect(summary).toContainText('$5,400.00');
  // Silence on the other rows must not read as endorsement, so the scope of the
  // check is stated rather than implied.
  // Six, not seven: the spoofed row is priced but outside the total, so it is not
  // part of what a check could usefully cover.
  await expect(summary).toContainText('2 of 6 prices were checked against a second source');
  await expect(summary).toContainText('1 disagreed and is marked below');
  // One agreed and one disputed, so nothing went unanswered — and the sentence
  // must not claim blanket agreement either.
  await expect(summary).not.toContainText('and agreed');
  await expect(summary).not.toContainText('could not be confirmed');

  const assets = page.getByRole('region', { name: 'Assets' });
  const disputed = assets.getByLabel(
    'A second source says $1.40, a 40.00% difference. Both are shown; neither is preferred.',
  );
  await expect(disputed).toBeVisible();
  // Only the disagreement is marked; the row that agreed carries no marker, which
  // is why the summary has to carry the count.
  await expect(assets.getByLabel(/A second source says/)).toHaveCount(1);

  const limitations = page.getByRole('region', { name: 'Data limitations' });
  await limitations.getByRole('group').click();
  await expect(limitations).toContainText('1 price could not be confirmed by a second source');
  await expect(limitations).toContainText('The widest gap is USDC');

  // A licence term, not decoration: CoinGecko's Demo terms require the credit and
  // the link whenever their data is used.
  const credit = page.getByRole('link', { name: 'Powered by CoinGecko API' });
  await expect(credit).toBeVisible();
  await expect(credit).toHaveAttribute('href', 'https://www.coingecko.com/en/api');
});

test('does not call a price agreed when the second source had no opinion on it', async ({
  page,
}) => {
  // Zero disputes is not the same as agreement. This is the exact sentence a
  // reviewer caught: with two `unverified` checks and nothing disputed, an
  // "and agreed" would assert a confirmation that never happened.
  await mockPortfolioApi(page, unconfirmedPricesPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);

  const summary = page.getByRole('region', { name: 'Portfolio summary' });
  await expect(summary).toContainText('2 of 2 prices were checked against a second source');
  await expect(summary).toContainText('2 could not be confirmed');
  await expect(summary).not.toContainText('and agreed');

  // Nothing is marked in the table either: only a disagreement is marked, so the
  // summary sentence is the only place this could have been reported.
  await expect(
    page.getByRole('region', { name: 'Assets' }).getByLabel(/A second source says/),
  ).toHaveCount(0);
});

test('credits no second source when no price was cross-checked', async ({ page }) => {
  // The other half of the obligation: an attribution shown where the data was not
  // used would be a false claim about where the numbers came from.
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);
  await expect(page.getByRole('region', { name: 'Assets' })).toBeVisible();

  await expect(page.getByRole('link', { name: 'Powered by CoinGecko API' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Portfolio summary' })).not.toContainText(
    'second source',
  );
  // The primary source is still named, so the absence above is about the verifier
  // rather than attribution being broken altogether.
  await expect(page.getByRole('link', { name: 'DefiLlama' })).toBeVisible();
});

test('shows a price change, and refuses to round a real one down to zero', async ({ page }) => {
  await mockPortfolioApi(page, insightfulPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}?chainId=1`);

  const assets = page.getByRole('region', { name: 'Assets' });
  await expect(assets).toContainText('+5.00%');
  await expect(assets).toContainText('-10.00%');

  // WBTC moved 0.004%: a real change that two decimals cannot show. Rendering it
  // as "0.00%" would state the opposite of what happened.
  await expect(assets).toContainText('<0.01%');

  // USDC genuinely did not move, and zero is a real answer — distinct from the
  // dash that means "no comparable observation".
  await expect(assets).toContainText('0.00%');
  // WBTC's 7d had no quote, so that cell is a dash carrying its reason.
  await expect(
    assets.getByLabel('The price source had no past price for this asset.').first(),
  ).toBeVisible();
});

test('converts to euro by dividing, and names the rate it used', async ({ page }) => {
  await mockPortfolioApi(page, insightfulPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}?chainId=1`);

  const summary = page.getByRole('region', { name: 'Portfolio summary' });
  await expect(summary).toContainText('$10,000.00');

  await page.getByRole('group', { name: 'Display currency' }).getByText('EUR').click();

  // 10,000 USD at 1 EUR = 1.25 USD is 8,000 EUR. Multiplying would give 12,500 —
  // the direction error this asserts against.
  await expect(summary).toContainText('€8,000.00');
  await expect(summary).not.toContainText('€12,500.00');

  // A euro figure is a conversion of an estimate at a dated rate, and says so.
  await expect(summary).toContainText('European Central Bank reference rate of 2026-07-31');
  await expect(summary).toContainText('1 EUR = 1.25 USD');
  await expect(summary).toContainText('business days');

  // The whole page converts, not just the headline: an unconverted network total
  // beside a converted summary would be worse than either alone.
  await expect(page.getByRole('region', { name: 'Assets' })).toContainText('€');
});

test('offers no currency toggle when no rate could be fetched', async ({ page }) => {
  // A control that cannot do what it says is worse than an absent one.
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}?chainId=1`);
  await expect(page.getByRole('region', { name: 'Assets' })).toBeVisible();

  await expect(page.getByRole('group', { name: 'Display currency' })).toHaveCount(0);
});

test('saves a wallet, lists it on the landing page, and opens it again', async ({ page }) => {
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);
  await expect(page.getByRole('region', { name: 'Assets' })).toBeVisible();

  // Nothing is saved automatically: a product that remembered every address pasted
  // into it would be building a list nobody asked for.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toHaveAttribute('aria-pressed', 'true');

  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Saved wallets' });
  await expect(panel).toContainText('0xd8dA…6045');
  // The list is a browser-local thing, and the page says so rather than letting
  // someone assume it follows them to another device.
  await expect(panel).toContainText('Stored in this browser only');

  await panel.getByRole('link').first().click();
  await expect(page).toHaveURL(`/portfolio/${E2E_ADDRESS}`);
});

test('sends no request carrying a saved address when the landing page loads', async ({ page }) => {
  // The privacy claim, made executable: opening this page must not tell the server
  // which wallets are on the list. Counting only `/api/portfolio` calls would miss
  // the interesting case entirely, so this looks at every request of any kind.
  //
  // The saved address is deliberately **not** `E2E_ADDRESS`, which the landing page
  // already links to as its public example. An earlier version of this test used the
  // same address for both and so could not tell a leak from that hard-coded link —
  // it reported the example link's own prefetch as a leak, which cost a CI run and a
  // wrong diagnosis.
  const api = await mockPortfolioApi(page, allNetworksPlan());

  // Seeded directly rather than saved through the UI: this test is about what the
  // landing page does with a populated list, and the save flow is covered elsewhere.
  await page.goto('/');
  await page.evaluate((address) => {
    window.localStorage.setItem(
      'nuxfolio.savedWallets',
      JSON.stringify({
        version: 1,
        wallets: [
          { address, label: 'Private', ensName: null, savedAt: '2026-08-01T10:00:00.000Z' },
        ],
      }),
    );
  }, PRIVATE_ADDRESS);

  api.clearRequestLog();
  await page.reload();

  const panel = page.getByRole('region', { name: 'Saved wallets' });
  await expect(panel).toContainText('Private');

  // Hover the row twice, with a move away between: hover is the trigger a
  // `prefetch={false}` link would still honour, so the check exercises it rather
  // than hoping the timing misses it.
  const row = panel.getByRole('link').first();
  await row.hover();
  await page.mouse.move(0, 0);
  await row.hover();

  // Then give any request time to actually reach the network before asserting none did.
  await page.waitForTimeout(2000);

  const leaked = api
    .requestedUrls()
    .filter((url) => url.toLowerCase().includes(PRIVATE_ADDRESS.toLowerCase()));
  expect(leaked, `requests mentioning the saved address: ${leaked.join(', ')}`).toEqual([]);
});

test('keeps the list across a reload and shares it with another tab', async ({ page, context }) => {
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  await page.goto('/');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Saved wallets' })).toContainText('0xd8dA…6045');

  // A second tab shares the same storage, which is the whole point of using it.
  const second = await context.newPage();
  await mockPortfolioApi(second, allNetworksPlan());
  await second.goto('/');
  await expect(second.getByRole('region', { name: 'Saved wallets' })).toContainText('0xd8dA…6045');
  await second.close();
});

test('removes a saved wallet in one click', async ({ page }) => {
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  await page.goto('/');
  const panel = page.getByRole('region', { name: 'Saved wallets' });
  await panel.getByRole('button', { name: 'Manage' }).click();
  await panel.getByRole('button', { name: 'Remove', exact: true }).click();

  // Gone entirely: with nothing saved, the panel has nothing to say.
  await expect(page.getByRole('region', { name: 'Saved wallets' })).toHaveCount(0);
});

test('says it cannot read a corrupt list rather than claiming none is saved', async ({ page }) => {
  // "You have no saved wallets" is a claim. Making it because the store is
  // unreadable would be false — and would let the next save overwrite whatever is
  // really there.
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto('/');
  await page.evaluate(() => {
    window.localStorage.setItem('nuxfolio.savedWallets', 'this is not json');
  });
  await page.reload();

  const panel = page.getByRole('region', { name: 'Saved wallets' });
  await expect(panel).toContainText('could not be read');
  await expect(panel).toContainText('have not been deleted');
  await expect(panel).not.toContainText('no saved wallets');
});

/** Two more valid addresses, distinct from the page's own example link. */
const WALLET_B = '0x3333333333333333333333333333333333333333';
const WALLET_C = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599';

test('totals several wallets, and names the one it could not read', async ({ page }) => {
  const api = await mockPortfolioApi(page, allNetworksPlan());
  api.addBundleMember(
    WALLET_B,
    bundleMemberAggregate({
      address: WALLET_B,
      totalValueUsd: '1000.00000000',
      symbol: 'USDC',
      quantity: '1000',
      priceUsd: '1',
    }),
  );
  api.addBundleMember(
    WALLET_C,
    bundleMemberAggregate({
      address: WALLET_C,
      totalValueUsd: '250.00000000',
      symbol: 'USDC',
      quantity: '250',
      priceUsd: '1',
    }),
  );
  api.addBundleMember(E2E_ADDRESS, 'fail');

  await page.goto(`/bundle/${WALLET_B},${WALLET_C},${E2E_ADDRESS}`);

  const summary = page.getByRole('region', { name: 'Bundle summary' });
  // 1,000 + 250. The failed wallet contributes nothing and is not counted as zero.
  await expect(summary).toContainText('$1,250.00');
  // "readable", never "settled": the failed wallet settled and is not covered.
  await expect(summary).toContainText('2 of 3 wallets readable');
  await expect(summary).toContainText('1 unavailable and not counted');

  const byWallet = page.getByRole('region', { name: 'Value by wallet' });
  const failedRow = byWallet.getByRole('listitem').filter({ hasText: '0xd8dA' });
  await expect(failedRow).toContainText('Unavailable');
  await expect(failedRow).toContainText('Not counted in the total');

  // One row per wallet position: both wallets hold USDC, and that is two rows, not a
  // merged one that could not carry two different price states.
  const assets = page.getByRole('region', { name: 'Assets' });
  await expect(assets.getByRole('columnheader', { name: 'Wallet' })).toBeVisible();
  await expect(assets.getByRole('cell', { name: /0x3333/ })).toBeVisible();
  await expect(assets.getByRole('cell', { name: /0x2260/ })).toBeVisible();
});

test('counts a repeated address once rather than doubling the total', async ({ page }) => {
  // The money rule: totalling one wallet twice would overstate by 100 % and look
  // entirely plausible.
  const api = await mockPortfolioApi(page, allNetworksPlan());
  api.addBundleMember(
    WALLET_B,
    bundleMemberAggregate({
      address: WALLET_B,
      totalValueUsd: '1000.00000000',
      symbol: 'USDC',
      quantity: '1000',
      priceUsd: '1',
    }),
  );
  api.addBundleMember(
    WALLET_C,
    bundleMemberAggregate({
      address: WALLET_C,
      totalValueUsd: '250.00000000',
      symbol: 'USDC',
      quantity: '250',
      priceUsd: '1',
    }),
  );

  await page.goto(`/bundle/${WALLET_B},${WALLET_B},${WALLET_C}`);

  const summary = page.getByRole('region', { name: 'Bundle summary' });
  await expect(summary).toContainText('$1,250.00');
  await expect(summary).not.toContainText('$2,250.00');
  await expect(summary).toContainText('2 of 2 wallets readable');

  // And it says so, rather than quietly de-duplicating a link someone shared.
  await expect(page.getByRole('region', { name: 'About this link' })).toContainText(
    'counted once, not twice',
  );
});

test('names an input it rejected instead of redirecting away from the notice', async ({ page }) => {
  // One valid address plus one rejected: redirecting to the single-wallet view would
  // erase the notice, and a page cannot report what it dropped once it is not the page.
  const api = await mockPortfolioApi(page, allNetworksPlan());
  api.addBundleMember(
    WALLET_B,
    bundleMemberAggregate({
      address: WALLET_B,
      totalValueUsd: '1000.00000000',
      symbol: 'USDC',
      quantity: '1000',
      priceUsd: '1',
    }),
  );

  await page.goto(`/bundle/${WALLET_B},vitalik.eth`);

  await expect(page).toHaveURL(new RegExp('/bundle/'));
  const notices = page.getByRole('region', { name: 'About this link' });
  // An ENS name gets its own message: it is a reasonable thing to have tried.
  await expect(notices).toContainText('is an ENS name');
  await expect(notices).toContainText('addresses only');
});

test('reports every wallet failing as a load failure, not as empty holdings', async ({ page }) => {
  // "No assets found" here would be a claim about what the wallets hold, when the
  // truth is that nothing was read.
  const api = await mockPortfolioApi(page, allNetworksPlan());
  api.addBundleMember(WALLET_B, 'fail');
  api.addBundleMember(WALLET_C, 'fail');

  await page.goto(`/bundle/${WALLET_B},${WALLET_C}`);

  // `role="alert"`, not `region`: a load failure should be announced, and that is the
  // convention the single-wallet error state already follows.
  const failure = page.getByRole('alert', { name: 'Bundle could not be loaded' });
  await expect(failure).toContainText('None of these wallets could be read');
  await expect(failure).toContainText('not a statement about what the wallets hold');
  await expect(page.getByRole('heading', { name: 'No assets found' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Bundle summary' })).toHaveCount(0);
});

test('offers "View together" from saved wallets without leaking the list', async ({ page }) => {
  const api = await mockPortfolioApi(page, allNetworksPlan());

  await page.goto('/');
  await page.evaluate(
    ([first, second]) => {
      window.localStorage.setItem(
        'nuxfolio.savedWallets',
        JSON.stringify({
          version: 1,
          wallets: [
            { address: first, label: 'One', ensName: null, savedAt: '2026-08-01T10:00:00.000Z' },
            { address: second, label: 'Two', ensName: null, savedAt: '2026-08-01T09:00:00.000Z' },
          ],
        }),
      );
    },
    [WALLET_B, WALLET_C],
  );

  api.clearRequestLog();
  await page.reload();

  const panel = page.getByRole('region', { name: 'Saved wallets' });
  const together = panel.getByRole('link', { name: 'View together' });
  await expect(together).toBeVisible();
  await expect(together).toHaveAttribute('href', `/bundle/${WALLET_B},${WALLET_C}`);

  // Hovering is what a prefetching link would act on, and this link points at a URL
  // containing the whole saved list.
  await together.hover();
  await page.waitForTimeout(1500);

  const leaked = api
    .requestedUrls()
    .filter(
      (url) =>
        url.toLowerCase().includes(WALLET_B.toLowerCase()) ||
        url.toLowerCase().includes(WALLET_C.toLowerCase()),
    );
  expect(leaked, `requests mentioning a saved address: ${leaked.join(', ')}`).toEqual([]);
});

test('puts the sort in the URL, and opens a shared link already sorted', async ({ page }) => {
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}?chainId=1`);
  const assets = page.getByRole('region', { name: 'Assets' });
  await expect(assets).toBeVisible();

  // The default leaves no trace, so an ordinary shared link stays plain and a future
  // change of default is not frozen into every link ever copied.
  expect(page.url()).not.toContain('sort=');

  await assets.getByRole('button', { name: /^Asset/ }).click();
  await expect(page).toHaveURL(/sort=name&dir=asc/);
  // Still the same page: sort is view state, so this is a replaceState rather than a
  // navigation, and the query it already had survives.
  await expect(page).toHaveURL(/chainId=1/);

  // Clicking the same column flips it rather than starting over.
  await assets.getByRole('button', { name: /^Asset/ }).click();
  await expect(page).toHaveURL(/dir=desc/);

  // Returning to the default clears the parameters again.
  await assets.getByRole('button', { name: /^Value/ }).click();
  expect(page.url()).not.toContain('sort=');

  // And a shared link opens the way it was shared.
  await page.goto(`/portfolio/${E2E_ADDRESS}?chainId=1&sort=name&dir=asc`);
  await expect(
    page.getByRole('region', { name: 'Assets' }).getByRole('columnheader', { name: /^Asset/ }),
  ).toHaveAttribute('aria-sort', 'ascending');
});

test('ignores a nonsense sort in the URL rather than trusting it', async ({ page }) => {
  // A query string is hostile input, like a stored theme or a saved wallet.
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}?chainId=1&sort=<script>&dir=sideways`);

  const assets = page.getByRole('region', { name: 'Assets' });
  await expect(assets).toBeVisible();
  // Fell back to the default: value, descending.
  await expect(assets.getByRole('columnheader', { name: /^Value/ })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
});

test('sorts from the keyboard alone', async ({ page }) => {
  // The table's controls are real buttons with aria-sort, so this already worked — and
  // an untested "it already works" is just a claim. Tab to the header and press it.
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}?chainId=1`);
  const header = page
    .getByRole('region', { name: 'Assets' })
    .getByRole('button', { name: /^Asset/ });
  await expect(header).toBeVisible();

  await header.focus();
  await expect(header).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/sort=name/);

  await page.keyboard.press('Space');
  await expect(page).toHaveURL(/dir=desc/);
});

test('links each network card to that network on its own', async ({ page }) => {
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);
  const networks = page.getByRole('region', { name: 'Value by network' });
  await expect(networks).toBeVisible();

  await networks.getByRole('link', { name: /Base/ }).click();
  await expect(page).toHaveURL(new RegExp(`chainId=8453`));
  await expect(page.getByRole('region', { name: 'Portfolio summary' })).toContainText('$500.00');
});

test('does not offer a link to a network it could not read', async ({ page }) => {
  // Offering to open a network that failed is offering a page that will fail.
  await mockPortfolioApi(page, oneNetworkFailingPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);
  const networks = page.getByRole('region', { name: 'Value by network' });
  const unreadable = networks.getByRole('listitem').filter({ hasText: 'BNB Smart Chain' });

  await expect(unreadable).toContainText('Unavailable');
  await expect(unreadable.getByRole('link')).toHaveCount(0);
});

test('copies the full address, not the shortened one on screen', async ({ page, context }) => {
  // The header shows 0xd8dA…6045 because a full address does not fit. Copying what is
  // displayed would hand over a string that is not an address, and the mistake would
  // only surface when someone pasted it somewhere that mattered.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockPortfolioApi(page, allNetworksPlan());

  await page.goto(`/portfolio/${E2E_ADDRESS}`);
  await page.getByRole('button', { name: /^Copy the full address/ }).click();

  await expect(page.getByRole('button', { name: /^Copy the full address/ })).toContainText(
    'Copied',
  );
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(E2E_ADDRESS);
});

test('remembers a theme choice and applies it before the page paints', async ({ page }) => {
  // The value of a no-flash implementation is entirely in the *first* paint, so
  // this asserts the attribute is already present on load rather than appearing
  // once React has hydrated.
  await mockPortfolioApi(page, allNetworksPlan());
  await page.goto(`/portfolio/${E2E_ADDRESS}`);

  const root = page.locator('html');
  // No choice yet: the attribute is absent so the stylesheet follows the system.
  await expect(root).not.toHaveAttribute('data-theme', /.*/);

  await page.getByRole('button', { name: 'Dark' }).click();
  await expect(root).toHaveAttribute('data-theme', 'dark');

  await page.reload();
  // Set by the blocking script, not by an effect: it is here on the very first
  // paint of the reloaded document.
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Match system' }).click();
  // Back to following the system means the attribute is removed, not set to a
  // resolved value that would freeze the visitor's OS preference.
  await expect(root).not.toHaveAttribute('data-theme', /.*/);
});

test.describe('narrow viewport', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('fits a 390px screen without the page scrolling sideways', async ({ page }) => {
    await mockPortfolioApi(page, allNetworksPlan());

    await page.goto(`/portfolio/${E2E_ADDRESS}`);
    await expect(page.getByRole('region', { name: 'Assets' })).toBeVisible();

    const widths = await page.evaluate(() => ({
      documentScroll: document.documentElement.scrollWidth,
      documentClient: document.documentElement.clientWidth,
      bodyScroll: document.body.scrollWidth,
      bodyClient: document.body.clientWidth,
    }));

    // The asset table is wider than the screen by design and scrolls inside its
    // own container. The page must not: a document that pans sideways is how a
    // mobile layout regression shows up.
    expect(widths.documentScroll).toBeLessThanOrEqual(widths.documentClient);
    expect(widths.bodyScroll).toBeLessThanOrEqual(widths.bodyClient);
  });
});
