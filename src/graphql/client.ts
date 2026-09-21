/**
 * A tiny GraphQL-over-HTTP client for the BugSecure API.
 *
 * - Native `fetch`, JSON POST, one request per call (no batching, no cache).
 * - Documents are codegen'd `TypedDocumentString`s: the query text and its
 *   result/variables types travel together, so a tool cannot send variables
 *   of the wrong shape or misread the result.
 * - Every request has a timeout and a response-size cap, and honours the
 *   caller's AbortSignal (MCP cancellation).
 * - Errors become actionable BugSecureErrors (see ./errors.ts); upstream
 *   internals are never relayed.
 * - When the API rejects the access token (HTTP 401, or HTTP 200 with a
 *   GraphQL `UNAUTHENTICATED` error, which is how the BugSecure API reports
 *   it) the token is invalidated and the request retried once with a fresh
 *   one. That covers a token revoked, or signed with a key the API no longer
 *   has, between our expiry check and use. A second rejection is
 *   SESSION_EXPIRED: never a loop.
 */
import * as z from 'zod';

import { BugSecureError } from '../errors.js';
import {
  baseHeaders,
  DEFAULT_MAX_RESPONSE_BYTES,
  type FetchFn,
  mapNetworkError,
  readTextCapped,
  withTimeout,
} from '../http.js';
import { type Logger, silentLogger } from '../logger.js';
import { GraphQLErrorSchema, mapGraphQLErrors } from './errors.js';

/** Structural type of a codegen'd document (see generated.ts `TypedDocumentString`). */
export interface TypedDocument<TResult, TVariables> {
  __apiType?: (variables: TVariables) => TResult;
  toString(): string;
}

export type ResultOf<D> = D extends TypedDocument<infer R, unknown> ? R : never;
export type VariablesOf<D> = D extends TypedDocument<unknown, infer V> ? V : never;

/** Supplies API access tokens (stdio: from the keychain; hosted: via token exchange). */
export interface AccessTokenProvider {
  getAccessToken(signal?: AbortSignal): Promise<string>;
  /**
   * Called when the API rejected `token` (HTTP 401 or GraphQL UNAUTHENTICATED),
   * so the provider stops handing it out: the next `getAccessToken` must mint
   * a new one (refresh / re-exchange) rather than return it again.
   */
  invalidate(token: string): void;
}

export interface RequestOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface GraphQLClient {
  request<TResult, TVariables>(
    document: TypedDocument<TResult, TVariables>,
    variables: TVariables,
    options?: RequestOptions,
  ): Promise<TResult>;
}

export interface GraphQLClientOptions {
  readonly url: string;
  readonly tokens: AccessTokenProvider;
  readonly timeoutMs: number;
  readonly fetch?: FetchFn;
  readonly logger?: Logger;
  readonly maxResponseBytes?: number;
}

const ResponseSchema = z.object({
  data: z.unknown().optional(),
  errors: z.array(GraphQLErrorSchema).optional(),
});

/** Sentinel: the API refused the access token (see `attempt`). */
const REJECTED: unique symbol = Symbol('rejected');

const operationName = (query: string): string | undefined => {
  return /\b(?:query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/.exec(query)?.[1];
};

export const createGraphQLClient = (options: GraphQLClientOptions): GraphQLClient => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? silentLogger;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  const send = async (
    query: string,
    variables: unknown,
    token: string,
    signal: AbortSignal | undefined,
  ): Promise<Response> => {
    try {
      return await fetchFn(options.url, {
        method: 'POST',
        headers: baseHeaders({
          'content-type': 'application/json',
          accept: 'application/graphql-response+json, application/json;q=0.9',
          authorization: `Bearer ${token}`,
        }),
        body: JSON.stringify({ query, variables, operationName: operationName(query) }),
        signal: withTimeout(signal, options.timeoutMs),
        redirect: 'error', // never replay a bearer token to another location
      });
    } catch (error) {
      return mapNetworkError(error, signal, 'The BugSecure API');
    }
  };

  /**
   * One round trip. Resolves to the response `data`, or to REJECTED when the
   * API refused the access token itself — as HTTP 401, or the way the GraphQL
   * API reports it: HTTP 200 with an `UNAUTHENTICATED` error. Anything else
   * becomes a BugSecureError.
   */
  const attempt = async (
    query: string,
    variables: unknown,
    token: string,
    op: string,
    signal: AbortSignal | undefined,
  ): Promise<unknown> => {
    const started = performance.now();
    const response = await send(query, variables, token, signal);
    if (response.status === 401) {
      await response.body?.cancel();
      logger.debug('graphql', { op, status: 401, ms: Math.round(performance.now() - started) });
      return REJECTED;
    }

    let text: string;
    try {
      text = await readTextCapped(response, maxBytes);
    } catch (error) {
      return mapNetworkError(error, signal, 'The BugSecure API');
    }
    logger.debug('graphql', { op, status: response.status, ms: Math.round(performance.now() - started) });

    if (response.status === 429) {
      throw new BugSecureError('RATE_LIMITED', 'The BugSecure API is rate limiting these requests.');
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new BugSecureError(
        response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_ERROR',
        `The BugSecure API returned an unreadable response (HTTP ${response.status}).`,
      );
    }
    const parsed = ResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new BugSecureError(
        'UPSTREAM_ERROR',
        `The BugSecure API returned an unexpected response (HTTP ${response.status}).`,
      );
    }
    const { data, errors } = parsed.data;
    if (errors && errors.length > 0) {
      if (errors.some((e) => e.extensions?.code === 'UNAUTHENTICATED')) return REJECTED;
      const mapped = mapGraphQLErrors(errors);
      logger.info('graphql error', { op, errorCode: mapped.code });
      throw mapped;
    }
    if (!response.ok || data === null || data === undefined) {
      throw new BugSecureError(
        response.status >= 500 ? 'UPSTREAM_UNAVAILABLE' : 'UPSTREAM_ERROR',
        `The BugSecure API request failed (HTTP ${response.status}).`,
      );
    }
    return data;
  };

  return {
    async request<TResult, TVariables>(
      document: TypedDocument<TResult, TVariables>,
      variables: TVariables,
      requestOptions: RequestOptions = {},
    ): Promise<TResult> {
      const query = document.toString();
      const op = operationName(query) ?? 'anonymous';
      const { signal } = requestOptions;

      // A rejected token is invalidated and the request retried ONCE with a
      // fresh one (stdio: refreshed; hosted: re-exchanged). The API refuses a
      // token in its auth guard, before the resolver runs, so retrying one of
      // the single-operation documents the tools send does not repeat a write.
      let token = await options.tokens.getAccessToken(signal);
      let data = await attempt(query, variables, token, op, signal);
      if (data === REJECTED) {
        options.tokens.invalidate(token);
        logger.info('access token rejected; retrying once with a fresh one', { op });
        token = await options.tokens.getAccessToken(signal);
        data = await attempt(query, variables, token, op, signal);
      }
      if (data === REJECTED) {
        options.tokens.invalidate(token);
        logger.info('graphql error', { op, errorCode: 'SESSION_EXPIRED' });
        throw new BugSecureError('SESSION_EXPIRED', 'The BugSecure session is no longer valid.');
      }
      // Shape is guaranteed by the operation + schema codegen; tools validate
      // their own output against their outputSchema before returning it.
      return data as TResult;
    },
  };
};
