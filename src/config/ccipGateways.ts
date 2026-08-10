import 'server-only';

/**
 * The gateways this project is willing to fetch from for offchain ENS resolution.
 *
 * **Why a list at all.** CCIP-read (ERC-3668) tells the client to fetch a URL that the
 * *name's own resolver* supplies — chosen by whoever registered the name. Review round 4
 * called that a blocker and switched CCIP off: anyone could register a name pointing at
 * `http://169.254.169.254/…` and make this server issue requests inside its own network.
 * A list turns an attacker-chosen destination into one this project chose, which removes
 * the vulnerability rather than narrowing it. `server/ssrfGuard.ts` sits behind it as
 * defence in depth, for a listed host whose DNS is turned against it.
 *
 * **Why not just the guard.** Without a list, every ENS registrant gets an
 * outbound-request primitive from a small shared VPS. The guard stops private
 * destinations; it does not stop the box being used to probe arbitrary public ones.
 *
 * **How this list was built, and how to extend it.** Measured on 2026-08-08 by resolving
 * names through the same path the app uses — viem's `getEnsAddress`, which goes via
 * `resolveWithGateways` — with a recorder in place of the fetch, so the URLs were
 * observed and nothing was requested. An earlier attempt measured
 * `UniversalResolver.resolve` directly and got a single batch gateway; that was the wrong
 * path and produced a list that would have blocked every real name.
 *
 * Adding an entry is one line and needs the same thing: resolve a name that uses it,
 * record the host, note the date. It must never be a host anyone can deploy to —
 * `offchain-resolver-example.uc.r.appspot.com` was observed and deliberately left out,
 * because it is ENS's demo on shared hosting rather than a namespace anybody uses.
 *
 * **A name whose gateway is not here fails closed** — it resolves to nothing, exactly as
 * every offchain name does today. Nothing that works now can break.
 */

export type CcipGateway = {
  readonly host: string;
  /** Which names use it, so a future reader can tell whether it still earns its place. */
  readonly serves: string;
  readonly verifiedOn: string;
};

export const CCIP_GATEWAYS: readonly CcipGateway[] = [
  { host: 'api.coinbase.com', serves: '*.base.eth', verifiedOn: '2026-08-08' },
  {
    host: 'entry-gateway.backend-prod.api.uniswap.org',
    serves: '*.uni.eth',
    verifiedOn: '2026-08-08',
  },
  { host: 'linea-ccip-gateway.linea.build', serves: '*.linea.eth', verifiedOn: '2026-08-08' },
  {
    // Added 2026-08-10, two days after the list was written, when `vitalik.box` was
    // refused. Exactly the maintenance ADR-032 said to expect: a namespace this project
    // had not met, showing up as a name that would not resolve rather than as a wrong
    // answer.
    host: 'api.3dns.xyz',
    serves: '*.box',
    verifiedOn: '2026-08-10',
  },
  {
    // Seen on the `UniversalResolver.resolve` path rather than the one the app takes.
    // Kept because it is ENS's own batch gateway, and a resolver or a viem upgrade that
    // routes through it should not silently start failing.
    host: 'ccip-v2.ens.xyz',
    serves: "ENS's batch gateway",
    verifiedOn: '2026-08-08',
  },
];

export const CCIP_GATEWAY_HOSTS: readonly string[] = CCIP_GATEWAYS.map((gateway) => gateway.host);
