/**
 * A deliberately small structured logger.
 *
 * - Writes to **stderr only**. On the stdio transport stdout is the JSON-RPC
 *   channel; a single stray byte there corrupts the session.
 * - One JSON object per line, so hosted deployments can ship logs as-is.
 * - Never logs secrets or user content: callers pass *metadata* (ids, counts,
 *   status codes), and every field whose name looks sensitive is replaced with
 *   `[redacted]` regardless of what the caller passed. Errors are reduced to
 *   their name and machine code (never their message). Values are also length
 *   capped so an unexpected blob cannot flood the log.
 */

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Field names that must never reach a log line, whatever their value. Matching
 * is on the normalised key (lower-case, separators removed), so `access_token`,
 * `accessToken` and `Access-Token` are all caught.
 */
const SENSITIVE_SUFFIXES = [
  'token',
  'secret',
  'password',
  'passwd',
  'verifier',
  'challenge',
  'credential',
  'credentials',
  'apikey',
  'privatekey',
  'assertion',
];
const SENSITIVE_EXACT = new Set([
  // OAuth protocol values
  'code',
  'authorizationcode',
  'state',
  'authorization',
  'cookie',
  'setcookie',
  // user-authored content (reports, comments, appeals, grades, programme text)
  'body',
  'content',
  'description',
  'comment',
  'text',
  'rules',
  'prompt',
  'arguments',
  'variables',
  'title',
  'impact',
  'remediation',
  'stepstoreproduce',
  'grounds',
  'reasoning',
  'reason',
  'deviationreason',
  'amountreason',
  'decision',
  'message',
  'errordescription',
  'query',
]);

const isSensitiveKey = (key: string): boolean => {
  const normalised = key.toLowerCase().replace(/[^a-z]/g, '');
  return SENSITIVE_EXACT.has(normalised) || SENSITIVE_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
};

const MAX_STRING = 200;
const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

const errorSummary = (error: Error): Record<string, string> => {
  const { code, error: oauthError } = error as { code?: unknown; error?: unknown };
  const machine = [code, oauthError].find((c): c is string => typeof c === 'string' && SAFE_CODE.test(c));
  return machine === undefined ? { name: error.name } : { name: error.name, code: machine };
};
const MAX_DEPTH = 4;

const sanitize = (value: unknown, depth: number): unknown => {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'bigint') return value.toString();
  // Name and machine code only: an error message can quote a token, a URL with a
  // code in it, or text a user wrote (an API refusal repeating a report title).
  if (value instanceof Error) return errorSummary(value);
  if (value instanceof URL) return `${value.origin}${value.pathname}`; // never log query strings
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') return redact(value as Record<string, unknown>, depth + 1);
  return typeof value;
};

export const redact = (fields: Readonly<Record<string, unknown>>, depth = 0): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = isSensitiveKey(key) ? '[redacted]' : sanitize(value, depth);
  }
  return out;
};

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Defaults to process.stderr. Injected by tests. */
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

export const createLogger = (options: LoggerOptions, bound: LogFields = {}): Logger => {
  const threshold = SEVERITY[options.level];
  const write = options.write ?? ((line: string) => process.stderr.write(line));
  const now = options.now ?? (() => new Date());

  const emit = (level: Exclude<LogLevel, 'silent'>, message: string, fields?: LogFields): void => {
    if (SEVERITY[level] < threshold) return;
    const record = { time: now().toISOString(), level, msg: message, ...redact({ ...bound, ...fields }) };
    write(`${JSON.stringify(record)}\n`);
  };

  return {
    debug: (m, f) => {
      emit('debug', m, f);
    },
    info: (m, f) => {
      emit('info', m, f);
    },
    warn: (m, f) => {
      emit('warn', m, f);
    },
    error: (m, f) => {
      emit('error', m, f);
    },
    child: (fields) => createLogger(options, { ...bound, ...fields }),
  };
};

/** A logger that drops everything; the default for library use and tests. */
export const silentLogger: Logger = createLogger({ level: 'silent' });
