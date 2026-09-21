/**
 * Configuration: environment variables, overridden by CLI flags, validated with
 * zod. Invalid configuration fails fast at startup with a readable message
 * instead of surfacing later as a confusing network error.
 */
import { readFileSync } from 'node:fs';

import * as z from 'zod';

import { LOOPBACK_HOSTS } from './http.js';
import { LOG_LEVELS, type LogLevel } from './logger.js';

export const DEFAULT_API_URL = 'https://bugsecure-api.senintel.sn';
export const DEFAULT_MCP_RESOURCE = 'https://bugsecure-mcp.senintel.sn/mcp';
export const LOCAL_CLIENT_ID = 'bugsecure-mcp-cli';
export const HOSTED_CLIENT_ID = 'bugsecure-mcp-hosted';

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * A base URL we are willing to send credentials to: `https:`, or plain `http:`
 * only for loopback development. No userinfo, query or fragment. Returned
 * without a trailing slash, the canonical form RFC 8707 / RFC 9728 prefer.
 */
export const canonicalUrl = (raw: string, what: string): string => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${what} is not a valid URL: ${JSON.stringify(raw)}`);
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new ConfigError(`${what} must use https (plain http is only allowed for localhost): ${url.origin}`);
  }
  if (url.username !== '' || url.password !== '')
    throw new ConfigError(`${what} must not contain credentials`);
  if (url.search !== '' || url.hash !== '')
    throw new ConfigError(`${what} must not contain a query or fragment`);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
};

const boolish = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off', ''])
  .transform((v) => ['1', 'true', 'yes', 'on'].includes(v));

const Env = z.object({
  BUGSECURE_API_URL: z.string().optional(),
  BUGSECURE_ISSUER: z.string().optional(),
  BUGSECURE_READ_ONLY: boolish.optional(),
  BUGSECURE_LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  BUGSECURE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).optional(),
  // stdio / local
  BUGSECURE_CREDENTIAL_STORE: z.enum(['auto', 'keychain', 'file']).optional(),
  BUGSECURE_CONFIG_DIR: z.string().min(1).optional(),
  // hosted
  BUGSECURE_MCP_RESOURCE: z.string().optional(),
  BUGSECURE_CLIENT_ID: z.string().min(1).optional(),
  BUGSECURE_CLIENT_SECRET: z.string().min(1).optional(),
  BUGSECURE_CLIENT_SECRET_FILE: z.string().min(1).optional(),
  BUGSECURE_MCP_APPROVAL_KEY: z.string().min(1).optional(),
  BUGSECURE_MCP_APPROVAL_KEY_FILE: z.string().min(1).optional(),
  BUGSECURE_JWKS_URL: z.string().optional(),
  BUGSECURE_ALLOWED_ORIGINS: z.string().optional(),
  BUGSECURE_ALLOWED_HOSTS: z.string().optional(),
  BUGSECURE_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(10 * 1024 * 1024)
    .optional(),
  BUGSECURE_TOKEN_CACHE_SIZE: z.coerce.number().int().min(1).max(100_000).optional(),
  BUGSECURE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).optional(),
  BUGSECURE_RATE_LIMIT_BURST: z.coerce.number().int().min(1).max(100_000).optional(),
  BUGSECURE_RATE_LIMIT_MAX_KEYS: z.coerce.number().int().min(100).max(1_000_000).optional(),
  BUGSECURE_RATE_LIMIT_WRITES_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).optional(),
  BUGSECURE_RATE_LIMIT_WRITE_BURST: z.coerce.number().int().min(1).max(10_000).optional(),
  HOST: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(0).max(65_535).optional(),
});
type Env = z.infer<typeof Env>;

/** Flags that override environment variables (all optional). */
export interface ConfigFlags {
  readonly apiUrl?: string | undefined;
  readonly readOnly?: boolean | undefined;
  readonly logLevel?: LogLevel | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
}

export interface CommonConfig {
  /** API base URL, canonical (no trailing slash). Also the OAuth resource for API tokens. */
  readonly apiUrl: string;
  readonly graphqlUrl: string;
  /** OAuth issuer identifier (RFC 8414). Defaults to the API URL. */
  readonly issuer: string;
  readonly readOnly: boolean;
  readonly logLevel: LogLevel;
  readonly requestTimeoutMs: number;
}

export interface LocalConfig extends CommonConfig {
  readonly mode: 'local';
  readonly clientId: string;
  readonly credentialStore: 'auto' | 'keychain' | 'file';
  readonly configDir: string | undefined;
}

export interface HostedConfig extends CommonConfig {
  readonly mode: 'hosted';
  /** This server's canonical resource identifier (RFC 8707), e.g. https://mcp.example/mcp. */
  readonly resource: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Secret for sealing approval `requestState` (≥ 32 characters), shared by
   * every instance. Dedicated, so rotating the client secret and this key are
   * independent, and neither leaks the other.
   */
  readonly approvalKey: string;
  /** Explicit JWKS URL; otherwise `jwks_uri` from the AS metadata. */
  readonly jwksUrl: string | undefined;
  /**
   * Browser origins (scheme, host and port, e.g. `https://app.example`) allowed
   * in an `Origin` header. Empty = reject every browser origin.
   */
  readonly allowedOrigins: readonly string[];
  /** Hostnames allowed in the `Host` header (DNS-rebinding defence). */
  readonly allowedHosts: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly tokenCacheSize: number;
  /**
   * Tool invocations: per (user, client) `perMinute`/`burst`; per user across
   * all their clients, twice that; write tools additionally per user
   * `writesPerMinute`/`writeBurst` (an approved write takes two calls).
   * `maxKeys` bounds how many keys each limiter tracks.
   */
  readonly rateLimit: {
    readonly perMinute: number;
    readonly burst: number;
    readonly writesPerMinute: number;
    readonly writeBurst: number;
    readonly maxKeys: number;
  };
}

