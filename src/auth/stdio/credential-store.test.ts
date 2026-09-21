import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createLogger, silentLogger } from '../../logger.js';
import {
  createCredentialStore,
  createFileStore,
  createKeychainStore,
  defaultConfigDir,
  KEYCHAIN_SERVICE,
  type KeyringEntry,
  type KeyringFactory,
  type StoredCredentials,
} from './credential-store.js';

const creds = (issuer = 'https://as.test', accessToken = 'at'): StoredCredentials => ({
  version: 1,
  issuer,
  clientId: 'bugsecure-mcp-cli',
  resource: issuer,
  tokenEndpoint: `${issuer}/oauth/token`,
  accessToken,
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'rt',
  scope: 'programs:read',
  obtainedAt: 1_000,
});

const tmp = (): string => mkdtempSync(join(tmpdir(), 'bsmcp-store-'));
const posix = process.platform !== 'win32';

const fakeKeyring = (
  options: { failProbe?: boolean } = {},
): KeyringFactory & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  const factory = ((service: string, account: string): KeyringEntry => ({
    getPassword: () => {
      if (options.failProbe) return Promise.reject(new Error('no secret service'));
      return Promise.resolve(data.get(`${service}/${account}`));
    },
    setPassword: (p) => {
      data.set(`${service}/${account}`, p);
      return Promise.resolve();
    },
    deletePassword: () => Promise.resolve(data.delete(`${service}/${account}`)),
  })) as KeyringFactory & { data: Map<string, string> };
  factory.data = data;
  return factory;
};

describe('file credential store', () => {
  it('round-trips credentials keyed by issuer', async () => {
    const store = createFileStore(tmp(), silentLogger);
    await store.save(creds('https://a.test', 'A'));
    await store.save(creds('https://b.test', 'B'));
    expect((await store.load('https://a.test'))?.accessToken).toBe('A');
    expect((await store.load('https://b.test'))?.accessToken).toBe('B');
    expect(await store.load('https://c.test')).toBeUndefined();
    expect(await store.delete('https://a.test')).toBe(true);
    expect(await store.delete('https://a.test')).toBe(false);
    expect(await store.load('https://b.test')).toBeDefined();
  });

  it.runIf(posix)('creates the file 0600 inside a 0700 directory, atomically', async () => {
    const dir = join(tmp(), 'nested');
    const store = createFileStore(dir, silentLogger);
    await store.save(creds());
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['credentials.json']); // no temp files left behind
  });

  it.runIf(posix)('tightens permissions on a world-readable file and warns', async () => {
    const dir = tmp();
    const store = createFileStore(dir, silentLogger);
    await store.save(creds());
    chmodSync(join(dir, 'credentials.json'), 0o644);
    const lines: string[] = [];
    const warned = createFileStore(dir, createLogger({ level: 'warn', write: (l) => lines.push(l) }));
    expect(await warned.load('https://as.test')).toBeDefined();
    expect(statSync(join(dir, 'credentials.json')).mode & 0o777).toBe(0o600);
    expect(lines.join('')).toContain('readable by other users');
  });

  it('ignores corrupt files and entries', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'credentials.json'), '{nope', { mode: 0o600 });
    const store = createFileStore(dir, silentLogger);
    expect(await store.load('https://as.test')).toBeUndefined();
    writeFileSync(
      join(dir, 'credentials.json'),
      JSON.stringify({ version: 1, entries: { 'https://as.test': { bogus: true } } }),
      { mode: 0o600 },
    );
    expect(await store.load('https://as.test')).toBeUndefined();
  });

  it('never writes tokens anywhere but the credentials file', async () => {
    const dir = tmp();
    await createFileStore(dir, silentLogger).save(creds());
    expect(readFileSync(join(dir, 'credentials.json'), 'utf8')).toContain('"accessToken": "at"');
  });
});

describe('keychain credential store', () => {
  it('stores one JSON entry per issuer under the service name', async () => {
    const keyring = fakeKeyring();
    const store = createKeychainStore(keyring);
    await store.save(creds());
    expect([...keyring.data.keys()]).toEqual([`${KEYCHAIN_SERVICE}/https://as.test`]);
    expect((await store.load('https://as.test'))?.refreshToken).toBe('rt');
    expect(await store.delete('https://as.test')).toBe(true);
    expect(await store.load('https://as.test')).toBeUndefined();
  });
});

describe('createCredentialStore', () => {
  it('prefers the keychain when it works', async () => {
    const store = await createCredentialStore({
      preference: 'auto',
      configDir: tmp(),
      logger: silentLogger,
      keyring: fakeKeyring(),
    });
    expect(store.kind).toBe('keychain');
  });

  it('falls back to the 0600 file with a warning when no keychain backend exists', async () => {
    const lines: string[] = [];
    const store = await createCredentialStore({
      preference: 'auto',
      configDir: tmp(),
      logger: createLogger({ level: 'warn', write: (l) => lines.push(l) }),
      keyring: fakeKeyring({ failProbe: true }),
    });
    expect(store.kind).toBe('file');
    expect(lines.join('')).toContain('No OS keychain available');
  });

  it('honours explicit preferences', async () => {
    const dir = tmp();
    expect(
      (await createCredentialStore({ preference: 'file', configDir: dir, logger: silentLogger })).kind,
    ).toBe('file');
    await expect(
      createCredentialStore({
        preference: 'keychain',
        configDir: dir,
        logger: silentLogger,
        keyring: fakeKeyring({ failProbe: true }),
      }),
    ).rejects.toThrow('no secret service');
  });

  it('uses per-platform config directories', () => {
    expect(defaultConfigDir({ XDG_CONFIG_HOME: '/x' }, 'linux')).toBe(join('/x', 'bugsecure-mcp'));
    expect(defaultConfigDir({ APPDATA: 'C:\\A' }, 'win32')).toContain('bugsecure-mcp');
    expect(defaultConfigDir({}, 'darwin')).toContain(join('Library', 'Application Support', 'bugsecure-mcp'));
  });
});
