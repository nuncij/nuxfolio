import type { AssetSortKey, SortDirection } from './portfolio';

/**
 * Sort order as a shareable, untrusted URL parameter.
 *
 * Two rules, and they are the same two that govern every other value that reaches
 * this codebase from outside it:
 *
 *  - **A query string is hostile input.** `?sort=<script>` or `?dir=sideways` falls
 *    back to the default rather than being trusted, exactly as a stored theme or a
 *    saved wallet does.
 *  - **The default never appears in the URL.** A link someone shares should carry the
 *    sort only when they chose one, so the common link stays short and a future change
 *    of default is not frozen into every link ever copied.
 */

export const DEFAULT_SORT_KEY: AssetSortKey = 'value';
export const DEFAULT_SORT_DIRECTION: SortDirection = 'desc';

export const SORT_KEY_PARAM = 'sort';
export const SORT_DIRECTION_PARAM = 'dir';

export type AssetSort = {
  readonly key: AssetSortKey;
  readonly direction: SortDirection;
};

export const DEFAULT_SORT: AssetSort = {
  key: DEFAULT_SORT_KEY,
  direction: DEFAULT_SORT_DIRECTION,
};

const SORT_KEYS: readonly string[] = ['value', 'name'];
const SORT_DIRECTIONS: readonly string[] = ['asc', 'desc'];

/**
 * Reads a sort order out of query values.
 *
 * Each parameter falls back on its own: `?sort=name` with no direction is a sensible
 * request, and refusing the whole thing because half of it is absent would be
 * needlessly strict.
 */
export function parseAssetSort(input: {
  sort?: string | string[] | undefined;
  dir?: string | string[] | undefined;
}): AssetSort {
  return {
    key: SORT_KEYS.includes(first(input.sort) ?? '')
      ? (first(input.sort) as AssetSortKey)
      : DEFAULT_SORT_KEY,
    direction: SORT_DIRECTIONS.includes(first(input.dir) ?? '')
      ? (first(input.dir) as SortDirection)
      : DEFAULT_SORT_DIRECTION,
  };
}

export function isDefaultSort(sort: AssetSort): boolean {
  return sort.key === DEFAULT_SORT_KEY && sort.direction === DEFAULT_SORT_DIRECTION;
}

/**
 * Rewrites a URL's sort parameters, dropping them when the sort is the default.
 *
 * Takes and returns a string rather than touching `history` itself, so the rule is
 * testable without a browser — which is the only reason it is worth being a function
 * at all.
 */
export function withAssetSort(url: string, sort: AssetSort): string {
  // A relative URL needs a base to parse; the base is discarded on the way out.
  const parsed = new URL(url, 'https://placeholder.invalid');

  if (isDefaultSort(sort)) {
    parsed.searchParams.delete(SORT_KEY_PARAM);
    parsed.searchParams.delete(SORT_DIRECTION_PARAM);
  } else {
    parsed.searchParams.set(SORT_KEY_PARAM, sort.key);
    parsed.searchParams.set(SORT_DIRECTION_PARAM, sort.direction);
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** What clicking a column header does: same column flips, new column resets. */
export function toggleAssetSort(current: AssetSort, key: AssetSortKey): AssetSort {
  if (current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  // A fresh column starts in the direction that is useful for it: names read from A,
  // values from the largest holding.
  return { key, direction: key === 'name' ? 'asc' : 'desc' };
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
