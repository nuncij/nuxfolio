/**
 * What an asset is designed to track, keyed by contract address.
 *
 * **Never by symbol.** A symbol is attacker-controlled — an airdropped token can
 * call itself `USDC`, which is the entire premise of the spoof detection in
 * `suspect.ts`. Classifying by symbol would let a fake re-enter as a *risk
 * statement* the very figure it was excluded from, which is worse than not
 * classifying at all.
 *
 * **Keyed by chain and address together.** The same address is unrelated
 * contracts on different EVM chains, so a global address map would confidently
 * mis-classify.
 *
 * **"Designed to track", not "tracks".** An address proves which instrument
 * something is. It does not prove the instrument is currently holding its peg — a
 * depegged stablecoin is still this entry, and the panel must not imply otherwise.
 *
 * **Anything absent is `unclassified`, and reported as such.** The registry is
 * deliberately small and conservative: a thin registry degrades to an honest "we
 * do not know about this share of the portfolio" rather than to a wrong bucket.
 * Adding an entry is a decision with a date attached, not a guess.
 */

/** What the value follows. Not a risk rating and not a recommendation. */
export type TrackedAsset = 'usd' | 'eth' | 'btc' | 'unclassified';

/**
 * How the exposure is held, which is a separate question from what it tracks.
 *
 * A receipt token carries protocol risk that a plain balance does not, and saying
 * "33% is the US dollar" about a lending receipt would hide that.
 */
export type HoldingForm =
  /** The asset itself, or a straightforward wrapper of it. */
  | 'direct'
  /** A staking receipt — value accrues, and the staking protocol is a dependency. */
  | 'staking-receipt'
  /** A lending or vault receipt — the lending protocol is a dependency. */
  | 'lending-receipt';

export type AssetClassification = {
  readonly tracks: TrackedAsset;
  readonly form: HoldingForm;
  /** Why this entry exists, and when it was last looked at. */
  readonly note: string;
};

const UNCLASSIFIED: AssetClassification = {
  tracks: 'unclassified',
  form: 'direct',
  note: 'Not in the classification registry.',
};

/**
 * The registry. Reviewed 2026-08-03.
 *
 * Small on purpose. Every entry was checked against the deployed contract at that
 * date; nothing here is inferred from a symbol or a name.
 */
const REGISTRY: Readonly<Record<string, AssetClassification>> = {
  // ── Native assets ────────────────────────────────────────────────────────────
  '1:native': { tracks: 'eth', form: 'direct', note: 'Ether on Ethereum Mainnet.' },
  '8453:native': { tracks: 'eth', form: 'direct', note: 'Ether on Base.' },
  '42161:native': { tracks: 'eth', form: 'direct', note: 'Ether on Arbitrum One.' },
  '10:native': { tracks: 'eth', form: 'direct', note: 'Ether on OP Mainnet.' },
  '56:native': {
    tracks: 'unclassified',
    form: 'direct',
    note: 'BNB tracks neither the dollar, ether nor bitcoin; it is its own exposure.',
  },

  // ── Ether and staked ether ───────────────────────────────────────────────────
  '1:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': {
    tracks: 'eth',
    form: 'direct',
    note: 'WETH — ether wrapped as an ERC-20.',
  },
  '1:0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0': {
    tracks: 'eth',
    form: 'staking-receipt',
    note: 'wstETH — Lido staked ether. Follows ether plus staking yield; Lido is a dependency.',
  },
  '1:0xae7ab96520de3a18e5e111b5eaab095312d7fe84': {
    tracks: 'eth',
    form: 'staking-receipt',
    note: 'stETH — Lido staked ether.',
  },
  '1:0xae78736cd615f374d3085123a210448e74fc6393': {
    tracks: 'eth',
    form: 'staking-receipt',
    note: 'rETH — Rocket Pool staked ether.',
  },

  // ── Bitcoin ──────────────────────────────────────────────────────────────────
  '1:0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': {
    tracks: 'btc',
    form: 'direct',
    note: 'WBTC — custodied bitcoin. Follows bitcoin; the custodian is a dependency.',
  },
  '1:0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': {
    tracks: 'btc',
    form: 'direct',
    note: 'cbBTC — Coinbase-custodied bitcoin.',
  },

  // ── US dollar ────────────────────────────────────────────────────────────────
  '1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': {
    tracks: 'usd',
    form: 'direct',
    note: 'USDC.',
  },
  '1:0xdac17f958d2ee523a2206206994597c13d831ec7': {
    tracks: 'usd',
    form: 'direct',
    note: 'USDT.',
  },
  '1:0x6b175474e89094c44da98b954eedeac495271d0f': {
    tracks: 'usd',
    form: 'direct',
    note: 'DAI.',
  },
  '1:0xf939e0a03fb07f59a73314e73794be0e57ac1b4e': {
    tracks: 'usd',
    form: 'direct',
    note: 'crvUSD — Curve’s dollar stablecoin.',
  },
  '1:0x80ac24aa929eaf5013f6436cda2a7ba190f5cc0b': {
    tracks: 'usd',
    form: 'lending-receipt',
    note: 'syrupUSDC — a Maple lending receipt for deposited USDC. Follows the dollar plus lending yield; Maple and its borrowers are dependencies.',
  },
  '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': {
    tracks: 'usd',
    form: 'direct',
    note: 'USDC on Base.',
  },
  '42161:0xaf88d065e77c8cc2239327c5edb3a432268e5831': {
    tracks: 'usd',
    form: 'direct',
    note: 'USDC on Arbitrum One.',
  },
  '10:0x0b2c639c533813f4aa9d7837caf62653d097ff85': {
    tracks: 'usd',
    form: 'direct',
    note: 'USDC on OP Mainnet.',
  },
};

/**
 * Classifies one asset.
 *
 * Suspect assets are never classified: they are outside the total, so including
 * them in an exposure figure would let excluded value back into a statement about
 * the portfolio.
 */
export function classifyAsset(asset: {
  chainId: number;
  contractAddress: string | null;
  suspect: boolean;
}): AssetClassification {
  if (asset.suspect) {
    return UNCLASSIFIED;
  }
  const key = `${asset.chainId}:${asset.contractAddress?.toLowerCase() ?? 'native'}`;
  return REGISTRY[key] ?? UNCLASSIFIED;
}

/** Human label for a tracked asset. Used by the panel, never by the arithmetic. */
export const TRACKED_ASSET_LABEL: Readonly<Record<TrackedAsset, string>> = {
  usd: 'the US dollar',
  eth: 'ether',
  btc: 'bitcoin',
  unclassified: 'something Nuxfolio does not classify',
};

/** How a holding form is described, when it is worth describing. */
export const HOLDING_FORM_LABEL: Readonly<Record<HoldingForm, string | null>> = {
  direct: null,
  'staking-receipt': 'held as a staking receipt',
  'lending-receipt': 'held as a lending receipt',
};

/** Visible for tests: how many entries the registry carries. */
export const REGISTRY_SIZE = Object.keys(REGISTRY).length;
