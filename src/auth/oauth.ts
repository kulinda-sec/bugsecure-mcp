/**
 * OAuth 2.1 client plumbing shared by the local (stdio) and hosted modes:
 * authorization-server metadata discovery (RFC 8414), token endpoint requests
 * (RFC 6749 §3.2, RFC 8693) and revocation (RFC 7009).
 */
import * as z from 'zod';

import {
  baseHeaders,
  cleanMessage,
  type FetchFn,
  LOOPBACK_HOSTS,
  readTextCapped,
  withTimeout,
} from '../http.js';

const MAX_OAUTH_RESPONSE_BYTES = 64 * 1024;

/** A failed OAuth request. `error` is the RFC 6749 §5.2 code, when there is one. */
export class OAuthRequestError extends Error {
  override readonly name = 'OAuthRequestError';
  readonly error: string;
  readonly status: number | undefined;

  constructor(error: string, message: string, status?: number, options?: ErrorOptions) {
    super(message, options);
    this.error = error;
    this.status = status;
  }
}

const endpointUrl = (what: string) => {
  return z.url({ protocol: /^https?$/ }).refine(
    (value) => {
      const u = new URL(value);
      return u.protocol === 'https:' || LOOPBACK_HOSTS.has(u.hostname);
    },
    { message: `${what} must use https` },
  );
};

