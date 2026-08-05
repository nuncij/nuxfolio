import { describe, expect, it } from 'vitest';

import { createFetchStub, createTestContext } from '@/test/helpers';

import { ProviderError } from '../types';

import { createEcbRateProvider, parseEcbDaily } from './ecb';

/** A trimmed copy of the real document, structure preserved exactly. */
function ecbXml(
  options: { date?: string; usd?: string; includeUsd?: boolean; quote?: string } = {},
): string {
  const { date = '2026-07-31', usd = '1.1485', includeUsd = true, quote = "'" } = options;
  const usdLine = includeUsd
    ? `<Cube currency=${quote}USD${quote} rate=${quote}${usd}${quote}/>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
	<gesmes:subject>Reference rates</gesmes:subject>
	<Cube>
		<Cube time=${quote}${date}${quote}>
			${usdLine}
			<Cube currency=${quote}JPY${quote} rate=${quote}184.03${quote}/>
		</Cube>
	</Cube>
</gesmes:Envelope>`;
}

describe('parseEcbDaily', () => {
  it('reads the rate and the date the source stamped on it', () => {
    expect(parseEcbDaily(ecbXml())).toEqual({
      base: 'EUR',
      quote: 'USD',
      rate: '1.1485',
      asOf: '2026-07-31',
    });
  });

  it('takes the date from the document, never from the clock', () => {
    // The whole reason this adapter exists in this shape. The ECB fixes rates on
    // business days only, so a Monday request returns Friday's figure — and
    // stamping "now" on it would claim a freshness nobody offered.
    expect(parseEcbDaily(ecbXml({ date: '2026-07-24' })).asOf).toBe('2026-07-24');
  });

  it('accepts double-quoted attributes, which are equally valid XML', () => {
    // Being brittle here would turn a producer's formatting change into an outage.
    expect(parseEcbDaily(ecbXml({ quote: '"' })).rate).toBe('1.1485');
  });

  it('reads a rate given with more precision than usual', () => {
    expect(parseEcbDaily(ecbXml({ usd: '1.148523' })).rate).toBe('1.148523');
  });

  it('rejects a document with no USD line rather than guessing a rate', () => {
    expect(() => parseEcbDaily(ecbXml({ includeUsd: false }))).toThrow(ProviderError);
  });

  it('rejects a document with no date, since an undated rate cannot be labelled', () => {
    expect(() => parseEcbDaily('<Cube><Cube currency="USD" rate="1.1"/></Cube>')).toThrow(
      ProviderError,
    );
  });

  it.each(['0', '0.0'])('rejects a rate of %o rather than dividing by it', (usd) => {
    // Dividing by zero would put Infinity into every figure on the page.
    expect(() => parseEcbDaily(ecbXml({ usd }))).toThrow(ProviderError);
  });

  it('rejects an unparseable body rather than returning a partial quote', () => {
    expect(() => parseEcbDaily('<html>Service unavailable</html>')).toThrow(ProviderError);
  });
});

describe('createEcbRateProvider', () => {
  it('fetches and parses the live document shape', async () => {
    const { fetchImpl, calls } = createFetchStub(() => new Response(ecbXml()));

    const quote = await createEcbRateProvider().fetchRate({
      context: createTestContext(fetchImpl),
    });

    expect(quote).toEqual({ base: 'EUR', quote: 'USD', rate: '1.1485', asOf: '2026-07-31' });
    expect(calls).toHaveLength(1);
    // A fixed, public, keyless URL — nothing to redact, and worth asserting so a
    // future change that adds a query parameter is noticed.
    expect(calls[0]?.url).toBe('https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml');
  });

  it('raises rather than returning a rate when the document is unusable', async () => {
    const { fetchImpl } = createFetchStub(() => new Response('nonsense'));

    await expect(
      createEcbRateProvider().fetchRate({ context: createTestContext(fetchImpl) }),
    ).rejects.toMatchObject({ kind: 'invalid-response' });
  });

  it('raises on an HTTP failure, which the caller degrades to no euro', async () => {
    const { fetchImpl } = createFetchStub(() => new Response('down', { status: 503 }));

    await expect(
      createEcbRateProvider().fetchRate({ context: createTestContext(fetchImpl) }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
