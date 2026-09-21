import { exportJWK, FlattenedSign, flattenedVerify, generateKeyPair, importJWK } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import { fakeGraphQL } from '../../test/helpers/fake-graphql.js';
import { connectTools, type Harness, textOf } from '../../test/helpers/tool-harness.js';
import { canonicalJson } from '../crypto.js';
import { BugSecureError } from '../errors.js';

const TOKEN = 'Q2VydGlmaWNhdGVUb2tlbg';

let harness: Harness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('verify_certificate', () => {
  it('returns the signed document fenced, with signature metadata', async () => {
    const graphql = fakeGraphQL({
      VerifyCertificate: () => ({
        verifyCertificate: {
          reference: 'BSC-2026-0001',
          status: 'ISSUED',
          isSigned: true,
          keyId: 'k-2026',
          signedAt: '2026-05-01T10:00:00.000Z',
          signature: 'eyJhbGciOiJFZERTQSJ9..sig',
          document: { reference: 'BSC-2026-0001', payer: 'Acme' },
        },
        certificateSigningKeys: { keys: [] },
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('verify_certificate', { publicToken: TOKEN });

    expect(result.isError).toBeFalsy();
    expect(graphql.calls).toEqual([{ operation: 'VerifyCertificate', variables: { publicToken: TOKEN } }]);
    const { certificate } = result.structuredContent as { certificate: Record<string, unknown> };
    expect(certificate).toMatchObject({ reference: 'BSC-2026-0001', isSigned: true, keyId: 'k-2026' });
    expect(certificate.document).toMatch(
      /^<untrusted-content-[0-9a-f]{16} source="certificate:BSC-2026-0001:document">/,
    );
    expect(certificate.document).toContain('"payer": "Acme"');
    // The exact signed bytes, unfenced and unambiguous: canonical JSON (sorted keys), base64url.
    expect(Buffer.from(String(certificate.signedPayload), 'base64url').toString('utf8')).toBe(
      '{"payer":"Acme","reference":"BSC-2026-0001"}',
    );
  });

  it('reports an unknown token as not found', async () => {
    const graphql = fakeGraphQL({ VerifyCertificate: () => ({ verifyCertificate: null }) });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('verify_certificate', { publicToken: TOKEN });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/No certificate/);
  });

  it('rejects a printed reference or a URL instead of a token, before calling the API', async () => {
    const graphql = fakeGraphQL({});
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    expect((await harness.call('verify_certificate', { publicToken: 'BSC-2026-0001' })).isError).toBe(true);
    expect((await harness.call('verify_certificate', { publicToken: `https://x/${TOKEN}` })).isError).toBe(
      true,
    );
    expect(graphql.calls).toHaveLength(0);
  });

  it('relays API errors', async () => {
    const graphql = fakeGraphQL({
      VerifyCertificate: () => {
        throw new BugSecureError('UPSTREAM_UNAVAILABLE', 'The BugSecure API could not be reached.');
      },
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    expect(textOf(await harness.call('verify_certificate', { publicToken: TOKEN }))).toContain(
      'retry shortly',
    );
  });
  it('refuses a document too large to be a certificate instead of passing it on', async () => {
    const graphql = fakeGraphQL({
      VerifyCertificate: () => ({
        verifyCertificate: {
          reference: 'BSC-2026-0001',
          status: 'ISSUED',
          isSigned: true,
          keyId: 'k1',
          signedAt: '2026-09-01T00:00:00.000Z',
          signature: 'eyJh..c2ln',
          document: { padding: 'x'.repeat(70_000) },
        },
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });
    const result = await harness.call('verify_certificate', { publicToken: 'Q2VydGlmaWNhdGVUb2tlbg' });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('unexpectedly large');
  });
  it('returns the published key, so the signature verifies over the returned bytes', async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    const document = { reference: 'BSC-2026-0002', amounts: { gross: 500_000 }, payer: 'Acme' };
    const payload = new TextEncoder().encode(canonicalJson(document));
    const jws = await new FlattenedSign(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'k-2026', b64: false, crit: ['b64'] })
      .sign(privateKey);
    const graphql = fakeGraphQL({
      VerifyCertificate: () => ({
        verifyCertificate: {
          reference: 'BSC-2026-0002',
          status: 'ISSUED',
          isSigned: true,
          keyId: 'k-2026',
          signedAt: '2026-05-01T10:00:00.000Z',
          signature: `${jws.protected ?? ''}..${jws.signature}`,
          document,
        },
        certificateSigningKeys: {
          keys: [
            { kty: 'RSA', n: 'AQAB', e: 'AQAB', kid: 'k-old', alg: 'RS256' },
            { ...jwk, kid: 'k-2026', alg: 'RS256', use: 'sig' },
          ],
        },
      }),
    });
    harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });

    const result = await harness.call('verify_certificate', { publicToken: TOKEN });

    const out = result.structuredContent as {
      certificate: { signature: string; signedPayload: string };
      signingKey: { kid: string; kty: string; alg: string; n: string; e: string };
    };
    expect(out.signingKey).toMatchObject({ kid: 'k-2026', kty: 'RSA', alg: 'RS256' });
    const [protectedHeader, , signature] = out.certificate.signature.split('.');
    const verified = await flattenedVerify(
      {
        protected: protectedHeader ?? '',
        payload: Buffer.from(out.certificate.signedPayload, 'base64url'),
        signature: signature ?? '',
      },
      await importJWK(out.signingKey, 'RS256'),
    );
    expect(verified.protectedHeader?.kid).toBe('k-2026');
  });

  it('returns no key when none published matches, or one is malformed', async () => {
    const base = {
      reference: 'BSC-2026-0001',
      status: 'ISSUED',
      isSigned: true,
      keyId: 'k1',
      signedAt: '2026-09-01T00:00:00.000Z',
      signature: 'eyJh..c2ln',
      document: {},
    };
    for (const keys of [[], [{ kid: 'k1', kty: 'RSA', alg: 'RS256', n: 'has spaces', e: 'AQAB' }], 'nope']) {
      const graphql = fakeGraphQL({
        VerifyCertificate: () => ({ verifyCertificate: base, certificateSigningKeys: { keys } }),
      });
      harness = await connectTools({ graphql, grantedScopes: ['programs:read'] });
      const result = await harness.call('verify_certificate', { publicToken: TOKEN });
      expect(result.structuredContent).toMatchObject({ signingKey: null });
      await harness.close();
      harness = undefined;
    }
  });
});
