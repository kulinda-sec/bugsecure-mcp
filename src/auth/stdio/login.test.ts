import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fakeAuthorizationServer, ISSUER } from '../../../test/helpers/fake-authorization-server.js';
import { memoryStore } from '../../../test/helpers/memory-store.js';
import { loadLocalConfig } from '../../config.js';
import { buildAuthorizationUrl, login } from './login.js';

const config = loadLocalConfig({ BUGSECURE_API_URL: ISSUER });
const lockDir = (): string => mkdtempSync(join(tmpdir(), 'bsmcp-login-'));

/** Plays the user's browser: follows the authorization URL to the loopback redirect. */
const browser = (outcome: (authorizeUrl: URL) => Record<string, string>) => {
  const seen: URL[] = [];
  return {
    seen,
    presentUrl: async (url: string) => {
      const authorize = new URL(url);
      seen.push(authorize);
      const redirect = new URL(authorize.searchParams.get('redirect_uri') ?? '');
      for (const [k, v] of Object.entries(outcome(authorize))) redirect.searchParams.set(k, v);
      const res = await fetch(redirect);
      await res.text();
    },
  };
};

describe('login (authorization code + PKCE, loopback redirect)', () => {
  it('runs the full flow and stores tokens keyed by issuer', async () => {
    const as = fakeAuthorizationServer();
    as.tokenResponses = [
      {
        status: 200,
        body: {
          access_token: 'at',
          token_type: 'Bearer',
          expires_in: 600,
          refresh_token: 'rt',
          scope: 'programs:read',
        },
      },
    ];
    const store = memoryStore();
    const b = browser((u) => ({ code: 'auth-code', state: u.searchParams.get('state') ?? '', iss: ISSUER }));

    const creds = await login({
      config,
      scopes: ['reports:read', 'programs:read'],
      store,
      lockDir: lockDir(),
      presentUrl: b.presentUrl,
      fetch: as.fetch,
      now: () => 1_000_000,
    });

    const authorize = b.seen[0];
    expect(`${authorize?.origin ?? ''}${authorize?.pathname ?? ''}`).toBe(`${ISSUER}/oauth/authorize`);
    const q = authorize?.searchParams;
    expect(q?.get('response_type')).toBe('code');
    expect(q?.get('client_id')).toBe('bugsecure-mcp-cli');
    expect(q?.get('scope')).toBe('programs:read reports:read');
    expect(q?.get('code_challenge_method')).toBe('S256');
    expect(q?.get('resource')).toBe(ISSUER);
    expect(q?.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(q?.get('state')).toHaveLength(43);

    const form = as.tokenRequests[0]?.form ?? {};
    expect(form).toMatchObject({
      grant_type: 'authorization_code',
      code: 'auth-code',
      client_id: 'bugsecure-mcp-cli',
      redirect_uri: q?.get('redirect_uri'),
      resource: ISSUER,
    });
    // The verifier sent to the token endpoint hashes to the challenge sent to the browser.
    const challenge = createHash('sha256')
      .update(form.code_verifier ?? '')
      .digest('base64url');
    expect(challenge).toBe(q?.get('code_challenge'));

    expect(creds).toMatchObject({
      issuer: ISSUER,
      accessToken: 'at',
      refreshToken: 'rt',
      accessTokenExpiresAt: 1000 + 600,
      scope: 'programs:read',
      tokenEndpoint: `${ISSUER}/oauth/token`,
      revocationEndpoint: `${ISSUER}/oauth/revoke`,
    });
    expect(await store.load(ISSUER)).toEqual(creds);
  });

  it('does not redeem the code when the issuer in the redirect mismatches', async () => {
    const as = fakeAuthorizationServer();
    const store = memoryStore();
    const b = browser((u) => ({
      code: 'c',
      state: u.searchParams.get('state') ?? '',
      iss: 'https://evil.test',
    }));

    await expect(
      login({
        config,
        scopes: ['programs:read'],
        store,
        lockDir: lockDir(),
        presentUrl: b.presentUrl,
        fetch: as.fetch,
      }),
    ).rejects.toMatchObject({ code: 'issuer_mismatch' });
    expect(as.tokenRequests).toHaveLength(0);
    expect(await store.load(ISSUER)).toBeUndefined();
  });

  it('defaults the granted scope to the requested one when the AS omits it', async () => {
    const as = fakeAuthorizationServer();
    const store = memoryStore();
    const b = browser((u) => ({ code: 'c', state: u.searchParams.get('state') ?? '', iss: ISSUER }));
    const creds = await login({
      config,
      scopes: ['programs:read'],
      store,
      lockDir: lockDir(),
      presentUrl: b.presentUrl,
      fetch: as.fetch,
    });
    expect(creds.scope).toBe('programs:read');
    expect(creds.refreshToken).toBeUndefined();
  });

  it('requires at least one scope', async () => {
    await expect(
      login({
        config,
        scopes: [],
        store: memoryStore(),
        lockDir: lockDir(),
        presentUrl: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ error: 'invalid_scope' });
  });

  it('builds the authorization URL with every required parameter', () => {
    const url = new URL(
      buildAuthorizationUrl('https://as.test/oauth/authorize?tenant=x', {
        clientId: 'c',
        redirectUri: 'http://127.0.0.1:1/callback',
        scope: 'programs:read',
        state: 's',
        codeChallenge: 'ch',
        resource: 'https://api.test',
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      tenant: 'x',
      response_type: 'code',
      client_id: 'c',
      redirect_uri: 'http://127.0.0.1:1/callback',
      scope: 'programs:read',
      state: 's',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
      resource: 'https://api.test',
    });
  });
});
