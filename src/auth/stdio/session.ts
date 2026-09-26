/**
 * The stdio server's access to the API: the stored login, refreshed on demand.
 *
 * - Never prompts: stdout is the MCP channel and there is nobody to answer.
 *   Without a login, tools fail with an actionable "run login" message.
 * - Refreshes 60 s before expiry, under a cross-process file lock so that
 *   several processes sharing one login never replay a rotated refresh token.
 * - Stores the rotated refresh token before handing out the new access token.
 */
import { join } from 'node:path';

import { BugSecureError } from '../../errors.js';
import type { AccessTokenProvider } from '../../graphql/client.js';
import type { FetchFn } from '../../http.js';
import type { Logger } from '../../logger.js';
import { parseScopeString, type Scope } from '../../scopes.js';
import { OAuthRequestError, requestToken, revokeToken } from '../oauth.js';
import type { CredentialStore, StoredCredentials } from './credential-store.js';
import { type FileLockOptions, LockTimeoutError, withFileLock } from './file-lock.js';

/** Refresh when fewer than this many seconds of validity remain. */
export const REFRESH_SKEW_SECONDS = 60;

/** The lock serialising every change to the stored login (refresh, login, logout). */
export const credentialsLockPath = (configDir: string): string => {
  return join(configDir, 'credentials.lock');
};

/**
 * Run `fn` holding the credentials lock. A lock that cannot be obtained in time
 * becomes an actionable BugSecureError.
 */
export const withCredentialsLock = async <T>(
  configDir: string,
  fn: () => Promise<T>,
  options?: FileLockOptions,
): Promise<T> => {
  try {
    return await withFileLock(credentialsLockPath(configDir), fn, options);
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      throw new BugSecureError(
        'CREDENTIALS_BUSY',
        error.hint === undefined
          ? 'Another bugsecure-mcp process is updating the stored BugSecure login.'
          : error.message,
        { cause: error, ...(error.hint === undefined ? {} : { hint: error.hint }) },
      );
    }
    throw error;
  }
};

/**
 * Stored tokens are bound (RFC 8707) to the API they were issued for. Using
 * them against another API would fail at best and leak them at worst, so a
 * login made for a different `--api-url` is refused with a clear message.
 */
export const assertCredentialsFor = (stored: StoredCredentials, resource: string): StoredCredentials => {
  if (stored.resource !== resource) {
    throw new BugSecureError(
      'NOT_LOGGED_IN',
      `The stored BugSecure login is for ${stored.resource}, but this server is configured for ${resource}. ` +
        `Sign in for ${resource} (login --api-url ${resource}).`,
    );
  }
  return stored;
};

export interface LocalSessionOptions {
  readonly issuer: string;
  /** The API the tokens must be bound to (RFC 8707 resource). */
  readonly resource: string;
  readonly store: CredentialStore;
  /** Directory for the credentials lock file. */
  readonly lockDir: string;
  readonly logger: Logger;
  readonly fetch?: FetchFn;
  readonly now?: () => number;
}

export class LocalSession implements AccessTokenProvider {
  readonly #options: LocalSessionOptions;
  #cached: StoredCredentials | undefined;
  #refreshing: Promise<StoredCredentials> | undefined;

  constructor(options: LocalSessionOptions) {
    this.#options = options;
  }

  #nowSeconds(): number {
    return Math.floor((this.#options.now ?? Date.now)() / 1000);
  }

  #fresh(c: StoredCredentials): boolean {
    return c.accessTokenExpiresAt - this.#nowSeconds() > REFRESH_SKEW_SECONDS;
  }

