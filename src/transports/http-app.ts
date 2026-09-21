/**
 * Hosted mode: MCP over Streamable HTTP (spec 2026-07-28), stateless, as an
 * OAuth 2.1 protected resource. Written against web-standard Request/Response
 * so it is unit-testable without sockets; ./http-server.ts adapts it to Node.
 *
 * Request pipeline for the MCP endpoint. Everything up to the token check
 * looks at headers only — an unauthenticated caller never gets its body read:
 *
 *   Host allowlist (DNS rebinding) → Origin allowlist (browsers, exact
 *   scheme + host + port; 403) →
 *   CORS preflight → POST only (GET/DELETE: 405) → Bearer token (401 +
 *   WWW-Authenticate resource_metadata) → JWT validation (401) → token not
 *   already refused by the authorization server's exchange (401) → body read
 *   once, size-capped (413) and parsed once (400) → per-tool scope step-up
 *   (403 insufficient_scope, user-side scopes only) → SDK handler, with a
 *   fresh McpServer for this caller (and the parsed body, so the SDK does not
 *   parse it again).
 */
import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';

import type { HostedConfig } from '../config.js';
import { deriveKey } from '../crypto.js';
import { BugSecureError } from '../errors.js';
import { createGraphQLClient } from '../graphql/client.js';
import { type FetchFn, readTextCapped, ResponseTooLargeError } from '../http.js';
import type { Logger } from '../logger.js';
import { RateLimiter } from '../rate-limit.js';
import { HOSTED_INITIAL_SCOPES, NO_STEP_UP_SCOPES, type Scope } from '../scopes.js';
import { ApprovalGate, ApprovalReplayGuard } from '../tools/approval.js';
import { type AnyTool, isWriteTool } from '../tools/define-tool.js';
import { ALL_TOOLS } from '../tools/index.js';
import { buildServer } from '../server.js';
import { type AccessTokenVerifier, InvalidTokenError, type VerifiedAccessToken } from '../auth/hosted/jwt.js';
import {
  buildProtectedResourceMetadata,
  protectedResourceMetadataUrl,
  wwwAuthenticate,
} from '../auth/hosted/resource-metadata.js';
import { exchangedTokenProvider, type TokenExchanger } from '../auth/hosted/token-exchange.js';

export interface HttpAppOptions {
  readonly config: HostedConfig;
  readonly verifyAccessToken: AccessTokenVerifier;
  readonly exchanger: TokenExchanger;
  readonly logger: Logger;
  readonly tools?: readonly AnyTool[];
  /** Outbound fetch for GraphQL (tests). */
  readonly fetch?: FetchFn;
  /** Clock for the rate limiter (tests). */
  readonly now?: () => number;
}

export interface HttpApp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

const CORS_ALLOW_HEADERS = 'authorization, content-type, accept, mcp-protocol-version, mcp-method, mcp-name';
const CORS_EXPOSE_HEADERS = 'www-authenticate, mcp-protocol-version';

const TOKEN_REFUSED = 'token is no longer accepted by the authorization server';

const isJsonResponse = (response: Response): boolean => {
  return /^application\/json\b/i.test(response.headers.get('content-type') ?? '');
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
};

export type BearerCredentials =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'token'; readonly token: string };

/** Parse `Authorization: Bearer <b64token>` (RFC 6750 §2.1). The header is the only accepted location. */
export const bearerToken = (header: string | null): BearerCredentials => {
  if (header === null) return { kind: 'missing' };
  const token = /^Bearer[ ]+([A-Za-z0-9\-._~+/]+=*)[ ]*$/i.exec(header)?.[1];
  return token === undefined ? { kind: 'malformed' } : { kind: 'token', token };
};

interface JsonRpcCall {
  readonly method?: unknown;
  readonly params?: { readonly name?: unknown } | undefined;
}

/** Tool names this request calls (handles 2025-era batches too). Never throws. */
export const calledToolNames = (body: unknown): string[] => {
  const messages = Array.isArray(body) ? (body as unknown[]) : [body];
  const names: string[] = [];
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) continue;
    const call = m as JsonRpcCall;
    if (call.method === 'tools/call' && typeof call.params?.name === 'string') names.push(call.params.name);
  }
  return names;
};

