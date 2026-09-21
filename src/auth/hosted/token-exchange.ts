/**
 * Hosted mode never forwards the client's token to the API (that would be
 * token passthrough, forbidden by the MCP authorization spec): the client's
 * token is audience-bound to this MCP server and the API rejects it anyway.
 *
 * Instead, as the confidential client `bugsecure-mcp-hosted`, this server
 * exchanges it (RFC 8693) for a token whose audience is the API — same user,
 * same grant, scopes ⊆ the original, lifetime ≤ the original.
 *
 * Results are cached per inbound token `jti` until 30 s before the exchanged
 * token (or the inbound one, whichever is sooner) expires, in a bounded LRU.
 * Concurrent requests for the same `jti` share one in-flight exchange.
 *
 * An inbound token the authorization server refuses to exchange (invalid_grant
 * / invalid_token: its grant was revoked, or it is signed with a key the AS no
 * longer has — which our JWKS cache can still trust for a while; invalid_scope:
 * none of its scopes is still available to the user) is dead. It is
 * remembered as refused until it expires, so later requests carrying it are
 * answered 401 (see http-app) and the MCP client refreshes, instead of every
 * tool call failing and every call asking the AS again.
 */
import { BugSecureError } from '../../errors.js';
import type { AccessTokenProvider } from '../../graphql/client.js';
import type { FetchFn } from '../../http.js';
import type { Logger } from '../../logger.js';
import { formatScopes } from '../../scopes.js';
import { OAuthRequestError, requestToken } from '../oauth.js';
import type { VerifiedAccessToken } from './jwt.js';
import { ExpiringLru } from '../../lru.js';

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
/** Stop using a cached token this many seconds before it expires. */
export const EXPIRY_MARGIN_SECONDS = 30;

export interface TokenExchangerOptions {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** RFC 8707 resource for the exchanged token: the API. */
  readonly apiResource: string;
  readonly cacheSize: number;
  readonly logger: Logger;
  readonly fetch?: FetchFn;
  readonly now?: () => number;
}

const abortReason = (signal: AbortSignal): Error => {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
};

/** Settle with `promise`, or reject as soon as `signal` aborts (without leaking a listener). */
const abortable = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T> => {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
};

const refusedError = (cause?: unknown): BugSecureError => {
  return new BugSecureError(
    'SESSION_EXPIRED',
    'The BugSecure authorization for this connection is no longer valid.',
    cause === undefined ? {} : { cause },
  );
};

/** Keyed by `jti`, scoped to the subject and client the AS bound it to. */
const cacheKey = (subject: VerifiedAccessToken): string => {
  return `${subject.clientId}\u0000${subject.subject}\u0000${subject.jti}`;
};

export class TokenExchanger {
  readonly #options: TokenExchangerOptions;
  readonly #cache: ExpiringLru<string, string>;
  readonly #refused: ExpiringLru<string, true>;
  readonly #inflight = new Map<string, Promise<string>>();
  readonly #now: () => number;

  constructor(options: TokenExchangerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#cache = new ExpiringLru(options.cacheSize, this.#now);
    this.#refused = new ExpiringLru(options.cacheSize, this.#now);
  }

  /** An API access token for the user behind `subject`. */
  async exchange(subject: VerifiedAccessToken, signal?: AbortSignal): Promise<string> {
    const key = cacheKey(subject);
    if (this.#refused.get(key) === true) throw refusedError();
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    let pending = this.#inflight.get(key);
    if (!pending) {
      pending = this.#doExchange(subject, key).finally(() => this.#inflight.delete(key));
      this.#inflight.set(key, pending);
    }
    // Honour the caller's cancellation without cancelling the shared exchange.
    return signal ? abortable(pending, signal) : pending;
  }

  /** Forget the exchanged token for `subject` (the API rejected it), so the next call re-exchanges. */
  invalidate(subject: VerifiedAccessToken): void {
    this.#cache.delete(cacheKey(subject));
  }

  /** Has the authorization server refused to exchange this inbound token? */
  isRefused(subject: VerifiedAccessToken): boolean {
    return this.#refused.get(cacheKey(subject)) === true;
  }

  async #doExchange(subject: VerifiedAccessToken, key: string): Promise<string> {
    const { logger } = this.#options;
    const nowSeconds = Math.floor(this.#now() / 1000);
    // An inbound token carrying no scope this server knows cannot be exchanged
    // for anything useful, and an empty `scope` would leave the choice to the
    // authorization server: refuse instead of asking.
    const requested = formatScopes(subject.scopes);
    if (requested === '') {
      logger.info('token exchange skipped: no known scope on the inbound token');
      throw new BugSecureError(
        'INSUFFICIENT_SCOPE',
        'This connection was granted no BugSecure permission this server can use.',
        { requiredScopes: [] },
      );
    }
    let response;
    try {
      response = await requestToken(
        this.#options.tokenEndpoint,
        {
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: subject.token,
          subject_token_type: ACCESS_TOKEN_TYPE,
          requested_token_type: ACCESS_TOKEN_TYPE,
          resource: this.#options.apiResource,
          scope: requested,
        },
        {
          clientSecretBasic: { clientId: this.#options.clientId, clientSecret: this.#options.clientSecret },
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        },
      );
    } catch (error) {
      if (
        error instanceof OAuthRequestError &&
        (error.error === 'invalid_grant' ||
          error.error === 'invalid_token' ||
          error.error === 'invalid_scope')
      ) {
        logger.info('token exchange refused', { error: error.error });
        this.#cache.delete(key);
        this.#refused.set(key, true, subject.expiresAt * 1000);
        throw refusedError(error);
      }
      logger.error('token exchange failed', {
        error: error instanceof OAuthRequestError ? error.error : 'unknown',
      });
      throw new BugSecureError(
        'UPSTREAM_UNAVAILABLE',
        'Could not obtain BugSecure API access for this connection.',
        {
          cause: error,
        },
      );
    }
    if (response.issued_token_type !== undefined && response.issued_token_type !== ACCESS_TOKEN_TYPE) {
      throw new BugSecureError('UPSTREAM_ERROR', 'The authorization server issued an unexpected token type.');
    }
    // RFC 8693 §2.2.1: `scope` is present when it differs from the request. It
    // may narrow (a scope no longer available to the user), never widen.
    if (response.scope !== undefined) {
      const issued = response.scope.split(/\s+/).filter((s) => s !== '');
      const asked = new Set(requested.split(' '));
      if (issued.some((s) => !asked.has(s))) {
        logger.error('token exchange returned scopes that were not requested');
        throw new BugSecureError(
          'UPSTREAM_ERROR',
          'The authorization server issued broader access than requested; refusing to use it.',
        );
      }
    }

    const exchangedExpiry = nowSeconds + (response.expires_in ?? 60);
    const usableUntil = Math.min(exchangedExpiry, subject.expiresAt) - EXPIRY_MARGIN_SECONDS;
    this.#cache.set(key, response.access_token, usableUntil * 1000);
    return response.access_token;
  }
}

/** Adapts the exchanger to the GraphQL client's token provider interface for one request. */
export const exchangedTokenProvider = (
  exchanger: TokenExchanger,
  subject: VerifiedAccessToken,
): AccessTokenProvider => {
  return {
    getAccessToken: (signal) => exchanger.exchange(subject, signal),
    invalidate: () => {
      exchanger.invalidate(subject);
    },
  };
};
