import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createFileStore, type StoredCredentials } from '../auth/stdio/credential-store.js';
import { silentLogger } from '../logger.js';
import { type CliIo, droppedScopesNotice, runCommand } from './commands.js';

const ISSUER = 'http://localhost:8943';

const io = (env: NodeJS.ProcessEnv = {}): CliIo & { out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, env, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
};

const signedIn = (): { env: NodeJS.ProcessEnv; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'bsmcp-cli-'));
  return {
    dir,
    env: {
      BUGSECURE_API_URL: ISSUER,
      BUGSECURE_CREDENTIAL_STORE: 'file',
      BUGSECURE_CONFIG_DIR: dir,
      BUGSECURE_LOG_LEVEL: 'silent',
    },
  };
};

const payload = Buffer.from(JSON.stringify({ sub: 'user-42' })).toString('base64url');
const credentials: StoredCredentials = {
  version: 1,
  issuer: ISSUER,
  clientId: 'bugsecure-mcp-cli',
  resource: ISSUER,
  tokenEndpoint: `${ISSUER}/oauth/token`,
  accessToken: `h.${payload}.s`,
  accessTokenExpiresAt: 2_000_000_000,
  refreshToken: 'rt',
  scope: 'programs:read',
  obtainedAt: 1,
};

describe('CLI commands', () => {
  it('prints help and version to stdout', async () => {
    const h = io();
    expect(await runCommand({ kind: 'help' }, h)).toBe(0);
    expect(h.out.join('')).toContain('bugsecure-mcp login');
    const v = io();
    expect(await runCommand({ kind: 'version' }, v)).toBe(0);
    expect(v.out.join('')).toMatch(/^@kulinda-sec\/bugsecure-mcp \d+\.\d+\.\d+/);
  });

  it('whoami reports not signed in with exit code 1', async () => {
    const { env } = signedIn();
    const h = io(env);
    expect(await runCommand({ kind: 'whoami', common: {}, json: false }, h)).toBe(1);
    expect(h.err.join('')).toContain('Not signed in');
  });

  it('whoami shows the stored login, never the tokens', async () => {
    const { env, dir } = signedIn();
    await createFileStore(dir, silentLogger).save(credentials);

    const text = io(env);
    expect(await runCommand({ kind: 'whoami', common: {}, json: false }, text)).toBe(0);
    expect(text.out.join('')).toContain('user-42');
    expect(text.out.join('')).not.toContain(credentials.accessToken);

    const json = io(env);
    await runCommand({ kind: 'whoami', common: {}, json: true }, json);
    expect(JSON.parse(json.out.join(''))).toMatchObject({
      subject: 'user-42',
      scopes: ['programs:read'],
      refreshable: true,
    });
  });

  it('logout removes the stored login even without a revocation endpoint', async () => {
    const { env, dir } = signedIn();
    await createFileStore(dir, silentLogger).save(credentials);
    const h = io(env);
    expect(await runCommand({ kind: 'logout', common: {} }, h)).toBe(0);
    expect(h.err.join('')).toContain('Signed out locally');
    expect(await createFileStore(dir, silentLogger).load(ISSUER)).toBeUndefined();

    const again = io(env);
    await runCommand({ kind: 'logout', common: {} }, again);
    expect(again.err.join('')).toContain('Not signed in');
  });

  it('refuses to start hosted mode without a client secret', async () => {
    await expect(runCommand({ kind: 'http', common: {} }, io({}))).rejects.toThrow(/client secret/);
  });
});

describe('droppedScopesNotice', () => {
  it('says nothing when everything asked for was granted', () => {
    expect(droppedScopesNotice(['programs:read'], new Set(['programs:read']))).toBe('');
  });

  it('names what was not granted, and explains organisation-side eligibility', () => {
    const notice = droppedScopesNotice(
      ['programs:read', 'reports:write', 'grade:write'],
      new Set(['programs:read']),
    );
    expect(notice).toContain('Not granted: reports:write, grade:write');
    expect(notice).toContain('only where the Administrator also enabled "AI grading"');
    expect(droppedScopesNotice(['reports:write'], new Set())).not.toContain('AI grading');
  });
});
