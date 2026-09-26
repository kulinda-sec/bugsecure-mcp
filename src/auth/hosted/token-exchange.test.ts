import { describe, expect, it } from 'vitest';

import { fakeAuthorizationServer, ISSUER } from '../../../test/helpers/fake-authorization-server.js';
import { BugSecureError } from '../../errors.js';
import { silentLogger } from '../../logger.js';
import type { VerifiedAccessToken } from './jwt.js';
import { ExpiringLru } from '../../lru.js';
import {
  ACCESS_TOKEN_TYPE,
  exchangedTokenProvider,
  TOKEN_EXCHANGE_GRANT,
  TokenExchanger,
} from './token-exchange.js';

const NOW_MS = 1_000_000_000;

const subject = (jti = 'jti-1', expiresAt = NOW_MS / 1000 + 600): VerifiedAccessToken => ({
  token: `inbound-${jti}`,
  subject: 'user-1',
  clientId: 'claude',
  jti,
  grantId: 'g1',
  scopes: new Set(['programs:read', 'reports:read'] as const),
  expiresAt,
});

const exchanger = (options: { cacheSize?: number; nowMs?: () => number } = {}) => {
  const as = fakeAuthorizationServer();
  as.tokenResponses = [
    {
      status: 200,
      body: {
        access_token: 'api-1',
        token_type: 'Bearer',
        expires_in: 600,
        issued_token_type: ACCESS_TOKEN_TYPE,
      },
    },
    { status: 200, body: { access_token: 'api-2', token_type: 'Bearer', expires_in: 600 } },
    { status: 200, body: { access_token: 'api-3', token_type: 'Bearer', expires_in: 600 } },
  ];
  const ex = new TokenExchanger({
    tokenEndpoint: `${ISSUER}/oauth/token`,
    clientId: 'bugsecure-mcp-hosted',
    clientSecret: 'hosted-secret',
    apiResource: 'https://api.test',
    cacheSize: options.cacheSize ?? 10,
    logger: silentLogger,
    fetch: as.fetch,
    now: options.nowMs ?? (() => NOW_MS),
  });
  return { ex, as };
};