/** The approval and rate-limit principal: one user, through one client. */
const principalOf = (subject: VerifiedAccessToken): string => {
  return JSON.stringify([subject.subject, subject.clientId]);
};

/**
 * 403 unless the request's `Origin` (when present: browsers) is exactly one of
 * `allowed` — scheme, host and port, not the hostname alone, so
 * `http://app.example` or `https://app.example:8443` cannot pass for
 * `https://app.example`. Requests without Origin (non-browser clients) pass.
 */
export const originRejection = (request: Request, allowed: readonly string[]): Response | undefined => {
  const origin = request.headers.get('origin');
  if (origin === null) return undefined;
  let normalised: string | undefined;
  try {
    const url = new URL(origin);
    normalised = url.origin === 'null' ? undefined : url.origin;
  } catch {
    normalised = undefined;
  }
  if (normalised !== undefined && normalised === origin.toLowerCase() && allowed.includes(normalised)) {
    return undefined;
  }
  return json(403, { jsonrpc: '2.0', error: { code: -32000, message: 'Origin not allowed' }, id: null });
};

export const createHttpApp = (options: HttpAppOptions): HttpApp => {
  const { config, logger } = options;
  const tools = options.tools ?? ALL_TOOLS;
  const resourceUrl = new URL(config.resource);
  const mcpPath = resourceUrl.pathname === '' ? '/' : resourceUrl.pathname;
  const metadataUrl = protectedResourceMetadataUrl(config.resource);
  // RFC 9728 §3.3: the document's `resource` must equal the resource the
  // well-known URL was derived from, so it is served ONLY at the URL derived
  // from our resource (path-suffixed when the resource has a path). Clients
  // find it from `resource_metadata` in every 401, or by that derivation.
  const metadataPath = new URL(metadataUrl).pathname;
  // Scope minimization (spec: authorization § Scope Selection Strategy): the
  // metadata and the initial 401 advertise the default scopes only (the read
  // scopes and reports:write); other write scopes are requested on demand,
  // through the 403 step-up below.
  const metadata = buildProtectedResourceMetadata({
    resource: config.resource,
    issuer: config.issuer,
    scopes: HOSTED_INITIAL_SCOPES,
  });

  // Shared by every request this process serves.
  const approvalKey = deriveKey(config.approvalKey, 'mcp requestState v1');
  const replay = new ApprovalReplayGuard();
  const clock = options.now === undefined ? {} : { now: options.now };
  const { perMinute, burst, writesPerMinute, writeBurst, maxKeys } = config.rateLimit;
  // Per (user, client); per user whatever the client (a user can register many clients);
  // and a tighter per-user budget for write tools.
  const perClient = new RateLimiter({ perMinute, burst, maxKeys, ...clock });
  const perUser = new RateLimiter({ perMinute: perMinute * 2, burst: burst * 2, maxKeys, ...clock });
  const writes = new RateLimiter({ perMinute: writesPerMinute, burst: writeBurst, maxKeys, ...clock });
  const writeToolNames = new Set(tools.filter(isWriteTool).map((t) => t.name));

  // Verified tokens by AuthInfo identity: the SDK passes AuthInfo through to
  // the per-request factory untouched.
  const verified = new WeakMap<AuthInfo, VerifiedAccessToken>();

  const handler: McpHttpHandler = createMcpHandler(
    ({ authInfo }) => {
      const subject = authInfo ? verified.get(authInfo) : undefined;
      if (!subject) throw new Error('unauthenticated request reached the MCP handler'); // unreachable: gate below
      const principal = principalOf(subject);
      const callerLogger = logger.child({ client: subject.clientId });
      const graphql = createGraphQLClient({
        url: config.graphqlUrl,
        tokens: exchangedTokenProvider(options.exchanger, subject),
        timeoutMs: config.requestTimeoutMs,
        logger,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      return buildServer({
        mode: 'hosted',
        graphql,
        logger: callerLogger,
        grantedScopes: () => Promise.resolve(subject.scopes),
        viewerId: () => Promise.resolve(subject.subject),
        readOnly: config.readOnly,
        approvals: new ApprovalGate({ key: approvalKey, principal, replay, logger: callerLogger }),
        rateLimit: (toolName) => {
          const user = JSON.stringify([subject.subject]);
          const checks = [
            { decision: perClient.take(principal), what: 'from this connection' },
            { decision: perUser.take(user), what: 'for this account' },
            ...(writeToolNames.has(toolName)
              ? [{ decision: writes.take(user), what: 'that change data, for this account' }]
              : []),
          ];
          const refused = checks.find((c) => !c.decision.allowed);
          if (refused === undefined || refused.decision.allowed) return;
          callerLogger.warn('tool call rate limited', { tool: toolName });
          throw new BugSecureError(
            'RATE_LIMITED',
            `Too many BugSecure tool calls ${refused.what}. Try again in ${String(refused.decision.retryAfterSeconds)} seconds.`,
          );
        },
        tools,
      });
    },
    {
      // Stateless per request; 2025-era clients are served statelessly too.
      legacy: 'stateless',
      onerror: (error) => {
        logger.warn('mcp handler error', { error });
      },
    },
  );

  const corsHeaders = (request: Request): Record<string, string> => {
    const origin = request.headers.get('origin');
    // Only reached for origins that passed the allowlist; echo exactly, never '*'.
    if (origin === null) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-expose-headers': CORS_EXPOSE_HEADERS,
      vary: 'Origin',
    };
  };

  const unauthorized = (
    request: Request,
    error?: 'invalid_token' | 'invalid_request',
    description?: string,
  ): Response => {
    return json(
      401,
      {
        error: error ?? 'unauthorized',
        ...(description === undefined ? {} : { error_description: description }),
      },
      {
        'www-authenticate': wwwAuthenticate({
          resourceMetadataUrl: metadataUrl,
          scopes: HOSTED_INITIAL_SCOPES,
          ...(error === undefined ? {} : { error }),
          ...(description === undefined ? {} : { errorDescription: description }),
        }),
        ...corsHeaders(request),
      },
    );
  };

  const serveMetadata = (request: Request): Response => {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json(405, { error: 'method_not_allowed' }, { allow: 'GET, OPTIONS', ...cors });
    }
    // Public, non-sensitive discovery document: cacheable, readable cross-origin.
    return json(200, metadata, { 'cache-control': 'public, max-age=3600', ...cors });
  };

  /**
   * Step-up (spec: authorization § Runtime Insufficient Scope Errors): a call
   * to a tool the token's scopes do not cover gets 403 insufficient_scope. The
   * challenge names the scopes already granted PLUS the missing ones, so a
   * client that re-authorizes with exactly that set keeps what it had.
   *
   * Never for a scope only some accounts can hold (`NO_STEP_UP_SCOPES`: the
   * organisation-side `triage:*` and `grade:write`, and the researcher-only
   * `profile:write` and `disclosures:write`). The authorization server silently
   * drops those for an ineligible account, so a step-up would send it round the
   * consent screen for ever. A call missing only those reaches the tool, whose
   * error explains who is eligible. Researchers get their two on first
   * connection instead (`HOSTED_INITIAL_SCOPES`).
   *
   * Unknown tools, and write tools on a read-only deployment, fall through to
   * the SDK's ordinary "tool not found" error.
   */
  const stepUp = (request: Request, body: unknown, subject: VerifiedAccessToken): Response | undefined => {
    for (const name of calledToolNames(body)) {
      const tool = tools.find((t) => t.name === name);
      if (!tool || (config.readOnly && isWriteTool(tool))) continue;
      const missing: Scope[] = tool.requiredScopes.filter(
        (s) => !subject.scopes.has(s) && !NO_STEP_UP_SCOPES.has(s),
      );
      if (missing.length === 0) continue;
      const description = `The ${name} tool requires additional permissions`;
      logger.info('scope step-up', { tool: name, client: subject.clientId });
      return json(
        403,
        { error: 'insufficient_scope', error_description: description },
        {
          'www-authenticate': wwwAuthenticate({
            resourceMetadataUrl: metadataUrl,
            scopes: [...subject.scopes, ...missing],
            error: 'insufficient_scope',
            errorDescription: description,
          }),
          ...corsHeaders(request),
        },
      );
    }
    return undefined;
  };

  const serveMcp = async (request: Request): Promise<Response> => {
    const hostRejected = hostHeaderValidationResponse(request, [...config.allowedHosts]);
    if (hostRejected) return hostRejected;
    // Requests from browsers carry Origin; only allowlisted origins may talk to us.
    const originRejected = originRejection(request, config.allowedOrigins);
    if (originRejected) return originRejected;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request),
          'access-control-allow-methods': 'POST, OPTIONS',
          'access-control-allow-headers': CORS_ALLOW_HEADERS,
          'access-control-max-age': '600',
        },
      });
    }
    if (request.method !== 'POST') {
      return json(405, { error: 'method_not_allowed' }, { allow: 'POST, OPTIONS', ...corsHeaders(request) });
    }

    const credentials = bearerToken(request.headers.get('authorization'));
    if (credentials.kind === 'missing') return unauthorized(request);
    if (credentials.kind === 'malformed')
      return unauthorized(request, 'invalid_request', 'Malformed Authorization header');

    let subject: VerifiedAccessToken;
    try {
      subject = await options.verifyAccessToken(credentials.token);
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        logger.info('rejected access token', { why: error.message });
        return unauthorized(request, 'invalid_token', error.message);
      }
      logger.error('token verification failed', { error });
      return json(503, { error: 'temporarily_unavailable' }, { 'retry-after': '5', ...corsHeaders(request) });
    }

    // The AS already refused to exchange this token (revoked grant, or signed
    // with a key the AS no longer has but our JWKS cache still trusts): it is
    // dead, and a 401 is what makes the client refresh it.
    if (options.exchanger.isRefused(subject)) {
      logger.info('rejected access token', { why: TOKEN_REFUSED });
      return unauthorized(request, 'invalid_token', TOKEN_REFUSED);
    }

    // Authenticated: now, and only now, read the body — once, capped, and parse it once.
    let body: unknown;
    try {
      body = JSON.parse(await readTextCapped(request, config.maxBodyBytes)) as unknown;
    } catch (error) {
      if (error instanceof ResponseTooLargeError) {
        return json(413, { error: 'payload_too_large' }, corsHeaders(request));
      }
      if (error instanceof SyntaxError) {
        return json(
          400,
          { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
          corsHeaders(request),
        );
      }
      throw error; // e.g. the client went away mid-body: the Node adapter handles it
    }

    const challenge = stepUp(request, body, subject);
    if (challenge) return challenge;

    const authInfo: AuthInfo = {
      token: subject.token,
      clientId: subject.clientId,
      scopes: [...subject.scopes],
      expiresAt: subject.expiresAt,
      resource: resourceUrl,
    };
    verified.set(authInfo, subject);

    const response = await handler.fetch(request, { authInfo, parsedBody: body });
    // The AS refused to exchange the token while this request was served, so
    // the tool call ended in a dead-session error. While the answer is still a
    // plain JSON body (nothing streamed to the client yet), replace it with the
    // 401 that makes the client refresh its token and retry, instead of
    // showing the user an error it would recover from by itself. An SSE answer
    // is already on its way; the client's next request gets the 401 above.
    if (options.exchanger.isRefused(subject) && isJsonResponse(response)) {
      await response.body?.cancel();
      logger.info('rejected access token', { why: TOKEN_REFUSED });
      return unauthorized(request, 'invalid_token', TOKEN_REFUSED);
    }
    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(corsHeaders(request))) headers.set(k, v);
    headers.set('cache-control', 'no-store');
    headers.set('x-content-type-options', 'nosniff');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };

  return {
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/healthz') return json(200, { status: 'ok' });
      if (pathname === metadataPath) return serveMetadata(request);
      if (pathname === mcpPath) return serveMcp(request);
      return json(404, { error: 'not_found' });
    },
    close: () => handler.close(),
  };
};