export const AuthorizationServerMetadataSchema = z.looseObject({
  issuer: z.string(),
  authorization_endpoint: endpointUrl('authorization_endpoint'),
  token_endpoint: endpointUrl('token_endpoint'),
  revocation_endpoint: endpointUrl('revocation_endpoint').optional(),
  jwks_uri: endpointUrl('jwks_uri').optional(),
  scopes_supported: z.array(z.string()).optional(),
  grant_types_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadataSchema>;

/**
 * The well-known URLs to try for an issuer, in the order the MCP
 * authorization spec (2026-07-28, "Authorization Server Metadata Discovery")
 * prescribes: RFC 8414 path-insertion, then OpenID Connect path-insertion,
 * then OpenID Connect path-appending. For an issuer without a path the first
 * two collapse to the root well-known locations.
 */
export const metadataUrls = (issuer: string): string[] => {
  const u = new URL(issuer);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/+$/, '');
  if (path === '') {
    return [
      `${u.origin}/.well-known/oauth-authorization-server`,
      `${u.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
};

const getJson = async (
  url: string,
  fetchFn: FetchFn,
  signal: AbortSignal,
): Promise<{ status: number; json: unknown }> => {
  const response = await fetchFn(url, {
    headers: baseHeaders({ accept: 'application/json' }),
    signal,
    redirect: 'error',
  });
  const text = await readTextCapped(response, MAX_OAUTH_RESPONSE_BYTES);
  if (!response.ok) return { status: response.status, json: undefined };
  try {
    return { status: response.status, json: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, json: undefined };
  }
};

export interface DiscoveryOptions {
  readonly fetch?: FetchFn;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Fetch and validate the authorization server's metadata. Enforces:
 * - `issuer` in the document equals the issuer we asked about (RFC 8414 §3.3),
 *   compared as exact strings — the defence against mix-up attacks;
 * - PKCE `S256` is advertised (MCP clients MUST refuse to proceed otherwise).
 */
export const discoverAuthorizationServer = async (
  issuer: string,
  options: DiscoveryOptions = {},
): Promise<AuthorizationServerMetadata> => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  let lastStatus: number | undefined;
  for (const url of metadataUrls(issuer)) {
    let result: { status: number; json: unknown };
    try {
      result = await getJson(url, fetchFn, withTimeout(options.signal, options.timeoutMs ?? 10_000));
    } catch (cause) {
      if (options.signal?.aborted) throw cause;
      throw new OAuthRequestError('network_error', `Could not reach ${new URL(url).origin}.`, undefined, {
        cause,
      });
    }
    const { status, json } = result;
    lastStatus = status;
    if (json === undefined) continue;
    const parsed = AuthorizationServerMetadataSchema.safeParse(json);
    if (!parsed.success) {
      throw new OAuthRequestError('invalid_metadata', `Authorization server metadata at ${url} is invalid.`);
    }
    const metadata = parsed.data;
    if (metadata.issuer !== issuer) {
      throw new OAuthRequestError(
        'issuer_mismatch',
        `Authorization server metadata names issuer ${JSON.stringify(metadata.issuer)}, expected ${JSON.stringify(issuer)}.`,
      );
    }
    if (!metadata.code_challenge_methods_supported?.includes('S256')) {
      throw new OAuthRequestError(
        'pkce_unsupported',
        'The authorization server does not advertise PKCE S256; refusing to continue.',
      );
    }
    return metadata;
  }
  throw new OAuthRequestError(
    'metadata_not_found',
    `No authorization server metadata found for ${issuer}${lastStatus === undefined ? '' : ` (last HTTP ${lastStatus})`}.`,
  );
};

export const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string(),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
  issued_token_type: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

const OAuthErrorBody = z.looseObject({
  error: z.string().regex(/^[\x20-\x21\x23-\x5B\x5D-\x7E]+$/),
  error_description: z.string().optional(),
});

/** RFC 6749 §2.3.1: client_secret_basic form-encodes id and secret before base64. */
export const basicAuthorization = (clientId: string, clientSecret: string): string => {
  const enc = (s: string) => encodeURIComponent(s).replace(/%20/g, '+');
  return `Basic ${Buffer.from(`${enc(clientId)}:${enc(clientSecret)}`, 'utf8').toString('base64')}`;
};

export interface FormPostOptions {
  readonly fetch?: FetchFn;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
  /** Confidential clients: `client_secret_basic`. Omit for public clients. */
  readonly clientSecretBasic?: { readonly clientId: string; readonly clientSecret: string };
}

const postForm = async (
  url: string,
  params: Record<string, string>,
  options: FormPostOptions,
): Promise<Response> => {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const headers = baseHeaders({
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    'cache-control': 'no-store',
  });
  if (options.clientSecretBasic) {
    headers.authorization = basicAuthorization(
      options.clientSecretBasic.clientId,
      options.clientSecretBasic.clientSecret,
    );
  }
  try {
    return await fetchFn(url, {
      method: 'POST',
      headers,
      body: new URLSearchParams(params).toString(),
      signal: withTimeout(options.signal, options.timeoutMs ?? 15_000),
      redirect: 'error',
    });
  } catch (cause) {
    if (options.signal?.aborted) throw cause;
    throw new OAuthRequestError('network_error', `Could not reach ${new URL(url).origin}.`, undefined, {
      cause,
    });
  }
};

const parseOAuthError = (response: Response, text: string): OAuthRequestError => {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const parsed = OAuthErrorBody.safeParse(body);
  if (parsed.success) {
    const description = parsed.data.error_description
      ? `: ${cleanMessage(parsed.data.error_description, 200)}`
      : '';
    return new OAuthRequestError(parsed.data.error, `${parsed.data.error}${description}`, response.status);
  }
  return new OAuthRequestError('http_error', `HTTP ${response.status}`, response.status);
};

/** POST to a token endpoint and validate the RFC 6749 §5.1 response. */
export const requestToken = async (
  tokenEndpoint: string,
  params: Record<string, string>,
  options: FormPostOptions = {},
): Promise<TokenResponse> => {
  const response = await postForm(tokenEndpoint, params, options);
  const text = await readTextCapped(response, MAX_OAUTH_RESPONSE_BYTES);
  if (!response.ok) throw parseOAuthError(response, text);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new OAuthRequestError(
      'invalid_response',
      'Token endpoint returned a non-JSON response.',
      response.status,
    );
  }
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new OAuthRequestError(
      'invalid_response',
      'Token endpoint returned an invalid token response.',
      response.status,
    );
  }
  if (parsed.data.token_type.toLowerCase() !== 'bearer') {
    throw new OAuthRequestError(
      'invalid_response',
      `Unsupported token_type ${JSON.stringify(parsed.data.token_type)}.`,
    );
  }
  return parsed.data;
};

/** RFC 7009 token revocation. Resolves on 200 (the AS answers 200 even for unknown tokens). */
export const revokeToken = async (
  revocationEndpoint: string,
  params: { token: string; token_type_hint: 'refresh_token' | 'access_token'; client_id: string },
  options: FormPostOptions = {},
): Promise<void> => {
  const response = await postForm(revocationEndpoint, params, options);
  const text = await readTextCapped(response, MAX_OAUTH_RESPONSE_BYTES);
  if (!response.ok) throw parseOAuthError(response, text);
};
