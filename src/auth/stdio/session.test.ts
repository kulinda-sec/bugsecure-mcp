import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeAuthorizationServer, ISSUER } from '../../../test/helpers/fake-authorization-server.js';
import { memoryStore } from '../../../test/helpers/memory-store.js';
import { BugSecureError } from '../../errors.js';
import { silentLogger } from '../../logger.js';
import type { StoredCredentials } from './credential-store.js';
import { withFileLock } from './file-lock.js';
import {
  credentialsLockPath,
  decodeJwtPayload,
  LocalSession,
  logout,
  withCredentialsLock,
} from './session.js';

const NOW = 1_000_000; // seconds
const stored = (overrides: Partial<StoredCredentials> = {}): StoredCredentials => ({
  version: 1,
  issuer: ISSUER,
  clientId: 'bugsecure-mcp-cli',
  resource: ISSUER,
  tokenEndpoint: `${ISSUER}/oauth/token`,
  revocationEndpoint: `${ISSUER}/oauth/revoke`,
  accessToken: 'at-old',
  accessTokenExpiresAt: NOW + 3_600,
  refreshToken: 'rt-old',
  scope: 'programs:read reports:read',
  obtainedAt: NOW - 10,
  ...overrides,
});

const tmpLockDir = (): string => mkdtempSync(join(tmpdir(), 'bsmcp-lock-'));

const session = (store = memoryStore([stored()]), as = fakeAuthorizationServer(), now = NOW) => {
  const s = new LocalSession({
    issuer: ISSUER,
    resource: ISSUER,
    store,
    lockDir: tmpLockDir(),
    logger: silentLogger,
    fetch: as.fetch,
    now: () => now * 1000,
  });
  return { s, store, as };
};

const code = async (p: Promise<unknown>): Promise<string | undefined> => {
  return p.then(
    () => undefined,
    (e: unknown) => (e instanceof BugSecureError ? e.code : String(e)),
  );
};

describe('LocalSession', () => {
  it('returns the stored token while it is fresh, without calling the AS', async () => {
    const { s, as } = session();
    expect(await s.getAccessToken()).toBe('at-old');
    expect(as.tokenRequests).toHaveLength(0);
    expect([...((await s.grantedScopes()) ?? [])].sort()).toEqual(['programs:read', 'reports:read']);
  });

  it('asks the user to log in when nothing is stored', async () => {
    const { s } = session(memoryStore());
    expect(await code(s.getAccessToken())).toBe('NOT_LOGGED_IN');
    expect(await s.grantedScopes()).toBeUndefined();
  });

  it('refreshes near expiry and stores the ROTATED refresh token', async () => {
    const store = memoryStore([stored({ accessTokenExpiresAt: NOW + 30 })]);
    const as = fakeAuthorizationServer();
    as.tokenResponses = [
      {
        status: 200,
        body: { access_token: 'at-new', token_type: 'Bearer', expires_in: 600, refresh_token: 'rt-new' },
      },
    ];
    const { s } = session(store, as);

    expect(await s.getAccessToken()).toBe('at-new');
    expect(as.tokenRequests[0]?.form).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-old',
      client_id: 'bugsecure-mcp-cli',
      resource: ISSUER,
    });
    expect(await store.load(ISSUER)).toMatchObject({
      accessToken: 'at-new',
      refreshToken: 'rt-new',
      accessTokenExpiresAt: NOW + 600,
    });
  });

  it('coalesces concurrent refreshes into one request (a reused refresh token would revoke the grant)', async () => {
    const as = fakeAuthorizationServer();
    as.tokenResponses = [
      {
        status: 200,
        body: { access_token: 'at-new', token_type: 'Bearer', expires_in: 600, refresh_token: 'rt-new' },
      },
    ];
    const { s } = session(memoryStore([stored({ accessTokenExpiresAt: NOW })]), as);
    const tokens = await Promise.all([s.getAccessToken(), s.getAccessToken(), s.getAccessToken()]);
    expect(tokens).toEqual(['at-new', 'at-new', 'at-new']);
    expect(as.tokenRequests).toHaveLength(1);
  });

  it('adopts tokens another process refreshed while it waited for the lock', async () => {
    const store = memoryStore([stored({ accessTokenExpiresAt: NOW })]);
    const { s, as } = session(store);
    await s.grantedScopes(); // caches the expired credentials
    await store.save(
      stored({ accessToken: 'at-other-process', refreshToken: 'rt-other', accessTokenExpiresAt: NOW + 600 }),
    );
    expect(await s.getAccessToken()).toBe('at-other-process');
    expect(as.tokenRequests).toHaveLength(0);
  });

  it('refreshes after the API rejected the current token', async () => {
    const as = fakeAuthorizationServer();
    as.tokenResponses = [
      { status: 200, body: { access_token: 'at-new', token_type: 'Bearer', expires_in: 600 } },
    ];
    const store = memoryStore([stored()]);
    const { s } = session(store, as);
    const token = await s.getAccessToken();
    s.invalidate(token);
    expect(await s.getAccessToken()).toBe('at-new');
    expect((await store.load(ISSUER))?.refreshToken).toBe('rt-old'); // no rotation offered: keep the old one
  });

  it('deletes the stored login when the refresh token is rejected', async () => {
    const as = fakeAuthorizationServer();
    as.tokenResponses = [{ status: 400, body: { error: 'invalid_grant' } }];
    const store = memoryStore([stored({ accessTokenExpiresAt: NOW })]);
    const { s } = session(store, as);
    expect(await code(s.getAccessToken())).toBe('SESSION_EXPIRED');
    expect(await store.load(ISSUER)).toBeUndefined();
  });

  it('deletes the stored login when none of its permissions is available any more (invalid_scope)', async () => {
    const as = fakeAuthorizationServer();
    as.tokenResponses = [{ status: 400, body: { error: 'invalid_scope' } }];
    const store = memoryStore([stored({ accessTokenExpiresAt: NOW })]);
    const { s } = session(store, as);
    const error = await s.getAccessToken().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'SESSION_EXPIRED' });
    expect((error as BugSecureError).message).toContain('no longer available to this account');
    expect((error as BugSecureError).hint).toContain('AI triage access / AI grading');
    expect(await store.load(ISSUER)).toBeUndefined();
  });

  it('names the signed-in user from the stored token, or nobody', async () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user-42' })).toString('base64url');
    expect(await session(memoryStore([stored({ accessToken: `h.${payload}.s` })])).s.subject()).toBe(
      'user-42',
    );
    expect(await session(memoryStore([stored({ accessToken: 'opaque' })])).s.subject()).toBeUndefined();
    expect(await session(memoryStore([])).s.subject()).toBeUndefined();
  });

  it('keeps the login on transient refresh failures', async () => {
    const as = fakeAuthorizationServer();
    as.tokenResponses = [{ status: 503, body: 'down' }];
    const store = memoryStore([stored({ accessTokenExpiresAt: NOW })]);
    const { s } = session(store, as);
    expect(await code(s.getAccessToken())).toBe('UPSTREAM_UNAVAILABLE');
    expect(await store.load(ISSUER)).toBeDefined();
  });

  it('reports expiry when there is no refresh token', async () => {
    const { refreshToken: _omit, ...rest } = stored({ accessTokenExpiresAt: NOW });
    const { s } = session(memoryStore([rest]));
    expect(await code(s.getAccessToken())).toBe('SESSION_EXPIRED');
  });

  it('refuses a login stored for a different API (tokens are audience-bound)', async () => {
    const { s, as } = session(memoryStore([stored({ resource: 'https://other-api.example' })]));
    const error = await s.getAccessToken().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BugSecureError);
    expect((error as BugSecureError).code).toBe('NOT_LOGGED_IN');
    expect((error as Error).message).toContain('https://other-api.example');
    await expect(s.grantedScopes()).rejects.toThrow(/configured for/);
    expect(as.tokenRequests).toHaveLength(0);
  });

  it('turns a credentials lock it cannot get into an actionable error', async () => {
    const dir = tmpLockDir();
    // A live holder: its heartbeat keeps the lock fresh.
    const holder = withCredentialsLock(dir, () => new Promise((resolve) => setTimeout(resolve, 400)));
    await new Promise((resolve) => setTimeout(resolve, 50)); // let it take the lock
    const blocked = withCredentialsLock(dir, () => Promise.resolve(), { timeoutMs: 50, pollMs: 10 });
    expect(await code(blocked)).toBe('CREDENTIALS_BUSY');
    await holder;
    // Released by its owner: the next caller gets it at once.
    await withFileLock(credentialsLockPath(dir), () => Promise.resolve(), { timeoutMs: 50 });
  });
});