  async #load(): Promise<StoredCredentials | undefined> {
    const stored = await this.#options.store.load(this.#options.issuer);
    this.#cached = stored && assertCredentialsFor(stored, this.#options.resource);
    return this.#cached;
  }

  /** Scopes of the stored login, or `undefined` when not logged in. */
  async grantedScopes(): Promise<ReadonlySet<Scope> | undefined> {
    const c = this.#cached ?? (await this.#load());
    return c ? parseScopeString(c.scope) : undefined;
  }

  /**
   * The signed-in user's id: the `sub` of the stored access token, decoded
   * (not verified — it is the token this process obtained itself, and the
   * API verifies it on every call). Only used to tell the user's own reports
   * from their organisations'; `undefined` when not logged in or opaque.
   */
  async subject(): Promise<string | undefined> {
    const c = this.#cached ?? (await this.#load());
    const sub = c === undefined ? undefined : decodeJwtPayload(c.accessToken)?.sub;
    return typeof sub === 'string' && sub !== '' ? sub : undefined;
  }

  async getAccessToken(): Promise<string> {
    let c = this.#cached ?? (await this.#load());
    if (!c) throw new BugSecureError('NOT_LOGGED_IN', 'bugsecure-mcp is not signed in to BugSecure.');
    if (!this.#fresh(c)) {
      // Coalesce concurrent callers in this process onto one refresh.
      this.#refreshing ??= this.#refresh().finally(() => {
        this.#refreshing = undefined;
      });
      c = await this.#refreshing;
    }
    return c.accessToken;
  }

  invalidate(token: string): void {
    if (this.#cached?.accessToken === token) this.#cached = { ...this.#cached, accessTokenExpiresAt: 0 };
  }

  async #refresh(): Promise<StoredCredentials> {
    const { store, issuer, logger } = this.#options;
    return withCredentialsLock(
      this.#options.lockDir,
      async () => {
        // Another process may have refreshed (or a new login completed) while we waited for the lock.
        const loaded = await store.load(issuer);
        if (!loaded)
          throw new BugSecureError('NOT_LOGGED_IN', 'bugsecure-mcp is not signed in to BugSecure.');
        const stored = assertCredentialsFor(loaded, this.#options.resource);
        if (this.#fresh(stored) && stored.accessToken !== this.#cached?.accessToken) {
          this.#cached = stored;
          return stored;
        }
        if (stored.refreshToken === undefined) {
          throw new BugSecureError('SESSION_EXPIRED', 'The BugSecure session has expired.');
        }

        const issuedAt = this.#nowSeconds();
        let tokens;
        try {
          tokens = await requestToken(
            stored.tokenEndpoint,
            {
              grant_type: 'refresh_token',
              refresh_token: stored.refreshToken,
              client_id: stored.clientId,
              resource: stored.resource,
            },
            this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch },
          );
        } catch (error) {
          if (
            error instanceof OAuthRequestError &&
            (error.error === 'invalid_grant' || error.error === 'invalid_scope')
          ) {
            // invalid_grant: revoked, expired, or reuse detected. invalid_scope: none of the
            // granted permissions is still available to the account (e.g. its organisation
            // turned AI triage access off, or it lost its seat). Either way the stored grant
            // is dead: remove it rather than retry it on every call.
            await store.delete(issuer);
            this.#cached = undefined;
            logger.warn('refresh token rejected; stored login removed', { error: error.error });
            throw new BugSecureError(
              'SESSION_EXPIRED',
              error.error === 'invalid_scope'
                ? 'The BugSecure session ended: the permissions it was granted are no longer available to this account.'
                : 'The BugSecure session has expired or was revoked.',
              {
                cause: error,
                ...(error.error === 'invalid_scope'
                  ? {
                      hint:
                        'Ask the user to sign in again (`login`), asking only for permissions their account can use: ' +
                        'organisation-side permissions (triage:*, grade:write) need a seat in an organisation that ' +
                        'still enables AI triage access / AI grading.',
                    }
                  : {}),
              },
            );
          }
          throw new BugSecureError('UPSTREAM_UNAVAILABLE', 'Could not refresh the BugSecure session.', {
            cause: error,
          });
        }

        const next: StoredCredentials = {
          ...stored,
          accessToken: tokens.access_token,
          accessTokenExpiresAt: issuedAt + (tokens.expires_in ?? 300),
          // Rotation: always keep the newest refresh token the AS gave us.
          ...(tokens.refresh_token === undefined ? {} : { refreshToken: tokens.refresh_token }),
          scope: tokens.scope ?? stored.scope,
          obtainedAt: issuedAt,
        };
        await store.save(next);
        this.#cached = next;
        logger.debug('access token refreshed');
        return next;
      },
      { logger },
    );
  }
}

export interface LogoutResult {
  readonly hadCredentials: boolean;
  readonly revoked: boolean;
}

/**
 * Revoke the grant at the authorization server (RFC 7009, via the refresh
 * token, which ends the whole grant) and delete local credentials. Local
 * deletion happens even if revocation fails.
 */
export const logout = async (options: {
  readonly issuer: string;
  readonly store: CredentialStore;
  /** Directory for the credentials lock file. */
  readonly lockDir: string;
  readonly logger: Logger;
  readonly fetch?: FetchFn;
}): Promise<LogoutResult> => {
  return withCredentialsLock(options.lockDir, () => logoutLocked(options), { logger: options.logger });
};

const logoutLocked = async (options: {
  readonly issuer: string;
  readonly store: CredentialStore;
  readonly logger: Logger;
  readonly fetch?: FetchFn;
}): Promise<LogoutResult> => {
  const stored = await options.store.load(options.issuer);
  if (!stored) return { hadCredentials: false, revoked: false };

  let revoked = false;
  if (stored.revocationEndpoint !== undefined) {
    const fetchOpt = options.fetch === undefined ? {} : { fetch: options.fetch };
    try {
      if (stored.refreshToken !== undefined) {
        await revokeToken(
          stored.revocationEndpoint,
          { token: stored.refreshToken, token_type_hint: 'refresh_token', client_id: stored.clientId },
          fetchOpt,
        );
      }
      await revokeToken(
        stored.revocationEndpoint,
        { token: stored.accessToken, token_type_hint: 'access_token', client_id: stored.clientId },
        fetchOpt,
      );
      revoked = true;
    } catch (error) {
      options.logger.warn('token revocation failed; removing local credentials anyway', { error });
    }
  }
  await options.store.delete(options.issuer);
  return { hadCredentials: true, revoked };
};

/** Decode (NOT verify) a JWT payload for display. Returns undefined for opaque tokens. */
export const decodeJwtPayload = (token: string): Record<string, unknown> | undefined => {
  const part = token.split('.')[1];
  if (part === undefined) return undefined;
  try {
    const payload: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};
