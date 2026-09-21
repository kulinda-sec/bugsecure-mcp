import { describe, expect, it } from 'vitest';

import { parseCommandLine, parseScopes, UsageError } from './args.js';

describe('command line', () => {
  it('defaults to the stdio server', () => {
    expect(parseCommandLine([])).toEqual({ kind: 'stdio', common: {} });
    expect(parseCommandLine(['--read-only', '--api-url', 'https://x.test'])).toEqual({
      kind: 'stdio',
      common: { readOnly: true, apiUrl: 'https://x.test' },
    });
  });

  it('parses serve --http', () => {
    expect(
      parseCommandLine(['serve', '--http', '--port', '9000', '--host', '0.0.0.0', '--log-level', 'debug']),
    ).toEqual({
      kind: 'http',
      common: { logLevel: 'debug' },
      host: '0.0.0.0',
      port: 9000,
    });
  });

  it('parses login with scopes', () => {
    expect(
      parseCommandLine(['login', '--scopes', 'programs:read, reports:write reports:write', '--no-browser']),
    ).toEqual({
      kind: 'login',
      common: {},
      scopes: ['programs:read', 'reports:write'],
      openBrowser: false,
    });
    const defaults = parseCommandLine(['login']);
    expect(defaults).toMatchObject({ kind: 'login', openBrowser: true });
    // By default: the read scopes and reports:write; the other write scopes only when asked for.
    expect(defaults.kind === 'login' ? defaults.scopes : []).toEqual([
      'programs:read',
      'profile:read',
      'reports:read',
      'triage:read',
      'reports:write',
    ]);
  });

  it('parses logout, whoami, help and version', () => {
    expect(parseCommandLine(['logout'])).toEqual({ kind: 'logout', common: {} });
    expect(parseCommandLine(['whoami', '--json'])).toEqual({ kind: 'whoami', common: {}, json: true });
    expect(parseCommandLine(['--help'])).toEqual({ kind: 'help' });
    expect(parseCommandLine(['login', '-h'])).toEqual({ kind: 'help' });
    expect(parseCommandLine(['-v'])).toEqual({ kind: 'version' });
  });

  it.each([
    [['frobnicate']],
    [['login', 'extra']],
    [['--nope']],
    [['--scopes', 'programs:read']],
    [['whoami', '--http']],
    [['serve', '--port', '80']],
    [['serve']],
    [['serve', '--http', '--port', 'eighty']],
    [['--log-level', 'loud']],
    [['login', '--scopes', 'admin']],
    [['login', '--scopes', ' , ']],
  ])('rejects %j', (argv) => {
    expect(() => parseCommandLine(argv)).toThrow(UsageError);
  });

  it('parses scope lists', () => {
    expect(parseScopes('programs:read,profile:read')).toEqual(['programs:read', 'profile:read']);
  });
});
