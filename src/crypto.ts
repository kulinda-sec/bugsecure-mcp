import { createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** `n` bytes from the CSPRNG, base64url-encoded (no padding). */
export const randomToken = (bytes = 32): string => {
  return randomBytes(bytes).toString('base64url');
};

export const sha256Base64Url = (value: string): string => {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
};

/**
 * Constant-time string comparison. Both sides are hashed first, so neither the
 * length nor the content of the secret leaks through timing.
 */
export const constantTimeEqual = (a: string, b: string): boolean => {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
};

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
  readonly method: 'S256';
}

/**
 * RFC 7636 PKCE with S256 (the only method OAuth 2.1 and MCP allow).
 * 32 random bytes → a 43-character verifier, the RFC's recommended entropy.
 */
export const createPkcePair = (): PkcePair => {
  const verifier = randomToken(32);
  return { verifier, challenge: sha256Base64Url(verifier), method: 'S256' };
};

/**
 * Deterministic JSON: object keys sorted at every level, `undefined` members
 * dropped. The same algorithm BugSecure uses for signed certificates, so the
 * output is byte-identical to what it signed.
 */
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    // JSON.stringify returns undefined for undefined/functions/symbols.
    const json = JSON.stringify(value) as string | undefined;
    return json ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};

/**
 * A 256-bit key for one purpose, derived from a longer-lived secret with
 * HKDF-SHA256 (RFC 5869). Different `purpose` strings give independent keys.
 */
export const deriveKey = (secret: string, purpose: string): Uint8Array => {
  return new Uint8Array(hkdfSync('sha256', secret, 'bugsecure-mcp', purpose, 32));
};
