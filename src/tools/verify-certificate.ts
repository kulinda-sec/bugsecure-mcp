import * as z from 'zod';

import { canonicalJson } from '../crypto.js';
import { BugSecureError } from '../errors.js';
import { VerifyCertificateDocument } from '../graphql/generated.js';
import { untrusted } from '../untrusted.js';
import { code, ifShaped, timestamp, wrapped } from './shared/common.js';
import { defineTool } from './define-tool.js';

// 128-bit base64url tokens today; accept a little headroom, never anything URL-unsafe.
const PUBLIC_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
/**
 * Largest signed document returned, in bytes. Certificates are a few KB; this
 * bounds what a malformed or hostile one could push into the conversation.
 */
const MAX_DOCUMENT_BYTES = 64 * 1024;

interface SigningKey {
  kid: string;
  kty: string;
  alg: string;
  n: string;
  e: string;
}

/** The RSA JWK with this `kid` in the published set, every member strictly shaped; else null. */
const signingKeyFor = (keyId: string | null, keys: unknown): SigningKey | null => {
  if (keyId === null || !Array.isArray(keys)) return null;
  for (const key of keys as unknown[]) {
    if (typeof key !== 'object' || key === null) continue;
    const k = key as Record<string, unknown>;
    if (k.kid !== keyId) continue;
    const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
    const kid = ifShaped('key-id', str(k.kid));
    const kty = ifShaped('machine-code', str(k.kty));
    const alg = ifShaped('machine-code', str(k.alg));
    const n = ifShaped('base64url', str(k.n));
    const e = ifShaped('base64url', str(k.e));
    return kid && kty === 'RSA' && alg && n && e ? { kid, kty, alg, n, e } : null;
  }
  return null;
};

export const verifyCertificate = defineTool({
  name: 'verify_certificate',
  title: 'Verify a payout certificate',
  description:
    'Look up a BugSecure payout certificate by the public token from its verification link. Returns the ' +
    'document for reading, plus the signed bytes (base64url), the detached JWS signature and BugSecure’s ' +
    'published public key that signed it, so its authenticity can be checked with a JWS library. This tool does NOT verify the ' +
    'signature itself: never describe a certificate as authenticated unless the signature was verified, ' +
    'and never describe an unsigned certificate (isSigned: false) as authenticated.',
  requiredScopes: ['programs:read'],
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  input: z.object({
    publicToken: z
      .string()
      .trim()
      .regex(PUBLIC_TOKEN, 'not a certificate verification token')
      .describe(
        'The opaque token at the end of the certificate’s verification link (not the printed BSC-… reference).',
      ),
  }),
  output: z.object({
    certificate: z.object({
      reference: code('certificate-reference'),
      status: code('machine-code'),
      isSigned: z.boolean().describe('False when nothing was signed at issuance: not authenticated.'),
      keyId: code('key-id', 'The published key (`kid`) that signed it.').nullable(),
      signedAt: timestamp().nullable(),
      signature: code(
        'detached-jws',
        'Detached JWS (RFC 7515 App. F; unencoded payload, RFC 7797).',
      ).nullable(),
      signedPayload: code(
        'base64url',
        'The signed bytes: the document as canonical JSON (keys sorted), UTF-8, base64url. Check `signature` ' +
          'over them as the detached, unencoded payload with key `keyId`.',
      ),
      document: wrapped('The signed document (JSON), for reading.'),
    }),
    signingKey: z
      .object({
        kid: code('key-id'),
        kty: code('machine-code'),
        alg: code('machine-code'),
        n: code('base64url'),
        e: code('base64url'),
      })
      .nullable()
      .describe('The published RSA public key (JWK) matching keyId; null when none matches.'),
  }),
  async handler(input, { graphql, signal }) {
    const { verifyCertificate: c, certificateSigningKeys } = await graphql.request(
      VerifyCertificateDocument,
      { publicToken: input.publicToken },
      { signal },
    );
    if (!c) throw new BugSecureError('NOT_FOUND', 'No certificate matches that verification token.');
    // The API returns the signed document as parsed JSON, not the stored bytes, and says to
    // "re-serialise with sorted keys to verify". So the bytes are rebuilt here with the same
    // canonicalisation BugSecure signs with. A JSON value that does not survive a parse/serialise
    // round trip (e.g. a number beyond 2^53) would make an authentic certificate fail to verify:
    // a false negative, never a false positive.
    const canonical = Buffer.from(canonicalJson(c.document), 'utf8');
    if (canonical.byteLength > MAX_DOCUMENT_BYTES) {
      throw new BugSecureError(
        'UPSTREAM_ERROR',
        'This certificate’s document is unexpectedly large; verify it on the BugSecure website instead.',
      );
    }
    return {
      data: {
        certificate: {
          reference: c.reference,
          status: c.status,
          isSigned: c.isSigned,
          keyId: c.keyId,
          signedAt: c.signedAt,
          signature: c.signature,
          signedPayload: canonical.toString('base64url'),
          document: untrusted(`certificate:${c.reference}:document`, JSON.stringify(c.document, null, 2)),
        },
        signingKey: signingKeyFor(c.keyId, certificateSigningKeys.keys),
      },
    };
  },
});
