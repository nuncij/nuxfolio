import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SORT,
  isDefaultSort,
  parseAssetSort,
  toggleAssetSort,
  withAssetSort,
} from './assetSort';

describe('parseAssetSort', () => {
  it('reads a valid pair', () => {
    expect(parseAssetSort({ sort: 'name', dir: 'asc' })).toEqual({
      key: 'name',
      direction: 'asc',
    });
  });

  it('defaults to the largest holding first', () => {
    expect(parseAssetSort({})).toEqual(DEFAULT_SORT);
    expect(DEFAULT_SORT).toEqual({ key: 'value', direction: 'desc' });
  });

  it('falls back on each parameter independently', () => {
    // `?sort=name` with no direction is a reasonable request; refusing the whole
    // thing because half of it is missing would be needlessly strict.
    expect(parseAssetSort({ sort: 'name' })).toEqual({ key: 'name', direction: 'desc' });
    expect(parseAssetSort({ dir: 'asc' })).toEqual({ key: 'value', direction: 'asc' });
  });

  it.each([
    '<script>alert(1)</script>',
    'sideways',
    'VALUE',
    '',
    'value; DROP TABLE',
    '../../etc/passwd',
  ])('falls back rather than trusting %o from a query string', (value) => {
    // A query string is hostile input, like a stored theme or a saved wallet.
    expect(parseAssetSort({ sort: value, dir: value })).toEqual(DEFAULT_SORT);
  });

  it('takes the first value when a parameter is repeated', () => {
    // `?sort=name&sort=value` is legal in a URL and has to resolve to something.
    expect(parseAssetSort({ sort: ['name', 'value'] })).toEqual({
      key: 'name',
      direction: 'desc',
    });
  });
});

describe('withAssetSort', () => {
  it('adds both parameters for a non-default sort', () => {
    expect(withAssetSort('/portfolio/0xabc', { key: 'name', direction: 'asc' })).toBe(
      '/portfolio/0xabc?sort=name&dir=asc',
    );
  });

  it('leaves no trace of the default, so a plain link stays plain', () => {
    // Freezing the current default into every copied link would make changing it
    // later a change to everyone's saved URLs.
    expect(withAssetSort('/portfolio/0xabc?sort=name&dir=asc', DEFAULT_SORT)).toBe(
      '/portfolio/0xabc',
    );
  });

  it('keeps other parameters untouched', () => {
    expect(
      withAssetSort('/portfolio/0xabc?chainId=1&ens=vitalik.eth', {
        key: 'name',
        direction: 'asc',
      }),
    ).toBe('/portfolio/0xabc?chainId=1&ens=vitalik.eth&sort=name&dir=asc');
  });

  it('keeps other parameters when clearing the sort', () => {
    expect(withAssetSort('/portfolio/0xabc?chainId=1&sort=name&dir=asc', DEFAULT_SORT)).toBe(
      '/portfolio/0xabc?chainId=1',
    );
  });

  it('preserves a fragment', () => {
    expect(withAssetSort('/portfolio/0xabc#assets', { key: 'name', direction: 'asc' })).toBe(
      '/portfolio/0xabc?sort=name&dir=asc#assets',
    );
  });

  it('round-trips through the parser', () => {
    for (const sort of [
      { key: 'name', direction: 'asc' },
      { key: 'name', direction: 'desc' },
      { key: 'value', direction: 'asc' },
    ] as const) {
      const url = new URL(withAssetSort('/x', sort), 'https://x.invalid');
      expect(
        parseAssetSort({
          sort: url.searchParams.get('sort') ?? undefined,
          dir: url.searchParams.get('dir') ?? undefined,
        }),
      ).toEqual(sort);
    }
  });
});

describe('isDefaultSort', () => {
  it('recognises the default and nothing else', () => {
    expect(isDefaultSort(DEFAULT_SORT)).toBe(true);
    expect(isDefaultSort({ key: 'value', direction: 'asc' })).toBe(false);
    expect(isDefaultSort({ key: 'name', direction: 'desc' })).toBe(false);
  });
});

describe('toggleAssetSort', () => {
  it('flips the direction on the same column', () => {
    expect(toggleAssetSort({ key: 'value', direction: 'desc' }, 'value')).toEqual({
      key: 'value',
      direction: 'asc',
    });
    expect(toggleAssetSort({ key: 'value', direction: 'asc' }, 'value')).toEqual({
      key: 'value',
      direction: 'desc',
    });
  });

  it('starts a new column in the direction that is useful for it', () => {
    // Names read from A; values from the largest holding.
    expect(toggleAssetSort({ key: 'value', direction: 'desc' }, 'name')).toEqual({
      key: 'name',
      direction: 'asc',
    });
    expect(toggleAssetSort({ key: 'name', direction: 'asc' }, 'value')).toEqual({
      key: 'value',
      direction: 'desc',
    });
  });

  it('is stable under repetition', () => {
    let sort = DEFAULT_SORT;
    for (let index = 0; index < 4; index += 1) {
      sort = toggleAssetSort(sort, 'value');
    }
    expect(sort).toEqual(DEFAULT_SORT);
  });
});