describe('RFC 8693 token exchange', () => {
  it('exchanges as a confidential client for an API-audience token', async () => {
    const { ex, as } = exchanger();
    expect(await ex.exchange(subject())).toBe('api-1');
    const req = as.tokenRequests[0];
    expect(req?.form).toEqual({
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: 'inbound-jti-1',
      subject_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      resource: 'https://api.test',
      scope: 'programs:read reports:read',
    });
    expect(req?.authorization).toBe(
      `Basic ${Buffer.from('bugsecure-mcp-hosted:hosted-secret').toString('base64')}`,
    );
  });

  it('caches per jti and shares in-flight exchanges', async () => {
    const { ex, as } = exchanger();
    const [a, b] = await Promise.all([ex.exchange(subject()), ex.exchange(subject())]);
    expect([a, b]).toEqual(['api-1', 'api-1']);
    expect(await ex.exchange(subject())).toBe('api-1');
    expect(as.tokenRequests).toHaveLength(1);
    expect(await ex.exchange(subject('jti-2'))).toBe('api-2');
    expect(as.tokenRequests).toHaveLength(2);
  });

  it('expires cache entries 30 s before the sooner of the two expiries', async () => {
    let now = NOW_MS;
    const { ex, as } = exchanger({ nowMs: () => now });
    // Inbound token expires in 100 s: the cached token is usable for 70 s.
    await ex.exchange(subject('jti-1', NOW_MS / 1000 + 100));
    now += 69_000;
    await ex.exchange(subject('jti-1', NOW_MS / 1000 + 100));
    expect(as.tokenRequests).toHaveLength(1);
    now += 2_000;
    await ex.exchange(subject('jti-1', NOW_MS / 1000 + 100));
    expect(as.tokenRequests).toHaveLength(2);
  });

  it('is bounded (LRU eviction)', async () => {
    const { ex, as } = exchanger({ cacheSize: 1 });
    await ex.exchange(subject('a'));
    await ex.exchange(subject('b')); // evicts a
    await ex.exchange(subject('a'));
    expect(as.tokenRequests).toHaveLength(3);
  });

  it('drops the cached token on invalidate', async () => {
    const { ex, as } = exchanger();
    const provider = exchangedTokenProvider(ex, subject());
    expect(await provider.getAccessToken()).toBe('api-1');
    provider.invalidate('api-1');
    expect(await provider.getAccessToken()).toBe('api-2');
    expect(as.tokenRequests).toHaveLength(2);
  });

  it('maps a refused exchange to SESSION_EXPIRED and other failures to UPSTREAM_UNAVAILABLE', async () => {
    const { ex, as } = exchanger();
    as.tokenResponses = [{ status: 400, body: { error: 'invalid_grant' } }];
    const refused = await ex.exchange(subject()).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(BugSecureError);
    expect(refused).toMatchObject({ code: 'SESSION_EXPIRED' });

    as.tokenResponses = [{ status: 500, body: { error: 'server_error' } }];
    await expect(ex.exchange(subject('x'))).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('remembers a refused token until it expires, and stops asking the AS about it', async () => {
    let now = NOW_MS;
    const { ex, as } = exchanger({ nowMs: () => now });
    const dead = subject('dead', NOW_MS / 1000 + 120);
    expect(await ex.exchange(dead)).toBe('api-1'); // cached …
    ex.invalidate(dead); // … until the API rejected it
    as.tokenResponses = [{ status: 400, body: { error: 'invalid_grant' } }];
    await expect(ex.exchange(dead)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(ex.isRefused(dead)).toBe(true);
    expect(as.tokenRequests).toHaveLength(2);

    await expect(ex.exchange(dead)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(as.tokenRequests).toHaveLength(2); // not asked again

    // Other tokens (even of the same user and client) are unaffected.
    expect(ex.isRefused(subject('other'))).toBe(false);
    // The memory ends with the token's own lifetime.
    now = NOW_MS + 121_000;
    expect(ex.isRefused(dead)).toBe(false);
  });

  it('refuses to exchange a token carrying no scope it knows, instead of sending an empty scope', async () => {
    const { ex, as } = exchanger();
    await expect(ex.exchange({ ...subject(), scopes: new Set() })).rejects.toMatchObject({
      code: 'INSUFFICIENT_SCOPE',
    });
    expect(as.tokenRequests).toHaveLength(0);
  });

  it('refuses an exchanged token broader than requested, and accepts a narrower one', async () => {
    const { ex, as } = exchanger();
    as.tokenResponses = [
      {
        status: 200,
        body: {
          access_token: 'wide',
          token_type: 'Bearer',
          expires_in: 600,
          scope: 'programs:read reports:write',
        },
      },
      {
        status: 200,
        body: { access_token: 'narrow', token_type: 'Bearer', expires_in: 600, scope: 'programs:read' },
      },
    ];
    await expect(ex.exchange(subject())).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(await ex.exchange(subject('jti-2'))).toBe('narrow');
  });

  it('caches the scopes granted by the exchange with the token: narrowed, or else the requested ones', async () => {
    const { ex, as } = exchanger();
    as.tokenResponses = [
      {
        status: 200,
        body: { access_token: 'narrow', token_type: 'Bearer', expires_in: 600, scope: 'programs:read' },
      },
      { status: 200, body: { access_token: 'same', token_type: 'Bearer', expires_in: 600 } },
    ];
    expect([...(await ex.grantedScopes(subject()))]).toEqual(['programs:read']);
    expect(await ex.exchange(subject())).toBe('narrow');
    expect(as.tokenRequests).toHaveLength(1); // one exchange serves both
    expect([...(await ex.grantedScopes(subject('jti-2')))].sort()).toEqual(['programs:read', 'reports:read']);
  });

  it.each([
    ['invalid_scope', 400, true],
    ['invalid_token', 400, true],
    ['server_error', 500, false],
    ['temporarily_unavailable', 503, false],
  ])('marks a token refused on %s: %s', async (error, status, refused) => {
    const { ex, as } = exchanger();
    as.tokenResponses = [{ status, body: { error } }];
    await ex.exchange(subject()).catch(() => undefined);
    expect(ex.isRefused(subject())).toBe(refused);
  });

  it('rejects an unexpected issued_token_type', async () => {
    const { ex, as } = exchanger();
    as.tokenResponses = [
      {
        status: 200,
        body: {
          access_token: 'x',
          token_type: 'Bearer',
          issued_token_type: 'urn:ietf:params:oauth:token-type:id_token',
        },
      },
    ];
    await expect(ex.exchange(subject())).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('honours caller cancellation without failing the shared exchange', async () => {
    const { ex } = exchanger();
    const controller = new AbortController();
    controller.abort(new Error('client went away'));
    await expect(ex.exchange(subject(), controller.signal)).rejects.toThrow('client went away');
    expect(await ex.exchange(subject())).toBe('api-1');
  });
});

describe('ExpiringLru', () => {
  it('evicts least recently used entries and expired ones', () => {
    let now = 0;
    const lru = new ExpiringLru<string, number>(2, () => now);
    lru.set('a', 1, 100);
    lru.set('b', 2, 100);
    expect(lru.get('a')).toBe(1); // a is now most recent
    lru.set('c', 3, 100); // evicts b
    expect(lru.get('b')).toBeUndefined();
    expect(lru.size).toBe(2);
    now = 100;
    expect(lru.get('a')).toBeUndefined();
    lru.set('d', 4, 50); // already expired: not stored
    expect(lru.get('d')).toBeUndefined();
    expect(() => new ExpiringLru(0)).toThrow(RangeError);
  });
});
