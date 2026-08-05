/**
 * Canonical portfolio URLs.
 *
 * Client-safe on purpose: the chain selector navigates in the browser and the
 * ENS route redirects on the server, and both must produce byte-identical
 * links. When the selector built its own URL it silently dropped the `ens`
 * parameter, so a portfolio reached by name lost its name on the first network
 * change.
 */
export function portfolioPath(input: {
  address: string;
  // `undefined` is spelled out because the project compiles with
  // `exactOptionalPropertyTypes`: "absent" and "present but unknown" are
  // different types, and callers pass the latter straight from a query string.
  ensName?: string | null | undefined;
  chainId?: string | null | undefined;
}): string {
  const params = new URLSearchParams();
  if (input.chainId !== null && input.chainId !== undefined && input.chainId.length > 0) {
    params.set('chainId', input.chainId);
  }
  if (input.ensName !== null && input.ensName !== undefined && input.ensName.length > 0) {
    params.set('ens', input.ensName);
  }

  const query = params.toString();
  return `/portfolio/${input.address}${query.length === 0 ? '' : `?${query}`}`;
}
