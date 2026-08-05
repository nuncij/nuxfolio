import type { PortfolioAsset } from '@/domain/portfolio';

/**
 * Attribution for the price sources actually used.
 *
 * CoinGecko's Demo licence *requires* this: "Powered by CoinGecko API" with a
 * link back, at no less than 10 pt. So it is not decoration and not optional —
 * it is a term of use, and rendering it from the data is what stops it being
 * forgotten when the cross-check is on or appearing falsely when it is off.
 *
 * DefiLlama asks for nothing comparable, but crediting both is honest about where
 * the numbers came from and costs a line.
 */

/** Verifier ids that carry an attribution obligation, and how to satisfy it. */
const CREDITS: Readonly<Record<string, { label: string; href: string }>> = {
  coingecko: { label: 'CoinGecko API', href: 'https://www.coingecko.com/en/api' },
};

const PRIMARY_CREDITS: Readonly<Record<string, { label: string; href: string }>> = {
  defillama: { label: 'DefiLlama', href: 'https://defillama.com/docs/api' },
};

/**
 * Deriving the credit from the rendered rows is only safe because of two
 * properties upstream, both of which a reviewer flagged as gaps before they held:
 *
 *  - Cross-check selection happens *after* the per-chain cap, so an asset
 *    carrying a `priceCheck` is always one of the assets on screen. Credit cannot
 *    disappear because the row it belonged to was truncated away.
 *  - A ref the verifier never actually requested carries no `priceCheck` at all
 *    (`attemptedRefKeys`), so a deadline that expired before the first call
 *    cannot produce a credit for data that was never fetched.
 *
 * If either changes, this component starts making false provenance claims — so
 * the credit would need to move into the payload instead.
 */
export function PriceSourceCredit({
  assets,
  priceSource,
}: {
  assets: readonly Pick<PortfolioAsset, 'priceCheck'>[];
  priceSource: string | null;
}) {
  // Derived from what the payload actually contains, so the credit tracks use.
  const verifiers = new Set(
    assets
      .map((asset) => asset.priceCheck?.source)
      .filter((source): source is string => source !== undefined),
  );

  // Indexing a record yields `undefined` under noUncheckedIndexedAccess, so it is
  // normalised to null rather than being checked for the wrong absent value.
  const primary = (priceSource === null ? undefined : PRIMARY_CREDITS[priceSource]) ?? null;
  const checked = [...verifiers]
    .map((id) => CREDITS[id])
    .filter((credit): credit is { label: string; href: string } => credit !== undefined);

  if (primary === null && checked.length === 0) {
    return null;
  }

  return (
    // Body font size, not a smaller caption: the licence sets a 10 pt floor.
    <p className="text-sm text-ink-subtle">
      {primary === null ? null : (
        <>
          Prices by <Credit label={primary.label} href={primary.href} />
        </>
      )}
      {checked.length > 0 ? (
        <>
          {primary === null ? 'Prices ' : ', '}
          cross-checked using{' '}
          {checked.map((credit, index) => (
            <span key={credit.href}>
              {index > 0 ? ', ' : ''}
              <Credit label={`Powered by ${credit.label}`} href={credit.href} />
            </span>
          ))}
        </>
      ) : null}
      .
    </p>
  );
}

function Credit({ label, href }: { label: string; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent hover:underline"
    >
      {label}
    </a>
  );
}
