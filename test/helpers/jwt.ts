import { createLocalJWKSet, exportJWK, generateKeyPair, type JWTPayload, SignJWT } from 'jose';

export const TEST_ISSUER = 'https://as.test';
export const TEST_RESOURCE = 'https://mcp.test/mcp';

export interface TestSigner {
  readonly keys: ReturnType<typeof createLocalJWKSet>;
  sign(overrides?: JWTPayload, header?: { typ?: string; alg?: string }): Promise<string>;
}

export const testSigner = async (): Promise<TestSigner> => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const now = Math.floor(Date.now() / 1000);
  return {
    keys,
    sign: (overrides = {}, header = {}) =>
      new SignJWT({
        iss: TEST_ISSUER,
        sub: 'user-1',
        aud: TEST_RESOURCE,
        client_id: 'client-1',
        scope: 'programs:read reports:read',
        jti: 'jti-1',
        grant_id: 'grant-1',
        iat: now,
        exp: now + 600,
        ...overrides,
      })
        .setProtectedHeader({ alg: header.alg ?? 'RS256', typ: header.typ ?? 'at+jwt', kid: 'k1' })
        .sign(privateKey),
  };
};

/** An unsigned `alg: none` token with otherwise valid claims. */
export const unsignedToken = (payload: Record<string, unknown>): string => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none', typ: 'at+jwt' })}.${enc(payload)}.`;
};
