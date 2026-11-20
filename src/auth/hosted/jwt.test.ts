import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createRemoteJWKSet,
  type CryptoKey,
  errors as joseErrors,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
  SignJWT,
} from 'jose';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  TEST_ISSUER,
  TEST_RESOURCE,
  testSigner,
  type TestSigner,
  unsignedToken,
} from '../../../test/helpers/jwt.js';
import {
  type AccessTokenVerifier,
  createAccessTokenVerifier,
  InvalidTokenError,
  KeySetUnavailableError,
  remoteJwks,
} from './jwt.js';

let signer: TestSigner;
let verify: AccessTokenVerifier;
const now = () => Math.floor(Date.now() / 1000);

beforeAll(async () => {
  signer = await testSigner();
  verify = createAccessTokenVerifier({ issuer: TEST_ISSUER, audience: TEST_RESOURCE, keys: signer.keys });
});

describe('hosted access-token validation (RFC 9068 + RFC 8707)', () => {
  it('accepts a valid token and exposes its claims', async () => {
    const token = await signer.sign();
    const v = await verify(token);
    expect(v).toMatchObject({
      subject: 'user-1',
      clientId: 'client-1',
      jti: 'jti-1',
      grantId: 'grant-1',
      token,
    });
    expect([...v.scopes].sort()).toEqual(['programs:read', 'reports:read']);
  });

  it('drops unknown scopes rather than trusting them', async () => {
    const v = await verify(await signer.sign({ scope: 'programs:read admin:all' }));
    expect([...v.scopes]).toEqual(['programs:read']);
  });

  const rejects = async (token: Promise<string> | string): Promise<void> => {
    await expect(verify(await token)).rejects.toBeInstanceOf(InvalidTokenError);
  };

  it('rejects a token for another audience (e.g. the API itself: no passthrough)', async () => {
    await rejects(signer.sign({ aud: 'https://bugsecure-api.test' }));
  });

  it('rejects a multi-audience token even if it includes this server', async () => {
    await rejects(signer.sign({ aud: [TEST_RESOURCE, 'https://other.test'] }));
  });

  it('rejects a token from another issuer', async () => {
    await rejects(signer.sign({ iss: 'https://evil.test' }));
  });

  it('rejects a token without typ at+jwt (e.g. an ID token)', async () => {
    await rejects(signer.sign({}, { typ: 'JWT' }));
  });

  it('rejects alg none', async () => {
    await rejects(
      unsignedToken({
        iss: TEST_ISSUER,
        sub: 'u',
        aud: TEST_RESOURCE,
        client_id: 'c',
        jti: 'j',
        iat: now(),
        exp: now() + 60,
      }),
    );
  });

  it('rejects HS256 (algorithm allowlist; no RSA/HMAC key confusion)', async () => {
    const hmac = await new SignJWT({
      iss: TEST_ISSUER,
      sub: 'u',
      aud: TEST_RESOURCE,
      client_id: 'c',
      jti: 'j',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('a-shared-secret-of-sufficient-length-000'));
    await rejects(hmac);
  });

  it('rejects an expired token (beyond the clock tolerance)', async () => {
    await expect(verify(await signer.sign({ iat: now() - 3_600, exp: now() - 120 }))).rejects.toThrow(
      'token expired',
    );
  });

  it('rejects a token that is not yet valid', async () => {
    await rejects(signer.sign({ nbf: now() + 600 }));
  });

  it('rejects a token older than the maximum token age, whatever its exp', async () => {
    const token = await signer.sign({ iat: now() - 20 * 60, exp: now() + 3_600 });
    await expect(verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token issued in the future (beyond the clock tolerance)', async () => {
    const token = await signer.sign({ iat: now() + 120, exp: now() + 600 });
    await expect(verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
  });

  it('rejects a token signed by an unknown key', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const forged = await new SignJWT({
      iss: TEST_ISSUER,
      sub: 'u',
      aud: TEST_RESOURCE,
      client_id: 'c',
      jti: 'j',
    })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    await rejects(forged);
  });

  it.each(['jti', 'client_id', 'sub', 'exp', 'iat'])('rejects a token missing %s', async (claim) => {
    await rejects(signer.sign({ [claim]: undefined }));
  });

  it('rejects garbage', async () => {
    await rejects('not.a.jwt');
  });
});

describe('key-set failures are not token faults', () => {
  let privateKey: CryptoKey;
  let jwk: JWK;
  const servers: Server[] = [];

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  });

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });

  /** A key endpoint on 127.0.0.1 answering with `respond`; gives its URL and counts its requests. */
  const keyEndpoint = async (
    respond: (response: ServerResponse, hit: number) => void,
  ): Promise<{ url: string; hits: () => number }> => {
    let hits = 0;
    const server = createServer((_request, response) => {
      hits += 1;
      respond(response, hits);
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/jwks`, hits: () => hits };
  };

  const sendJson = (response: ServerResponse, body: unknown): void => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const claims = { iss: TEST_ISSUER, sub: 'user-1', aud: TEST_RESOURCE, client_id: 'client-1', jti: 'jti-1' };

  const sign = (
    overrides: Record<string, unknown> = {},
    kid: string | null = 'k1',
    key: CryptoKey = privateKey,
  ): Promise<string> => {
    return new SignJWT({ ...claims, iat: now(), exp: now() + 300, ...overrides })
      .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', ...(kid === null ? {} : { kid }) })
      .sign(key);
  };

  const verifierFor = (keys: JWTVerifyGetKey): AccessTokenVerifier => {
    return createAccessTokenVerifier({ issuer: TEST_ISSUER, audience: TEST_RESOURCE, keys });
  };

  /** The verifier refuses a VALID token with a KeySetUnavailableError carrying `code`. */
  const unavailable = async (keys: JWTVerifyGetKey, code: string): Promise<void> => {
    const error: unknown = await verifierFor(keys)(await sign()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeySetUnavailableError);
    expect(error).not.toBeInstanceOf(InvalidTokenError);
    expect(error).toMatchObject({ code, message: 'signing keys are unavailable' });
  };

  it('accepts a valid token through a reachable key endpoint', async () => {
    const endpoint = await keyEndpoint((response) => {
      sendJson(response, { keys: [jwk] });
    });
    await expect(verifierFor(remoteJwks(endpoint.url))(await sign())).resolves.toMatchObject({
      subject: 'user-1',
    });
  });

  it('a key endpoint answering 500 is a key-set failure', async () => {
    const endpoint = await keyEndpoint((response) => {
      response.writeHead(500).end('oops');
    });
    await unavailable(remoteJwks(endpoint.url), 'ERR_JOSE_GENERIC');
  });

  it('a key endpoint answering 200 with a body that is not JSON is a key-set failure', async () => {
    const endpoint = await keyEndpoint((response) => {
      response.writeHead(200, { 'content-type': 'text/html' }).end('<html>maintenance</html>');
    });
    await unavailable(remoteJwks(endpoint.url), 'ERR_JOSE_GENERIC');
  });

  it.each([
    ['an object without keys', {}],
    ['keys that is not an array', { keys: 'nope' }],
    ['a JSON string', 'nope'],
  ])('a malformed key set (%s) is a key-set failure', async (_name, body) => {
    const endpoint = await keyEndpoint((response) => {
      sendJson(response, body);
    });
    await unavailable(remoteJwks(endpoint.url), 'ERR_JWKS_INVALID');
  });

  it('a key endpoint that does not answer in time is a key-set failure', async () => {
    const endpoint = await keyEndpoint(() => {
      // Never answers.
    });
    // The same jose resolver as remoteJwks, with a timeout short enough for a test.
    await unavailable(createRemoteJWKSet(new URL(endpoint.url), { timeoutDuration: 50 }), 'ERR_JWKS_TIMEOUT');
  });

  it('a refused connection is a key-set failure', async () => {
    const endpoint = await keyEndpoint((response) => {
      response.end();
    });
    const server = servers.pop();
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    await unavailable(remoteJwks(endpoint.url), 'ERR_KEY_SET_UNAVAILABLE');
  });

  it('a resolver that throws anything else is a key-set failure, never an accepted token', async () => {
    await unavailable(() => {
      throw new joseErrors.JWKSTimeout();
    }, 'ERR_JWKS_TIMEOUT');
    await unavailable(() => Promise.reject(new Error('boom')), 'ERR_KEY_SET_UNAVAILABLE');
    await unavailable(() => Promise.reject(new joseErrors.JOSEError('anything')), 'ERR_JOSE_GENERIC');
  });

  it('an unknown kid with a reachable key set is a token fault', async () => {
    const endpoint = await keyEndpoint((response) => {
      sendJson(response, { keys: [jwk] });
    });
    const verifyRemote = verifierFor(remoteJwks(endpoint.url));
    await expect(verifyRemote(await sign({}, 'other'))).rejects.toBeInstanceOf(InvalidTokenError);
    // The cooldown holds: a second unknown kid does not refetch.
    await expect(verifyRemote(await sign({}, 'another'))).rejects.toBeInstanceOf(InvalidTokenError);
    expect(endpoint.hits()).toBe(1);
  });

  it('a token without kid that matches several keys is a token fault', async () => {
    const other = await generateKeyPair('RS256');
    const second = { ...(await exportJWK(other.publicKey)), kid: 'k2', alg: 'RS256', use: 'sig' };
    const endpoint = await keyEndpoint((response) => {
      sendJson(response, { keys: [jwk, second] });
    });
    await expect(verifierFor(remoteJwks(endpoint.url))(await sign({}, null))).rejects.toBeInstanceOf(
      InvalidTokenError,
    );
  });

  it('an unknown kid whose refetch fails is a key-set failure', async () => {
    const endpoint = await keyEndpoint((response, hit) => {
      if (hit === 1) sendJson(response, { keys: [jwk] });
      else response.writeHead(503).end();
    });
    // No cooldown, so the unknown kid refetches at once.
    const verifyRemote = verifierFor(createRemoteJWKSet(new URL(endpoint.url), { cooldownDuration: 0 }));
    await expect(verifyRemote(await sign())).resolves.toMatchObject({ subject: 'user-1' });
    await expect(verifyRemote(await sign({}, 'other'))).rejects.toBeInstanceOf(KeySetUnavailableError);
    expect(endpoint.hits()).toBe(2);
  });

  it('with a reachable key set, token faults stay token faults', async () => {
    const endpoint = await keyEndpoint((response) => {
      sendJson(response, { keys: [jwk] });
    });
    const verifyRemote = verifierFor(remoteJwks(endpoint.url));
    const forger = await generateKeyPair('RS256');
    const tokens = [
      await sign({}, 'k1', forger.privateKey), // bad signature
      await sign({ aud: 'https://bugsecure-api.test' }),
      await sign({ iat: now() - 3_600, exp: now() - 120 }),
      'not.a.jwt',
      unsignedToken({ ...claims, iat: now(), exp: now() + 60 }),
    ];
    for (const token of tokens) {
      await expect(verifyRemote(token)).rejects.toBeInstanceOf(InvalidTokenError);
    }
  });

  it('judges the header before fetching keys: a refused algorithm is a token fault even with the keys down', async () => {
    const endpoint = await keyEndpoint((response) => {
      response.writeHead(500).end();
    });
    const verifyRemote = verifierFor(remoteJwks(endpoint.url));
    await expect(
      verifyRemote(unsignedToken({ ...claims, iat: now(), exp: now() + 60 })),
    ).rejects.toBeInstanceOf(InvalidTokenError);
    await expect(verifyRemote('not.a.jwt')).rejects.toBeInstanceOf(InvalidTokenError);
    expect(endpoint.hits()).toBe(0);
  });
});
