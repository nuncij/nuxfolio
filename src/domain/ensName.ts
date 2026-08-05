/**
 * ENS name recognition.
 *
 * Deliberately narrower than ENS itself. Only `.eth` names built from ASCII
 * letters, digits and hyphens are recognised, because that subset needs no
 * normalisation: a name outside it must go through UTS-46 (emoji, mixed scripts,
 * confusable characters) before it can be hashed safely, and guessing at that is
 * how a lookup silently resolves the wrong name. Everything else falls through to
 * address parsing and gets rejected there.
 *
 * Recognition is a pure, client-safe concern — the form uses it to decide where
 * to navigate, the server uses it to decide what to resolve, and the portfolio
 * page uses it to re-validate the display-only `ens` query parameter. Resolution
 * itself is server-only; see `src/server/ens.ts`.
 */

/**
 * A DNS name may be 255 bytes. Anything longer is not a name anyone owns, and
 * the bound keeps a pathological input away from the hashing and the log line.
 */
export const ENS_NAME_MAX_LENGTH = 255;

/**
 * At least two labels, the last of which is `eth`. Hyphens are allowed anywhere
 * inside a label: ENS is more permissive here than IDNA, and a name that cannot
 * exist simply fails to resolve rather than needing its own rejection rule.
 */
const ENS_NAME_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth$/;

export type EnsNameParseResult = { ok: true; name: string } | { ok: false };

/**
 * Recognises and canonicalises an ENS name.
 *
 * Case is not part of an ENS name — the registry stores hashes of lowercase
 * labels — so input is lowercased rather than rejected. No message is produced:
 * a caller that does not get a name goes on to parse the input as an address,
 * which owns the user-facing explanation.
 */
export function parseEnsName(input: string): EnsNameParseResult {
  const candidate = input.trim().toLowerCase();

  if (candidate.length === 0 || candidate.length > ENS_NAME_MAX_LENGTH) {
    return { ok: false };
  }
  if (!ENS_NAME_PATTERN.test(candidate)) {
    return { ok: false };
  }
  return { ok: true, name: candidate };
}
