/**
 * Structured server-side logging with mandatory redaction.
 *
 * Two things must never reach a log line: a provider credential and a full
 * wallet address. The first is a security failure, the second is a privacy
 * failure for a product whose whole premise is looking up other people's
 * addresses. Both are handled here rather than at each call site, because a
 * rule that depends on every caller remembering it is not a rule.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export type LoggerOptions = {
  level: LogLevel;
  /** Literal secret values scrubbed from every emitted line. */
  secrets?: readonly string[];
  /** Injected for tests; defaults to stdout/stderr via console. */
  sink?: (level: LogLevel, line: string) => void;
  now?: () => string;
};

/** Below this length a "secret" is too generic to search for safely. */
export const MIN_REDACTABLE_SECRET_LENGTH = 8;

const ADDRESS_PATTERN = /\b0x[0-9a-fA-F]{40}\b/g;
/**
 * A long hex run, which is what an API key looks like. The lookahead requires
 * at least one a-f digit so that long decimal numbers — base-unit balances —
 * are not mistaken for credentials.
 */
const HEX_KEYLIKE_PATTERN = /\b(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{32,}\b/g;

export function createLogger(options: LoggerOptions): Logger {
  const secrets = options.secrets ?? [];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date().toISOString());

  function emit(level: LogLevel, event: string, bindings: LogFields, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[options.level]) {
      return;
    }
    const record = { time: now(), level, event, ...bindings, ...normalizeFields(fields) };
    sink(level, redact(safeStringify(record), secrets));
  }

  function build(bindings: LogFields): Logger {
    return {
      debug: (event, fields) => emit('debug', event, bindings, fields),
      info: (event, fields) => emit('info', event, bindings, fields),
      warn: (event, fields) => emit('warn', event, bindings, fields),
      error: (event, fields) => emit('error', event, bindings, fields),
      child: (extra) => build({ ...bindings, ...normalizeFields(extra) }),
    };
  }

  return build({});
}

/**
 * Applies every redaction rule to an already-serialised line.
 *
 * Order matters: literal secrets first (they may be short enough to survive the
 * generic hex rule), then addresses, then any remaining long hex run.
 *
 * Secrets shorter than {@link MIN_REDACTABLE_SECRET_LENGTH} are ignored. A
 * short value is indistinguishable from ordinary words, so scrubbing it would
 * shred unrelated log content — an empty or truncated credential in the
 * environment must not blank out every line.
 */
export function redact(line: string, secrets: readonly string[]): string {
  let output = line;
  for (const secret of secrets) {
    if (secret.length < MIN_REDACTABLE_SECRET_LENGTH) {
      continue;
    }
    output = output.split(secret).join('[redacted]');
  }
  output = output.replace(ADDRESS_PATTERN, (match) => `${match.slice(0, 6)}…${match.slice(-4)}`);
  return output.replace(HEX_KEYLIKE_PATTERN, '[redacted-hex]');
}

/**
 * Strips a URL down to origin plus path, dropping the query string entirely.
 * Provider keys live in query strings (`?apiKey=…`) and in path segments; the
 * path is kept because it identifies the endpoint, and the generic hex rule in
 * {@link redact} masks a key embedded in it.
 */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[unparseable-url]';
  }
}

/** Converts unknown thrown values into loggable fields, never a raw object. */
export function describeError(error: unknown): LogFields {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: error.message };
  }
  return { errorName: 'NonError', errorMessage: String(error) };
}

function normalizeFields(fields?: LogFields): LogFields {
  if (!fields) {
    return {};
  }
  const output: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    output[key] = value instanceof Error ? describeError(value) : value;
  }
  return output;
}

function safeStringify(record: unknown): string {
  try {
    return JSON.stringify(record, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  } catch {
    return JSON.stringify({ level: 'error', event: 'log.serialise_failed' });
  }
}

function defaultSink(level: LogLevel, line: string): void {
  if (level === 'error' || level === 'warn') {
    console.error(line);
    return;
  }
  console.log(line);
}
