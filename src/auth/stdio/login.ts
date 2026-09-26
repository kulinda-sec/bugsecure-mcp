/**
 * `bugsecure-mcp login`: OAuth 2.1 authorization code flow with PKCE for a
 * native app (RFC 8252), as the public client `bugsecure-mcp-cli`.
 *
 *   1. Discover and validate the authorization server metadata (RFC 8414),
 *      recording its `issuer` (RFC 9207 mix-up defence).
 *   2. Start the loopback receiver on 127.0.0.1:<ephemeral>.
 *   3. Send the user's browser to the authorization endpoint with PKCE S256,
 *      a random `state`, the requested scopes and `resource` = the API
 *      (RFC 8707 — the token is audience-bound to the API).
 *   4. Validate the redirect (state, iss), then redeem the code with the PKCE
 *      verifier and the same `resource`.
 *   5. Store the tokens, keyed by issuer.
 */
import type { LocalConfig } from '../../config.js';
import { createPkcePair, randomToken } from '../../crypto.js';
import type { FetchFn } from '../../http.js';
import { createLogger } from '../../logger.js';
import { formatScopes, type Scope } from '../../scopes.js';
import { discoverAuthorizationServer, OAuthRequestError, requestToken } from '../oauth.js';
import type { CredentialStore, StoredCredentials } from './credential-store.js';
import { startLoopbackReceiver } from './loopback.js';
import { withCredentialsLock } from './session.js';

export interface LoginOptions {
  readonly config: LocalConfig;
  readonly scopes: readonly Scope[];
  readonly store: CredentialStore;
  /** Directory for the credentials lock file (the save is serialised with refreshes). */
  readonly lockDir: string;
  /** Show the authorization URL to the user (stderr) and try to open a browser. */
  readonly presentUrl: (url: string) => Promise<void>;
  readonly fetch?: FetchFn;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export const buildAuthorizationUrl = (
  authorizationEndpoint: string,
  params: {
    clientId: string;
    redirectUri: string;
    scope: string;
    state: string;
    codeChallenge: string;
    resource: string;
  },
): string => {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', params.scope);
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', params.resource);
  return url.href;
};

export const login = async (options: LoginOptions): Promise<StoredCredentials> => {
  const { config } = options;
  const now = options.now ?? (() => Date.now());
  const fetchOptions = options.fetch === undefined ? {} : { fetch: options.fetch };
  if (options.scopes.length === 0)
    throw new OAuthRequestError('invalid_scope', 'Request at least one scope.');

  const metadata = await discoverAuthorizationServer(config.issuer, {
    ...fetchOptions,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const pkce = createPkcePair();
  const state = randomToken(32);
  const scope = formatScopes(options.scopes);

  const receiver = await startLoopbackReceiver({
    expectedState: state,
    expectedIssuer: metadata.issuer,
    issParameterSupported: metadata.authorization_response_iss_parameter_supported === true,
    timeoutMs: options.timeoutMs ?? 5 * 60_000,
    signal: options.signal,
  });

  let code: string;
  try {
    await options.presentUrl(
      buildAuthorizationUrl(metadata.authorization_endpoint, {
        clientId: config.clientId,
        redirectUri: receiver.redirectUri,
        scope,
        state,
        codeChallenge: pkce.challenge,
        resource: config.apiUrl,
      }),
    );
    code = await receiver.code;
  } finally {
    await receiver.close();
  }

  const issuedAt = Math.floor(now() / 1000);
  const tokens = await requestToken(
    metadata.token_endpoint,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: receiver.redirectUri,
      client_id: config.clientId,
      code_verifier: pkce.verifier,
      resource: config.apiUrl,
    },
    { ...fetchOptions, signal: options.signal },
  );

  const credentials: StoredCredentials = {
    version: 1,
    issuer: metadata.issuer,
    clientId: config.clientId,
    resource: config.apiUrl,
    tokenEndpoint: metadata.token_endpoint,
    ...(metadata.revocation_endpoint === undefined
      ? {}
      : { revocationEndpoint: metadata.revocation_endpoint }),
    accessToken: tokens.access_token,
    accessTokenExpiresAt: issuedAt + (tokens.expires_in ?? 300),
    ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
    // RFC 6749 §5.1: if `scope` is omitted the granted scope equals the requested one.
    scope: tokens.scope ?? scope,
    obtainedAt: issuedAt,
  };
  // Under the lock: a refresh in another process can then neither interleave
  // with this save nor overwrite it afterwards (it re-reads under the lock).
  await withCredentialsLock(options.lockDir, () => options.store.save(credentials), {
    logger: createLogger({ level: options.config.logLevel }),
  });
  return credentials;
};
