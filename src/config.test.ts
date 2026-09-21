import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalUrl, ConfigError, loadHostedConfig, loadLocalConfig } from './config.js';
import { formatScopes, parseScopeString } from './scopes.js';

describe('canonicalUrl', () => {
  it('normalises and strips trailing slashes', () => {
    expect(canonicalUrl('https://API.example.com/', 'x')).toBe('https://api.example.com');
    expect(canonicalUrl('https://h.example/mcp/', 'x')).toBe('https://h.example/mcp');
  });

  it.each([
    'http://api.example.com',
    'ftp://h',
    'not a url',
    'https://user:pw@h.example',
    'https://h.example/?a=1',
    'https://h.example/#f',
  ])('rejects %s', (url) => {
    expect(() => canonicalUrl(url, 'x')).toThrow(ConfigError);
  });

  it('allows plain http on loopback only', () => {
    expect(canonicalUrl('http://localhost:8943', 'x')).toBe('http://localhost:8943');
    expect(canonicalUrl('http://127.0.0.1:8943', 'x')).toBe('http://127.0.0.1:8943');
  });
});

describe('loadLocalConfig', () => {
  it('defaults to production', () => {
    const c = loadLocalConfig({});
    expect(c.apiUrl).toBe('https://bugsecure-api.senintel.sn');
    expect(c.graphqlUrl).toBe('https://bugsecure-api.senintel.sn/graphql');
    expect(c.issuer).toBe(c.apiUrl);
    expect(c.readOnly).toBe(false);
    expect(c.clientId).toBe('bugsecure-mcp-cli');
  });

  it('lets flags override the environment', () => {
    const c = loadLocalConfig(
      { BUGSECURE_API_URL: 'http://localhost:8943', BUGSECURE_READ_ONLY: 'false' },
      { apiUrl: 'https://staging.example', readOnly: true },
    );
    expect(c.apiUrl).toBe('https://staging.example');
    expect(c.readOnly).toBe(true);
  });

  it('parses booleans strictly', () => {
    expect(loadLocalConfig({ BUGSECURE_READ_ONLY: 'yes' }).readOnly).toBe(true);
    expect(() => loadLocalConfig({ BUGSECURE_READ_ONLY: 'maybe' })).toThrow(ConfigError);
  });
});

describe('loadHostedConfig', () => {
  const KEY = 'k'.repeat(44);
  const base = { BUGSECURE_CLIENT_SECRET: 's3cret', BUGSECURE_MCP_APPROVAL_KEY: KEY };

  it('requires a client secret', () => {
    expect(() => loadHostedConfig({})).toThrow(/client secret/);
  });

  it('reads the secret from a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bsmcp-'));
    const file = join(dir, 'secret');
    writeFileSync(file, 'from-file\n');
    const key = { BUGSECURE_MCP_APPROVAL_KEY: KEY };
    expect(loadHostedConfig({ BUGSECURE_CLIENT_SECRET_FILE: file, ...key }).clientSecret).toBe('from-file');
    expect(() => loadHostedConfig({ BUGSECURE_CLIENT_SECRET_FILE: file, ...base })).toThrow(/only one/);
    expect(() => loadHostedConfig({ BUGSECURE_CLIENT_SECRET_FILE: join(dir, 'missing'), ...key })).toThrow(
      ConfigError,
    );
    writeFileSync(join(dir, 'empty'), '\n');
    expect(() => loadHostedConfig({ BUGSECURE_CLIENT_SECRET_FILE: join(dir, 'empty'), ...key })).toThrow(
      /empty/,
    );
  });

  it('needs a dedicated approval key in production, from the environment or a file', () => {
    expect(() => loadHostedConfig({ BUGSECURE_CLIENT_SECRET: 's3cret' })).toThrow(
      /BUGSECURE_MCP_APPROVAL_KEY/,
    );
    expect(() => loadHostedConfig({ ...base, BUGSECURE_MCP_APPROVAL_KEY: 'short' })).toThrow(/at least 32/);
    expect(loadHostedConfig(base).approvalKey).toBe(KEY);
    const dir = mkdtempSync(join(tmpdir(), 'bsmcp-'));
    writeFileSync(join(dir, 'key'), `${KEY}\n`);
    expect(
      loadHostedConfig({ BUGSECURE_CLIENT_SECRET: 's', BUGSECURE_MCP_APPROVAL_KEY_FILE: join(dir, 'key') })
        .approvalKey,
    ).toBe(KEY);
  });

  it('lets a development server on localhost run without an approval key (derived from the secret)', () => {
    const c = loadHostedConfig({
      BUGSECURE_CLIENT_SECRET: 's3cret',
      BUGSECURE_MCP_RESOURCE: 'http://localhost:8944/mcp',
      BUGSECURE_API_URL: 'http://localhost:8943',
    });
    expect(c.approvalKey).not.toBe('s3cret');
    expect(c.approvalKey).toContain('s3cret');
    expect(c.allowedHosts).toEqual(['localhost', 'localhost', '127.0.0.1', '[::1]']);
  });

  it('has safe defaults', () => {
    const c = loadHostedConfig(base);
    expect(c.resource).toBe('https://bugsecure-mcp.senintel.sn/mcp');
    expect(c.host).toBe('127.0.0.1');
    expect(c.port).toBe(8944);
    expect(c.allowedOrigins).toEqual([]);
    // Production: the resource's host only — never loopback names (DNS rebinding from the host).
    expect(c.allowedHosts).toEqual(['bugsecure-mcp.senintel.sn']);
    expect(c.jwksUrl).toBeUndefined();
    expect(c.maxBodyBytes).toBe(1024 * 1024);
    expect(c.rateLimit).toEqual({
      perMinute: 60,
      burst: 20,
      writesPerMinute: 12,
      writeBurst: 6,
      maxKeys: 10_000,
    });
  });

  it('refuses a resource equal to the API (audience confusion)', () => {
    expect(() =>
      loadHostedConfig({ ...base, BUGSECURE_MCP_RESOURCE: 'https://bugsecure-api.senintel.sn' }),
    ).toThrow(/must differ/);
  });

  it('parses lists and numbers', () => {
    const c = loadHostedConfig({
      ...base,
      BUGSECURE_ALLOWED_ORIGINS:
        'App.Example.com, other.example, http://localhost:3000, https://x.example:8443',
      BUGSECURE_ALLOWED_HOSTS: 'mcp.example',
      PORT: '9000',
    });
    // Bare hostnames mean https on the default port; full origins keep their scheme and port.
    expect(c.allowedOrigins).toEqual([
      'https://app.example.com',
      'https://other.example',
      'http://localhost:3000',
      'https://x.example:8443',
    ]);
    expect(() => loadHostedConfig({ ...base, BUGSECURE_ALLOWED_ORIGINS: 'https://a.example/path' })).toThrow(
      /not an origin/,
    );
    expect(() => loadHostedConfig({ ...base, BUGSECURE_ALLOWED_ORIGINS: 'http://[' })).toThrow(
      /not an origin/,
    );
    expect(c.allowedHosts).toEqual(['mcp.example']);
    expect(c.port).toBe(9000);
    expect(() => loadHostedConfig({ ...base, PORT: '70000' })).toThrow(ConfigError);
  });
});

describe('scopes', () => {
  it('drops unknown scopes and formats canonically', () => {
    const parsed = parseScopeString('reports:read  admin programs:read');
    expect([...parsed].sort()).toEqual(['programs:read', 'reports:read']);
    expect(formatScopes(parsed)).toBe('programs:read reports:read');
    expect(parseScopeString(undefined).size).toBe(0);
  });
});