const parseEnv = (env: NodeJS.ProcessEnv): Env => {
  const result = Env.safeParse(env);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new ConfigError(`Invalid environment:\n${issues}`);
  }
  return result.data;
};

const common = (env: Env, flags: ConfigFlags): CommonConfig => {
  const apiUrl = canonicalUrl(flags.apiUrl ?? env.BUGSECURE_API_URL ?? DEFAULT_API_URL, 'API URL');
  return {
    apiUrl,
    graphqlUrl: `${apiUrl}/graphql`,
    issuer: canonicalUrl(env.BUGSECURE_ISSUER ?? apiUrl, 'BUGSECURE_ISSUER'),
    readOnly: flags.readOnly ?? env.BUGSECURE_READ_ONLY ?? false,
    logLevel: flags.logLevel ?? env.BUGSECURE_LOG_LEVEL ?? 'info',
    requestTimeoutMs: env.BUGSECURE_REQUEST_TIMEOUT_MS ?? 20_000,
  };
};

export const loadLocalConfig = (
  env: NodeJS.ProcessEnv = process.env,
  flags: ConfigFlags = {},
): LocalConfig => {
  const e = parseEnv(env);
  return {
    ...common(e, flags),
    mode: 'local',
    clientId: LOCAL_CLIENT_ID,
    credentialStore: e.BUGSECURE_CREDENTIAL_STORE ?? 'auto',
    configDir: e.BUGSECURE_CONFIG_DIR,
  };
};

const list = (value: string | undefined): string[] => {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== '');
};

/** A secret from `NAME` or the file named by `NAME_FILE` (not both); undefined when neither is set. */
const readOptionalSecret = (
  name: string,
  value: string | undefined,
  file: string | undefined,
): string | undefined => {
  if (value !== undefined && file !== undefined) {
    throw new ConfigError(`Set only one of ${name} and ${name}_FILE`);
  }
  if (file !== undefined) {
    let secret: string;
    try {
      secret = readFileSync(file, 'utf8').trim();
    } catch (cause) {
      throw new ConfigError(`Cannot read ${name}_FILE`, { cause });
    }
    if (secret === '') throw new ConfigError(`${name}_FILE is empty`);
    return secret;
  }
  return value;
};

/**
 * `BUGSECURE_ALLOWED_ORIGINS` entries as origins: a full origin
 * (`https://app.example:8443`) is kept as one; a bare hostname means that
 * host over https on the default port.
 */
const parseOrigins = (value: string | undefined): string[] => {
  return list(value).map((entry) => {
    const raw = entry.includes('://') ? entry : `https://${entry}`;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ConfigError(`BUGSECURE_ALLOWED_ORIGINS: not an origin or hostname: ${JSON.stringify(entry)}`);
    }
    if (url.origin === 'null' || url.pathname !== '/' || url.search !== '' || url.username !== '') {
      throw new ConfigError(`BUGSECURE_ALLOWED_ORIGINS: not an origin or hostname: ${JSON.stringify(entry)}`);
    }
    return url.origin;
  });
};

const readSecret = (e: Env): string => {
  const secret = readOptionalSecret(
    'BUGSECURE_CLIENT_SECRET',
    e.BUGSECURE_CLIENT_SECRET,
    e.BUGSECURE_CLIENT_SECRET_FILE,
  );
  if (secret !== undefined) return secret;
  throw new ConfigError(
    'Hosted mode needs the confidential client secret: set BUGSECURE_CLIENT_SECRET_FILE (preferred) or BUGSECURE_CLIENT_SECRET',
  );
};

