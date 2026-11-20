/**
 * Validation of inbound access tokens in hosted mode (this server is an OAuth
 * 2.1 resource server). Tokens are RFC 9068 JWTs issued by the BugSecure
 * authorization server and verified locally against its JWKS:
 *
 * - signature: RS256 only (an explicit allowlist; `none` and HMAC are refused,
 *   which also defeats RSA/HMAC key-confusion);
 * - header `typ` = `at+jwt` (RFC 9068 §4: rejects ID tokens and other JWTs);
 * - `iss` = the configured issuer, exactly;
 * - `aud` = THIS server's canonical resource URI (RFC 8707). A token minted
 *   for the API, or for another MCP server, is rejected: no passthrough;
 * - `exp` in the future and `nbf` not in the future (30 s leeway); `iat` not
 *   in the future and at most MAX_TOKEN_AGE old (jose `maxTokenAge`: a token
 *   minted with a far-future `exp` still dies on schedule); and the claims we
 *   rely on (`sub`, `client_id`, `jti`, `scope`) present.
 *
 * A token that fails any of these is an InvalidTokenError (401). Failing to
 * obtain the keys is not the token's fault: KeySetUnavailableError (503).
 */
import { createRemoteJWKSet, errors as joseErrors, type JWTVerifyGetKey, jwtVerify } from 'jose';
import * as z from 'zod';

import { baseHeaders } from '../../http.js';
import { parseScopeString, type Scope } from '../../scopes.js';

export const ALLOWED_ALGORITHMS = ['RS256'];
export const ACCESS_TOKEN_TYP = 'at+jwt';
const CLOCK_TOLERANCE_SECONDS = 30;
/** BugSecure access tokens live 10 minutes; anything older than this is refused whatever its `exp`. */
export const MAX_TOKEN_AGE = '15m';

const ClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  iat: z.number(),
  jti: z.string().min(1).max(256),
  client_id: z.string().min(1),
  scope: z.string().default(''),
  grant_id: z.string().optional(),
});

export interface VerifiedAccessToken {
  readonly token: string;
  readonly subject: string;
  readonly clientId: string;
  readonly jti: string;
  readonly grantId: string | undefined;
  readonly scopes: ReadonlySet<Scope>;
  /** Seconds since the epoch. */
  readonly expiresAt: number;
}

export class InvalidTokenError extends Error {
  override readonly name = 'InvalidTokenError';
}

/**
 * The signing keys could not be obtained (key endpoint down, slow, answering
 * something that is not a key set): the token was never judged. Deliberately
 * NOT an InvalidTokenError: the HTTP layer answers 503, so clients keep a token
 * that is most likely fine instead of discarding it on `invalid_token`.
 * `code` repeats the underlying machine code (e.g. `ERR_JWKS_TIMEOUT`) for the
 * logs; the message is fixed and the cause is never sent to a client.
 */
export class KeySetUnavailableError extends Error {
  override readonly name = 'KeySetUnavailableError';
  readonly code: string;

  constructor(cause: unknown) {
    super('signing keys are unavailable', { cause });
    const code = cause instanceof Error ? (cause as { code?: unknown }).code : undefined;
    this.code = typeof code === 'string' ? code : 'ERR_KEY_SET_UNAVAILABLE';
  }
}

/**
 * Tells "the keys could not be obtained" from "this token is bad" by WHERE the
 * error was thrown, not by its text. jose (6.x) reports a key endpoint that
 * answers non-200 or non-JSON as a bare `JOSEError` (`ERR_JOSE_GENERIC`, no
 * class of its own), a hanging one as `JWKSTimeout`, a malformed set as
 * `JWKSInvalid`, a refused connection as fetch's `TypeError`: no list of
 * classes or messages covers them all, or the ones a later version adds. But
 * all of them, and only them, come out of the key resolver, which jose calls
 * after it has parsed the header and applied the algorithm allowlist and before
 * it checks the signature and the claims. So whatever the resolver throws is a
 * key-set failure, except the two errors by which a key set that WAS read says
 * the token names no key of it (unknown or ambiguous `kid`): those stay token
 * faults. When the refetch jose does for an unknown `kid` fails, the fetch
 * error is what comes out, hence 503, not 401.
 *
 * Either way the request is refused: this only chooses between 401 and 503.
 */
const tagKeySetFailures = (keys: JWTVerifyGetKey): JWTVerifyGetKey => {
  return async (protectedHeader, token) => {
    try {
      return await keys(protectedHeader, token);
    } catch (error) {
      if (
        error instanceof joseErrors.JWKSNoMatchingKey ||
        error instanceof joseErrors.JWKSMultipleMatchingKeys
      ) {
        throw error;
      }
      throw new KeySetUnavailableError(error);
    }
  };
};

export interface AccessTokenVerifierOptions {
  readonly issuer: string;
  /** This server's canonical resource URI; the only accepted audience. */
  readonly audience: string;
  /** A jose key resolver; defaults to a remote JWKS with caching. */
  readonly keys: JWTVerifyGetKey;
}

export type AccessTokenVerifier = (token: string) => Promise<VerifiedAccessToken>;

/** Remote JWKS: fetched lazily, cached, refetched on unknown `kid` (rate-limited by jose). */
export const remoteJwks = (jwksUrl: string): JWTVerifyGetKey => {
  return createRemoteJWKSet(new URL(jwksUrl), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    headers: baseHeaders(),
  });
};

export const createAccessTokenVerifier = (options: AccessTokenVerifierOptions): AccessTokenVerifier => {
  const keys = tagKeySetFailures(options.keys);
  return async (token) => {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: options.issuer,
        audience: options.audience,
        typ: ACCESS_TOKEN_TYP,
        algorithms: ALLOWED_ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        maxTokenAge: MAX_TOKEN_AGE,
        requiredClaims: ['iss', 'sub', 'aud', 'exp', 'iat', 'jti', 'client_id'],
      }));
    } catch (error) {
      // Key-set failures were tagged in the resolver (KeySetUnavailableError, not a JOSEError) and
      // fall through; every JOSEError left is jose judging the token itself.
      if (error instanceof joseErrors.JOSEError) {
        // jose's messages name the failed check (e.g. `"aud" claim check failed`) and never echo the token.
        throw new InvalidTokenError(
          error.code === 'ERR_JWT_EXPIRED' ? 'token expired' : 'token failed validation',
          {
            cause: error,
          },
        );
      }
      throw error;
    }
    const claims = ClaimsSchema.safeParse(payload);
    if (!claims.success) throw new InvalidTokenError('token claims are malformed');
    const c = claims.data;
    // Tokens are issued for exactly one resource; a multi-audience token is not ours alone.
    const audiences = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (audiences.length !== 1 || audiences[0] !== options.audience) {
      throw new InvalidTokenError('token audience is not exclusively this server');
    }
    return {
      token,
      subject: c.sub,
      clientId: c.client_id,
      jti: c.jti,
      grantId: c.grant_id,
      scopes: parseScopeString(c.scope),
      expiresAt: c.exp,
    };
  };
};
