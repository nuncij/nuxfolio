#!/usr/bin/env node
/**
 * Regenerates the bundled token lists, one per supported chain.
 *
 *   pnpm tokens:generate            # every chain
 *   pnpm tokens:generate ethereum   # one chain
 *
 * The keyless balance provider needs a set of candidate ERC-20 contracts to
 * probe, and fetching that set on the request path would add latency and a
 * failure mode to every portfolio load for data that changes slowly. So the
 * lists are generated here and committed. See docs/DECISIONS.md, ADR-006.
 *
 * The source is CoinGecko's per-platform list rather than a DEX routing list.
 * That distinction matters: a routing list is curated for what is worth
 * swapping, and omits liquid-staking and receipt tokens like wstETH, rETH and
 * syrupUSDC — which are exactly the large positions a portfolio tracker must
 * not miss. See ADR-012.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAddress } from 'viem';

/** CoinGecko platform slugs, keyed by our chain slug. */
const CHAINS = [
  { slug: 'ethereum', chainId: 1, platform: 'ethereum' },
  { slug: 'base', chainId: 8453, platform: 'base' },
  { slug: 'arbitrum', chainId: 42161, platform: 'arbitrum-one' },
  { slug: 'optimism', chainId: 10, platform: 'optimistic-ethereum' },
  { slug: 'bsc', chainId: 56, platform: 'binance-smart-chain' },
];

const OUTPUT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/config/tokenlists');

const requested = process.argv.slice(2);
const selected =
  requested.length === 0 ? CHAINS : CHAINS.filter((chain) => requested.includes(chain.slug));

if (selected.length === 0) {
  throw new Error(`Unknown chain(s): ${requested.join(', ')}`);
}

for (const chain of selected) {
  const url =
    process.env.TOKEN_LIST_URL ?? `https://tokens.coingecko.com/${chain.platform}/all.json`;

  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }

  const list = await response.json();

  if (!Array.isArray(list?.tokens)) {
    throw new Error(`${url} did not return a token list`);
  }

  const seen = new Set();
  const tokens = [];
  let skipped = 0;

  for (const token of list.tokens) {
    if (token?.chainId !== chain.chainId) {
      continue;
    }

    let address;
    try {
      address = getAddress(token.address);
    } catch {
      skipped += 1;
      continue;
    }

    if (seen.has(address)) {
      continue;
    }
    if (!Number.isInteger(token.decimals) || token.decimals < 0 || token.decimals > 36) {
      skipped += 1;
      continue;
    }

    const name = typeof token.name === 'string' ? token.name.trim() : '';
    const symbol = typeof token.symbol === 'string' ? token.symbol.trim() : '';
    if (name.length === 0 || symbol.length === 0) {
      skipped += 1;
      continue;
    }

    seen.add(address);
    // `logoURI` is deliberately dropped: Nuxfolio renders no remote images
    // (ADR-009), so carrying ~80 characters of CDN URL per token would add
    // roughly half a megabyte across the chains for data nothing reads.
    tokens.push({ address, name, symbol, decimals: token.decimals });
  }

  tokens.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.address.localeCompare(b.address));

  const version = list.version
    ? `${list.version.major}.${list.version.minor}.${list.version.patch}`
    : 'unversioned';

  // One token per line: still valid JSON, but a regeneration produces a diff a
  // human can actually read, which a pretty-printed 5000-entry array does not.
  const body = tokens.map((token) => `    ${JSON.stringify(token)}`).join(',\n');
  const output = `{
  "$comment": "GENERATED FILE - do not edit by hand. Run \`pnpm tokens:generate\` to refresh. See docs/DECISIONS.md, ADR-006 and ADR-012.",
  "source": ${JSON.stringify(url)},
  "sourceName": ${JSON.stringify(list.name ?? 'unknown')},
  "sourceVersion": ${JSON.stringify(version)},
  "generatedAt": ${JSON.stringify(new Date().toISOString())},
  "chainId": ${chain.chainId},
  "tokens": [
${body}
  ]
}
`;

  const target = resolve(OUTPUT_DIR, `${chain.slug}.json`);
  await writeFile(target, output, 'utf8');

  console.log(
    `${chain.slug.padEnd(9)} ${String(tokens.length).padStart(5)} tokens` +
      `${skipped > 0 ? ` (${skipped} skipped)` : ''}` +
      ` -> ${target} [${(output.length / 1024).toFixed(0)} KB]`,
  );
}
