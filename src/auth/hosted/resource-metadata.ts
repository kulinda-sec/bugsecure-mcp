/**
 * The resource-server side of MCP authorization (spec 2026-07-28):
 * RFC 9728 Protected Resource Metadata and RFC 6750 `WWW-Authenticate`
 * challenges that point clients at it.
 */
import { formatScopes, type Scope } from '../../scopes.js';

export const PRM_WELL_KNOWN = '/.well-known/oauth-protected-resource';

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly bearer_methods_supported: readonly string[];
  readonly resource_name: string;
  readonly resource_documentation: string;
}

export const buildProtectedResourceMetadata = (options: {
  readonly resource: string;
  readonly issuer: string;
  readonly scopes: readonly Scope[];
}): ProtectedResourceMetadata => {
  return {
    resource: options.resource,
    authorization_servers: [options.issuer],
    scopes_supported: formatScopes(options.scopes)
      .split(' ')
      .filter((s) => s !== ''),
    // Tokens are accepted in the Authorization header only — never in the query string or body.
    bearer_methods_supported: ['header'],
    resource_name: 'BugSecure MCP',
    resource_documentation: 'https://github.com/kulinda-sec/bugsecure-mcp#readme',
  };
};

/**
 * RFC 9728 §3.1: the metadata URL inserts the well-known segment between the
 * origin and the resource's path: https://h/mcp → https://h/.well-known/oauth-protected-resource/mcp
 */
export const protectedResourceMetadataUrl = (resource: string): string => {
  const url = new URL(resource);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
  return `${url.origin}${PRM_WELL_KNOWN}${path}`;
};

/** RFC 9110 quoted-string: escape backslash and double quote; drop control characters. */
const quote = (value: string): string => {
  // eslint-disable-next-line no-control-regex
  return `"${value.replace(/[\u0000-\u001F\u007F]/g, '').replace(/[\\"]/g, (c) => `\\${c}`)}"`;
};

export interface ChallengeOptions {
  readonly resourceMetadataUrl: string;
  /** Scopes needed for the request (RFC 6750 §3, MCP "Scope Selection Strategy"). */
  readonly scopes?: readonly Scope[];
  /** Omit for a request that carried no credentials (RFC 6750 §3.1). */
  readonly error?: 'invalid_request' | 'invalid_token' | 'insufficient_scope';
  readonly errorDescription?: string;
}

export const wwwAuthenticate = (options: ChallengeOptions): string => {
  const params: string[] = [];
  if (options.error !== undefined) params.push(`error=${quote(options.error)}`);
  if (options.errorDescription !== undefined)
    params.push(`error_description=${quote(options.errorDescription)}`);
  if (options.scopes !== undefined && options.scopes.length > 0)
    params.push(`scope=${quote(formatScopes(options.scopes))}`);
  params.push(`resource_metadata=${quote(options.resourceMetadataUrl)}`);
  return `Bearer ${params.join(', ')}`;
};
