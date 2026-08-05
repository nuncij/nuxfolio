import { describe, expect, it } from 'vitest';

import { getSecretValues, parseServerEnv } from './env';

describe('parseServerEnv', () => {
  it('applies defaults when nothing is configured', () => {
    const env = parseServerEnv({});

    expect(env.PRICE_CONFIDENCE_MIN).toBe(0.7);
    expect(env.PRICE_MAX_AGE_SECONDS).toBe(3600);
    expect(env.PORTFOLIO_CACHE_TTL_SECONDS).toBe(60);
    expect(env.RATE_LIMIT_MAX_REQUESTS).toBe(30);
    expect(env.TRUST_PROXY_HEADERS).toBe(false);
    expect(env.CLIENT_IP_HEADER).toBe('x-forwarded-for');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.TOKEN_LIST_MAX_AGE_DAYS).toBe(60);
    expect(env.ALCHEMY_API_KEY).toBeUndefined();
  });

  it('accepts a token-list age override', () => {
    expect(parseServerEnv({ TOKEN_LIST_MAX_AGE_DAYS: '14' }).TOKEN_LIST_MAX_AGE_DAYS).toBe(14);
  });

  it('rejects a token-list age that is not a positive whole number of days', () => {
    expect(() => parseServerEnv({ TOKEN_LIST_MAX_AGE_DAYS: '0' })).toThrow(
      /TOKEN_LIST_MAX_AGE_DAYS/,
    );
    expect(() => parseServerEnv({ TOKEN_LIST_MAX_AGE_DAYS: '1.5' })).toThrow(
      /TOKEN_LIST_MAX_AGE_DAYS/,
    );
  });

  it('treats an empty value as unset, since .env.example ships empty keys', () => {
    // Copying .env.example yields `KEY=` for everything; without this, every
    // default below would be bypassed by an empty string.
    const env = parseServerEnv({
      ALCHEMY_API_KEY: '',
      PRICE_CONFIDENCE_MIN: '   ',
      LOG_LEVEL: '',
    });

    expect(env.ALCHEMY_API_KEY).toBeUndefined();
    expect(env.PRICE_CONFIDENCE_MIN).toBe(0.7);
    expect(env.LOG_LEVEL).toBe('info');
  });

  it('trims surrounding whitespace from configured values', () => {
    expect(parseServerEnv({ LOG_LEVEL: '  debug  ' }).LOG_LEVEL).toBe('debug');
  });

  it('parses a comma-separated list of RPC URLs', () => {
    const env = parseServerEnv({
      ETHEREUM_RPC_URLS: 'https://a.example, https://b.example ,',
    });

    expect(env.ETHEREUM_RPC_URLS).toEqual(['https://a.example', 'https://b.example']);
  });

  it('rejects an RPC entry that is not an http(s) URL', () => {
    expect(() => parseServerEnv({ ETHEREUM_RPC_URLS: 'ws://a.example' })).toThrow(
      /ETHEREUM_RPC_URLS/,
    );
  });

  it.each(['true', '1'])('reads %o as a true flag', (value) => {
    expect(parseServerEnv({ TRUST_PROXY_HEADERS: value }).TRUST_PROXY_HEADERS).toBe(true);
  });

  it.each(['false', '0'])('reads %o as a false flag', (value) => {
    expect(parseServerEnv({ TRUST_PROXY_HEADERS: value }).TRUST_PROXY_HEADERS).toBe(false);
  });

  it('rejects an ambiguous flag rather than guessing', () => {
    expect(() => parseServerEnv({ TRUST_PROXY_HEADERS: 'yes' })).toThrow(/TRUST_PROXY_HEADERS/);
  });

  it('rejects an out-of-range confidence threshold', () => {
    expect(() => parseServerEnv({ PRICE_CONFIDENCE_MIN: '1.5' })).toThrow(/PRICE_CONFIDENCE_MIN/);
  });

  it('rejects a non-numeric duration', () => {
    expect(() => parseServerEnv({ PORTFOLIO_CACHE_TTL_SECONDS: 'sixty' })).toThrow(
      /PORTFOLIO_CACHE_TTL_SECONDS/,
    );
  });

  it('rejects an API key too short to be real', () => {
    expect(() => parseServerEnv({ ALCHEMY_API_KEY: 'abc' })).toThrow(/ALCHEMY_API_KEY/);
  });

  it('names the offending key without echoing its value', () => {
    // A configuration error must not print a credential into a crash log.
    const secret = 'sk-should-never-appear-in-an-error';
    const error = (() => {
      try {
        parseServerEnv({ ALCHEMY_API_KEY: secret, LOG_LEVEL: 'verbose' });
        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();

    expect(error?.message).toContain('LOG_LEVEL');
    expect(error?.message).not.toContain(secret);
    expect(error?.message).not.toContain('verbose');
  });

  it('lists every invalid key at once, so configuration is fixed in one pass', () => {
    const error = (() => {
      try {
        parseServerEnv({ LOG_LEVEL: 'loud', TRUST_PROXY_HEADERS: 'maybe' });
        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();

    expect(error?.message).toContain('LOG_LEVEL');
    expect(error?.message).toContain('TRUST_PROXY_HEADERS');
  });

  it('ignores unrelated environment variables', () => {
    expect(() => parseServerEnv({ PATH: '/usr/bin', HOME: '/home/someone' })).not.toThrow();
  });
});

describe('getSecretValues', () => {
  it('returns the configured credential so the logger can scrub it', () => {
    const env = parseServerEnv({ ALCHEMY_API_KEY: 'alchemy-key-value' });
    expect(getSecretValues(env)).toEqual(['alchemy-key-value']);
  });

  it('returns nothing when no credential is configured', () => {
    expect(getSecretValues(parseServerEnv({}))).toEqual([]);
  });
});
