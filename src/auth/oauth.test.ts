import { describe, expect, it, vi } from 'vitest';

import {
  defaultMetadata,
  fakeAuthorizationServer,
  ISSUER,
} from '../../test/helpers/fake-authorization-server.js';
import {
  basicAuthorization,
  discoverAuthorizationServer,
  metadataUrls,
  OAuthRequestError,
  requestToken,
  revokeToken,
} from './oauth.js';

describe('authorization server discovery', () => {
  it('builds the well-known URLs in the order the MCP spec prescribes', () => {
    expect(metadataUrls('https://as.test')).toEqual([
      'https://as.test/.well-known/oauth-authorization-server',
      'https://as.test/.well-known/openid-configuration',
    ]);
    expect(metadataUrls('https://as.test/tenant1')).toEqual([
      'https://as.test/.well-known/oauth-authorization-server/tenant1',
      'https://as.test/.well-known/openid-configuration/tenant1',
      'https://as.test/tenant1/.well-known/openid-configuration',
    ]);
  });

  it('returns validated metadata', async () => {
    const as = fakeAuthorizationServer();
    const metadata = await discoverAuthorizationServer(ISSUER, { fetch: as.fetch });
    expect(metadata.token_endpoint).toBe(`${ISSUER}/oauth/token`);
  });

  it('rejects metadata naming a different issuer (mix-up defence)', async () => {
    const as = fakeAuthorizationServer();
    as.metadata = defaultMetadata('https://evil.test');
    await expect(discoverAuthorizationServer(ISSUER, { fetch: as.fetch })).rejects.toMatchObject({
      error: 'issuer_mismatch',
    });
  });

  it('refuses to proceed without PKCE S256', async () => {
    const as = fakeAuthorizationServer();
    as.metadata = { ...defaultMetadata(), code_challenge_methods_supported: ['plain'] };
    await expect(discoverAuthorizationServer(ISSUER, { fetch: as.fetch })).rejects.toMatchObject({
      error: 'pkce_unsupported',
    });
    as.metadata = { ...defaultMetadata(), code_challenge_methods_supported: undefined };
    await expect(discoverAuthorizationServer(ISSUER, { fetch: as.fetch })).rejects.toMatchObject({
      error: 'pkce_unsupported',
    });
  });

  it('rejects non-https endpoints', async () => {
    const as = fakeAuthorizationServer();
    as.metadata = { ...defaultMetadata(), token_endpoint: 'http://as.test/oauth/token' };
    await expect(discoverAuthorizationServer(ISSUER, { fetch: as.fetch })).rejects.toMatchObject({
      error: 'invalid_metadata',
    });
  });

  it('falls back to OpenID discovery, and reports absence and network failure', async () => {
    const fetch = vi.fn((url: string | URL | Request) =>
      Promise.resolve(
        (url instanceof Request ? url.url : url.toString()).endsWith('openid-configuration')
          ? new Response(JSON.stringify(defaultMetadata()), { status: 200 })
          : new Response('nope', { status: 404 }),
      ),
    );
    await expect(discoverAuthorizationServer(ISSUER, { fetch })).resolves.toMatchObject({ issuer: ISSUER });

    const none = vi.fn(() => Promise.resolve(new Response('nope', { status: 404 })));
    await expect(discoverAuthorizationServer(ISSUER, { fetch: none })).rejects.toMatchObject({
      error: 'metadata_not_found',
    });

    const down = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    await expect(discoverAuthorizationServer(ISSUER, { fetch: down })).rejects.toMatchObject({
      error: 'network_error',
    });
  });
});

describe('token endpoint', () => {
  it('encodes client_secret_basic per RFC 6749 §2.3.1', () => {
    const header = basicAuthorization('client id', 'p@ss:w rd');
    const decoded = Buffer.from(header.replace(/^Basic /, ''), 'base64').toString();
    expect(decoded).toBe('client+id:p%40ss%3Aw+rd');
  });

  it('posts a form and validates the response', async () => {
    const as = fakeAuthorizationServer();
    const tokens = await requestToken(`${ISSUER}/oauth/token`, { grant_type: 'x' }, { fetch: as.fetch });
    expect(tokens.access_token).toBe('at-1');
    expect(as.tokenRequests[0]?.form).toEqual({ grant_type: 'x' });
    expect(as.tokenRequests[0]?.authorization).toBeNull();
  });

  it('surfaces RFC 6749 errors, sanitised', async () => {
    const as = fakeAuthorizationServer();
    as.tokenResponses = [
      { status: 400, body: { error: 'invalid_grant', error_description: 'used\u0000 token' } },
    ];
    const error = await requestToken(`${ISSUER}/oauth/token`, {}, { fetch: as.fetch }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OAuthRequestError);
    expect(error).toMatchObject({
      error: 'invalid_grant',
      status: 400,
      message: 'invalid_grant: used token',
    });
  });

  it.each([[{ access_token: 'x', token_type: 'mac' }], [{ token_type: 'Bearer' }], ['not json']])(
    'rejects invalid token responses %#',
    async (body) => {
      const as = fakeAuthorizationServer();
      as.tokenResponses = [{ status: 200, body }];
      await expect(requestToken(`${ISSUER}/oauth/token`, {}, { fetch: as.fetch })).rejects.toMatchObject({
        error: 'invalid_response',
      });
    },
  );

  it('maps non-OAuth error bodies and network failures', async () => {
    const as = fakeAuthorizationServer();
    as.tokenResponses = [{ status: 502, body: '<html>' }];
    await expect(requestToken(`${ISSUER}/oauth/token`, {}, { fetch: as.fetch })).rejects.toMatchObject({
      error: 'http_error',
    });
    const down = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    await expect(requestToken(`${ISSUER}/oauth/token`, {}, { fetch: down })).rejects.toMatchObject({
      error: 'network_error',
    });
  });

  it('revokes tokens (RFC 7009)', async () => {
    const as = fakeAuthorizationServer();
    await revokeToken(
      `${ISSUER}/oauth/revoke`,
      { token: 'rt', token_type_hint: 'refresh_token', client_id: 'c' },
      { fetch: as.fetch },
    );
    expect(as.revocations[0]?.form).toEqual({
      token: 'rt',
      token_type_hint: 'refresh_token',
      client_id: 'c',
    });
    as.revocationStatus = 503;
    await expect(
      revokeToken(
        `${ISSUER}/oauth/revoke`,
        { token: 'rt', token_type_hint: 'refresh_token', client_id: 'c' },
        { fetch: as.fetch },
      ),
    ).rejects.toBeInstanceOf(OAuthRequestError);
  });
});
