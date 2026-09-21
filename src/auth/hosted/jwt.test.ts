import { generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  TEST_ISSUER,
  TEST_RESOURCE,
  testSigner,
  type TestSigner,
  unsignedToken,
} from '../../../test/helpers/jwt.js';
import { type AccessTokenVerifier, createAccessTokenVerifier, InvalidTokenError } from './jwt.js';

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
