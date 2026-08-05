/**
 * Makes "the unit suite never touches the network" an enforced property rather
 * than a documented intention.
 *
 * Every adapter takes `fetch` from its injected `ProviderContext`, and every test
 * supplies a stub — that was the design, and `vitest.config.ts` said so in a
 * comment. A comment does not fail. When the display-rate provider was added, the
 * service selected it from the registry whenever a test did not explicitly
 * disable it, and since those tests inject fake providers rather than a fake
 * `fetch`, `context.fetch` fell through to the global one. Every service test
 * quietly made a real HTTPS request to the European Central Bank, which is also
 * where an intermittent failure came from.
 *
 * Replacing the global `fetch` turns that from an invisible slow path into an
 * immediate, named failure. A test that genuinely needs a response injects one;
 * a test that reaches past its own seams now says so out loud.
 */

const escaped = (target: unknown): never => {
  throw new Error(
    `A test reached the real network: ${String(target)}\n` +
      'Adapters must use the `fetch` from their injected ProviderContext, and ' +
      'tests must supply it (see `createFetchStub` in src/test/helpers.ts). If a ' +
      'service selected a provider from the registry, pass a fake or null for it.',
  );
};

globalThis.fetch = ((input: unknown) => escaped(input)) as typeof globalThis.fetch;