describe('logout', () => {
  it('revokes the refresh and access tokens, then deletes local credentials', async () => {
    const as = fakeAuthorizationServer();
    const store = memoryStore([stored()]);
    const result = await logout({
      issuer: ISSUER,
      store,
      lockDir: tmpLockDir(),
      logger: silentLogger,
      fetch: as.fetch,
    });
    expect(result).toEqual({ hadCredentials: true, revoked: true });
    expect(as.revocations.map((r) => r.form)).toEqual([
      { token: 'rt-old', token_type_hint: 'refresh_token', client_id: 'bugsecure-mcp-cli' },
      { token: 'at-old', token_type_hint: 'access_token', client_id: 'bugsecure-mcp-cli' },
    ]);
    expect(await store.load(ISSUER)).toBeUndefined();
  });

  it('still deletes local credentials when revocation fails', async () => {
    const as = fakeAuthorizationServer();
    as.revocationStatus = 500;
    const store = memoryStore([stored()]);
    expect(
      await logout({ issuer: ISSUER, store, lockDir: tmpLockDir(), logger: silentLogger, fetch: as.fetch }),
    ).toEqual({
      hadCredentials: true,
      revoked: false,
    });
    expect(await store.load(ISSUER)).toBeUndefined();
  });

  it('is a no-op when not signed in', async () => {
    expect(
      await logout({ issuer: ISSUER, store: memoryStore(), lockDir: tmpLockDir(), logger: silentLogger }),
    ).toEqual({
      hadCredentials: false,
      revoked: false,
    });
  });
});

describe('decodeJwtPayload', () => {
  it('decodes a JWT payload for display and tolerates opaque tokens', () => {
    const jwt = `x.${Buffer.from(JSON.stringify({ sub: 'u1' })).toString('base64url')}.y`;
    expect(decodeJwtPayload(jwt)).toEqual({ sub: 'u1' });
    expect(decodeJwtPayload('opaque')).toBeUndefined();
    expect(decodeJwtPayload('a.!!!.b')).toBeUndefined();
    expect(decodeJwtPayload(`a.${Buffer.from('[1]').toString('base64url')}.b`)).toBeUndefined();
  });
});
