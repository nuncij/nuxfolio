import 'server-only';

import type { WalletAddress } from '@/domain/address';

/**
 * Convex deployments, by chain.
 *
 * Convex stakes a Curve LP token on the wallet's behalf, which is why it is here at all:
 * the position lives in Convex's own reward contract, so `balanceOf` on the wallet finds
 * nothing. That is the distinction milestone 5 exists for, and the reason Lido and Curve
 * were dropped from it — measured on 2026-08-08, their receipt tokens are already on the
 * bundled lists and already counted.
 *
 * **Two chains, both checked.** The same `Booster` address answers `poolLength()` on
 * Ethereum (581 pools) and Arbitrum (39). It returns nothing on Base, Optimism and BNB,
 * so Convex is absent there rather than unimplemented — an address that does not answer
 * is a deployment that does not exist.
 */

export type ConvexDeployment = {
  readonly chainId: number;
  /** The `Booster`, which owns the pool registry. */
  readonly booster: WalletAddress;
  /** When this was last checked against a live endpoint. */
  readonly verifiedOn: string;
};

export const CONVEX_DEPLOYMENTS: readonly ConvexDeployment[] = [
  { chainId: 1, booster: '0xF403C135812408BFbE8713b5A23a04b3D48AAE31', verifiedOn: '2026-08-08' },
  {
    chainId: 42161,
    booster: '0xF403C135812408BFbE8713b5A23a04b3D48AAE31',
    verifiedOn: '2026-08-08',
  },
];

/** The deployment on one chain, or undefined where Convex is not deployed. */
export function convexForChain(chainId: number): ConvexDeployment | undefined {
  return CONVEX_DEPLOYMENTS.find((deployment) => deployment.chainId === chainId);
}
