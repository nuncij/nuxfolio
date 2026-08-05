import { z } from 'zod';

import { isDecimalString } from '@/domain/money';
import { decodeText, fetchJson } from '@/server/http';

import { ProviderError, type FxQuote, type RateProvider } from '../types';

/**
 * The euro reference rate, from the European Central Bank.
 *
 * Chosen over a commercial FX API for three reasons: it needs no key, it is the
 * rate European institutions actually cite, and it publishes its own date. That
 * last point is the important one — the ECB fixes rates around 16:00 CET on
 * **TARGET business days only**, so a request on a Monday morning returns
 * Friday's figure, and over a holiday it can be three or four days old.
 *
 * This adapter therefore never stamps the fetch time on a rate. `asOf` is the
 * date inside the document. A conversion is an estimate at a dated rate, and
 * pretending otherwise would be the same class of quiet claim as calling a
 * subtotal a total.
 *
 * The document is XML, which is why this is the one adapter using the text
 * decoder. Parsing stays here: nothing above this file knows the ECB publishes
 * anything but an {@link FxQuote}.
 */

const PROVIDER_ID = 'ecb';
const BASE_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml';

/** The body arrives as text; the shape check is the parse below. */
const bodySchema = z.string().min(1);

/**
 * `<Cube time='2026-07-31'>` — the day the rates were fixed.
 *
 * Both quote styles are accepted because an XML producer may legitimately use
 * either, and being brittle about it would turn a formatting change into an
 * outage.
 */
const DATE_PATTERN = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/;

/** `<Cube currency='USD' rate='1.1485'/>` — attributes in either order. */
const USD_RATE_PATTERNS = [
  /<Cube\s+currency=['"]USD['"]\s+rate=['"]([\d.]+)['"]/,
  /<Cube\s+rate=['"]([\d.]+)['"]\s+currency=['"]USD['"]/,
];

export function createEcbRateProvider(): RateProvider {
  return {
    id: PROVIDER_ID,

    async fetchRate({ context }): Promise<FxQuote> {
      const body = await fetchJson({
        url: BASE_URL,
        // Fixed, public, keyless URL, so it is safe in a log line as-is.
        schema: bodySchema,
        decode: decodeText,
        providerId: PROVIDER_ID,
        context,
      });

      return parseEcbDaily(body);
    },
  };
}

/**
 * Exported for tests: the parsing is the whole of this adapter's behaviour, and
 * an XML fixture exercises it without a network.
 */
export function parseEcbDaily(body: string): FxQuote {
  const date = DATE_PATTERN.exec(body)?.[1];
  if (date === undefined) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      'The ECB daily file carried no rate date',
    );
  }

  const rate = USD_RATE_PATTERNS.map((pattern) => pattern.exec(body)?.[1]).find(
    (match): match is string => match !== undefined,
  );
  if (rate === undefined) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      'The ECB daily file carried no USD rate',
    );
  }

  // A rate that is not a plain decimal, or is zero or negative, is not a rate.
  // Dividing by it would produce a confident, wrong number in every figure on
  // the page, so it fails here instead.
  if (!isDecimalString(rate) || Number.parseFloat(rate) <= 0) {
    throw new ProviderError(
      'invalid-response',
      PROVIDER_ID,
      'The ECB daily file carried an unusable USD rate',
    );
  }

  return { base: 'EUR', quote: 'USD', rate, asOf: date };
}
