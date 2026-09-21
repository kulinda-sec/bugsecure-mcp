import { parseArgs } from 'node:util';

import { LOG_LEVELS, type LogLevel } from '../logger.js';
import { DEFAULT_LOGIN_SCOPES, isScope, SCOPES, type Scope } from '../scopes.js';

export type Command =
  | { readonly kind: 'stdio'; readonly common: CommonFlags }
  | { readonly kind: 'http'; readonly common: CommonFlags; readonly host?: string; readonly port?: number }
  | {
      readonly kind: 'login';
      readonly common: CommonFlags;
      readonly scopes: readonly Scope[];
      readonly openBrowser: boolean;
    }
  | { readonly kind: 'logout'; readonly common: CommonFlags }
  | { readonly kind: 'whoami'; readonly common: CommonFlags; readonly json: boolean }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' };

export interface CommonFlags {
  readonly apiUrl?: string;
  readonly readOnly?: boolean;
  readonly logLevel?: LogLevel;
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

export const HELP = `bugsecure-mcp — Model Context Protocol server for BugSecure

Usage:
  bugsecure-mcp [options]                 Run the MCP server on stdio (what MCP clients launch)
  bugsecure-mcp login [--scopes <list>]   Sign in with your browser and store the tokens in the OS keychain
  bugsecure-mcp logout                    Revoke the stored login and delete it
  bugsecure-mcp whoami [--json]           Show the stored login (account, scopes, expiry)
  bugsecure-mcp serve --http              Run the hosted Streamable HTTP server (OAuth resource server)

Options:
  --api-url <url>      BugSecure API (default https://bugsecure-api.senintel.sn; env BUGSECURE_API_URL)
  --read-only          Never expose tools that change anything (env BUGSECURE_READ_ONLY=1)
  --log-level <level>  ${LOG_LEVELS.join('|')} (default info; logs go to stderr; env BUGSECURE_LOG_LEVEL)
  --scopes <list>      login: comma- or space-separated scopes (default: ${DEFAULT_LOGIN_SCOPES.join(',')})
  --no-browser         login: print the sign-in URL instead of opening a browser
  --host <addr>        serve --http: listen address (default 127.0.0.1; env HOST)
  --port <n>           serve --http: listen port (default 8944; env PORT)
  -h, --help           Show this help
  -v, --version        Show the version

Scopes: ${SCOPES.join(', ')}

Docs: https://github.com/kulinda-sec/bugsecure-mcp#readme
`;

export const parseScopes = (value: string): Scope[] => {
  const parts = value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const invalid = parts.filter((p) => !isScope(p));
  if (invalid.length > 0) {
    throw new UsageError(`Unknown scope(s): ${invalid.join(', ')}. Valid scopes: ${SCOPES.join(', ')}`);
  }
  if (parts.length === 0) throw new UsageError('--scopes needs at least one scope');
  return [...new Set(parts.filter(isScope))];
};

const parsePort = (value: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65_535) throw new UsageError(`Invalid --port: ${value}`);
  return n;
};

const parseLogLevel = (value: string): LogLevel => {
  const level = LOG_LEVELS.find((l) => l === value);
  if (level === undefined)
    throw new UsageError(`Invalid --log-level: ${value} (expected ${LOG_LEVELS.join('|')})`);
  return level;
};

export const parseCommandLine = (argv: readonly string[]): Command => {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        'api-url': { type: 'string' },
        'read-only': { type: 'boolean' },
        'log-level': { type: 'string' },
        scopes: { type: 'string' },
        'no-browser': { type: 'boolean' },
        http: { type: 'boolean' },
        host: { type: 'string' },
        port: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) return { kind: 'help' };
  if (values.version === true) return { kind: 'version' };

  const common: CommonFlags = {
    ...(values['api-url'] === undefined ? {} : { apiUrl: values['api-url'] }),
    ...(values['read-only'] === undefined ? {} : { readOnly: values['read-only'] }),
    ...(values['log-level'] === undefined ? {} : { logLevel: parseLogLevel(values['log-level']) }),
  };

  const [command, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(`Unexpected argument: ${rest.join(' ')}`);

  const only = (allowed: readonly string[], name: string): void => {
    const all = ['scopes', 'no-browser', 'http', 'host', 'port', 'json'] as const;
    for (const flag of all) {
      if (values[flag] !== undefined && !allowed.includes(flag)) {
        throw new UsageError(`--${flag} is not valid for ${name}`);
      }
    }
  };

  switch (command) {
    case undefined:
      only([], 'the stdio server');
      return { kind: 'stdio', common };
    case 'serve':
      only(['http', 'host', 'port'], 'serve');
      // `serve` alone is ambiguous (stdio is the default command): require the transport explicitly.
      if (values.http !== true) {
        throw new UsageError('serve needs --http (the stdio server is `bugsecure-mcp` with no command)');
      }
      return {
        kind: 'http',
        common,
        ...(values.host === undefined ? {} : { host: values.host }),
        ...(values.port === undefined ? {} : { port: parsePort(values.port) }),
      };
    case 'login':
      only(['scopes', 'no-browser'], 'login');
      return {
        kind: 'login',
        common,
        scopes: values.scopes === undefined ? DEFAULT_LOGIN_SCOPES : parseScopes(values.scopes),
        openBrowser: values['no-browser'] !== true,
      };
    case 'logout':
      only([], 'logout');
      return { kind: 'logout', common };
    case 'whoami':
      only(['json'], 'whoami');
      return { kind: 'whoami', common, json: values.json === true };
    default:
      throw new UsageError(`Unknown command: ${command}`);
  }
};