/** Characters the approval key must have at least (32 random bytes, base64 ≈ 44). */
export const MIN_APPROVAL_KEY_LENGTH = 32;

/**
 * The approval-sealing key. Required in production; a development server on a
 * loopback resource (http://localhost…) falls back to one derived from the
 * client secret, so trying the hosted mode locally needs no extra setup.
 */
const readApprovalKey = (e: Env, clientSecret: string, development: boolean): string => {
  const key = readOptionalSecret(
    'BUGSECURE_MCP_APPROVAL_KEY',
    e.BUGSECURE_MCP_APPROVAL_KEY,
    e.BUGSECURE_MCP_APPROVAL_KEY_FILE,
  );
  if (key !== undefined) {
    if (key.length < MIN_APPROVAL_KEY_LENGTH) {
      throw new ConfigError(
        `BUGSECURE_MCP_APPROVAL_KEY must be at least ${String(MIN_APPROVAL_KEY_LENGTH)} characters (e.g. \`openssl rand -base64 32\`)`,
      );
    }
    return key;
  }
  if (development) return `dev-approval-key:${clientSecret}`;
  throw new ConfigError(
    'Hosted mode needs a dedicated approval key, shared by every instance: set BUGSECURE_MCP_APPROVAL_KEY_FILE or ' +
      'BUGSECURE_MCP_APPROVAL_KEY (at least 32 random characters, e.g. `openssl rand -base64 32`). It seals the ' +
      'approval prompts of write tools; only a development server on a localhost resource may run without it.',
  );
};

export const loadHostedConfig = (
  env: NodeJS.ProcessEnv = process.env,
  flags: ConfigFlags = {},
): HostedConfig => {
  const e = parseEnv(env);
  const base = common(e, flags);
  const resource = canonicalUrl(e.BUGSECURE_MCP_RESOURCE ?? DEFAULT_MCP_RESOURCE, 'BUGSECURE_MCP_RESOURCE');
  if (resource === base.apiUrl) {
    throw new ConfigError('BUGSECURE_MCP_RESOURCE must differ from the API URL (tokens are audience-bound)');
  }
  const resourceHost = new URL(resource).hostname;
  // A resource on this machine is a development server; anything else is production.
  const development = LOOPBACK_HOSTS.has(resourceHost);
  const host = flags.host ?? e.HOST ?? '127.0.0.1';
  const allowedHosts = list(e.BUGSECURE_ALLOWED_HOSTS);
  const clientSecret = readSecret(e);
  return {
    ...base,
    mode: 'hosted',
    resource,
    clientId: e.BUGSECURE_CLIENT_ID ?? HOSTED_CLIENT_ID,
    clientSecret,
    approvalKey: readApprovalKey(e, clientSecret, development),
    jwksUrl:
      e.BUGSECURE_JWKS_URL === undefined
        ? undefined
        : canonicalUrl(e.BUGSECURE_JWKS_URL, 'BUGSECURE_JWKS_URL'),
    allowedOrigins: parseOrigins(e.BUGSECURE_ALLOWED_ORIGINS),
    // Loopback names are allowed by default only for a development server: in
    // production they would let a DNS-rebound page on the host reach /mcp.
    allowedHosts:
      allowedHosts.length > 0
        ? allowedHosts
        : development
          ? [resourceHost, ...LOOPBACK_HOSTS]
          : [resourceHost],
    host,
    port: flags.port ?? e.PORT ?? 8944,
    // 1 MiB: the largest approvable write (MAX_APPROVAL_CHARACTERS, 50,000 characters) is at most
    // ~600 KB as JSON even when every character is non-ASCII and the client escapes it as \\uXXXX,
    // plus the approval round's own fields.
    maxBodyBytes: e.BUGSECURE_MAX_BODY_BYTES ?? 1024 * 1024,
    tokenCacheSize: e.BUGSECURE_TOKEN_CACHE_SIZE ?? 1_000,
    rateLimit: {
      perMinute: e.BUGSECURE_RATE_LIMIT_PER_MINUTE ?? 60,
      burst: e.BUGSECURE_RATE_LIMIT_BURST ?? 20,
      writesPerMinute: e.BUGSECURE_RATE_LIMIT_WRITES_PER_MINUTE ?? 12,
      writeBurst: e.BUGSECURE_RATE_LIMIT_WRITE_BURST ?? 6,
      maxKeys: e.BUGSECURE_RATE_LIMIT_MAX_KEYS ?? 10_000,
    },
  };
};
