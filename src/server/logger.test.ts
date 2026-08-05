import { describe, expect, it } from 'vitest';

import { createRecordingLogger, TEST_ADDRESS } from '@/test/helpers';

import { describeError, redact, redactUrl } from './logger';

/**
 * A value that must never appear in output. If a test in this file fails, a
 * credential is reaching the logs.
 */
const SENTINEL_SECRET = 'sk-nuxfolio-sentinel-do-not-log';

describe('createLogger', () => {
  it('emits one JSON object per line with the event name and level', () => {
    const { logger, lines } = createRecordingLogger();
    logger.info('portfolio.loaded', { assetCount: 3 });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toEqual({
      time: '2026-01-01T00:00:00.000Z',
      level: 'info',
      event: 'portfolio.loaded',
      assetCount: 3,
    });
  });

  it('drops records below the configured level', () => {
    const { logger, lines } = createRecordingLogger('warn');
    logger.debug('noise');
    logger.info('also noise');
    logger.warn('kept');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('kept');
  });

  it('scrubs a configured secret from anywhere in the line', () => {
    const { logger, lines } = createRecordingLogger('debug', [SENTINEL_SECRET]);
    logger.error('provider.failed', {
      url: `https://api.provider.test/v2/${SENTINEL_SECRET}`,
      note: `key was ${SENTINEL_SECRET}`,
    });

    expect(lines[0]).not.toContain(SENTINEL_SECRET);
    expect(lines[0]).toContain('[redacted]');
  });

  it('shortens wallet addresses, so a lookup is correlatable but not recorded', () => {
    const { logger, lines } = createRecordingLogger();
    logger.info('portfolio.loaded', { address: TEST_ADDRESS });

    expect(lines[0]).not.toContain(TEST_ADDRESS);
    expect(lines[0]).toContain('0xd8dA…6045');
  });

  it('masks a long hex run, which is what an unregistered key looks like', () => {
    const { logger, lines } = createRecordingLogger();
    logger.info('provider.request', { token: 'deadbeefcafebabedeadbeefcafebabe1234' });

    expect(lines[0]).toContain('[redacted-hex]');
  });

  it('leaves long decimal numbers alone, since base-unit balances are not secrets', () => {
    const { logger, lines } = createRecordingLogger();
    logger.info('asset', { rawQuantity: '123456789012345678901234567890123456' });

    expect(lines[0]).toContain('123456789012345678901234567890123456');
  });

  it('serialises bigint fields instead of throwing', () => {
    const { logger, lines } = createRecordingLogger();
    logger.info('balance', { raw: 10n ** 20n });

    expect(JSON.parse(lines[0] as string)).toMatchObject({ raw: '100000000000000000000' });
  });

  it('records an Error as name and message, never as an empty object', () => {
    const { logger, lines } = createRecordingLogger();
    logger.error('failed', { cause: new TypeError('bad input') });

    expect(JSON.parse(lines[0] as string)).toMatchObject({
      cause: { errorName: 'TypeError', errorMessage: 'bad input' },
    });
  });

  it('carries child bindings into every record', () => {
    const { logger, lines } = createRecordingLogger();
    logger.child({ route: 'api.portfolio' }).info('handled');

    expect(JSON.parse(lines[0] as string)).toMatchObject({ route: 'api.portfolio' });
  });
});

describe('redact', () => {
  it('applies secret scrubbing before the generic hex rule', () => {
    expect(redact(`key=${SENTINEL_SECRET}`, [SENTINEL_SECRET])).toBe('key=[redacted]');
  });

  it('ignores secrets too short to be distinguishable from ordinary text', () => {
    expect(redact('the value is abc', ['abc'])).toBe('the value is abc');
  });
});

describe('redactUrl', () => {
  it('drops the query string, where API keys usually live', () => {
    expect(redactUrl('https://api.provider.test/v2/prices?apiKey=secret&ids=1')).toBe(
      'https://api.provider.test/v2/prices',
    );
  });

  it('keeps origin and path so the endpoint is still identifiable', () => {
    expect(redactUrl('https://eth-mainnet.g.alchemy.com/v2/abc')).toBe(
      'https://eth-mainnet.g.alchemy.com/v2/abc',
    );
  });

  it('does not throw on an unparseable value', () => {
    expect(redactUrl('not a url')).toBe('[unparseable-url]');
  });
});

describe('describeError', () => {
  it('describes an Error', () => {
    expect(describeError(new RangeError('out of range'))).toEqual({
      errorName: 'RangeError',
      errorMessage: 'out of range',
    });
  });

  it('describes a thrown non-Error without losing it', () => {
    expect(describeError('plain string')).toEqual({
      errorName: 'NonError',
      errorMessage: 'plain string',
    });
  });
});
