/**
 * A scriptable fake OAuth authorization server, as a `fetch` implementation.
 * Records every token/revocation request (form fields + Authorization header).
 */
export const ISSUER = 'https://as.test';

export interface RecordedForm {
  readonly url: string;
  readonly form: Record<string, string>;
  readonly authorization: string | null;
}

export interface FakeAuthorizationServer {
  readonly fetch: typeof globalThis.fetch;
  readonly tokenRequests: RecordedForm[];
  readonly revocations: RecordedForm[];
  metadata: Record<string, unknown>;
  /** Next token endpoint responses, consumed in order (the last one repeats). */
  tokenResponses: { status: number; body: unknown }[];
  revocationStatus: number;
}

export const defaultMetadata = (issuer = ISSUER): Record<string, unknown> => {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    grant_types_supported: [
      'authorization_code',
      'refresh_token',
      'urn:ietf:params:oauth:grant-type:token-exchange',
    ],
    scopes_supported: [
      'programs:read',
      'profile:read',
      'reports:read',
      'reports:write',
      'triage:read',
      'triage:write',
      'grade:write',
    ],
  };
};

const json = (status: number, body: unknown): Response => {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

export const fakeAuthorizationServer = (issuer = ISSUER): FakeAuthorizationServer => {
  const as: FakeAuthorizationServer = {
    tokenRequests: [],
    revocations: [],
    metadata: defaultMetadata(issuer),
    tokenResponses: [{ status: 200, body: { access_token: 'at-1', token_type: 'Bearer', expires_in: 600 } }],
    revocationStatus: 200,
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
        return json(200, as.metadata);
      }
      if (method === 'POST') {
        const headers = new Headers(init?.headers);
        const record: RecordedForm = {
          url: url.href,
          form: Object.fromEntries(new URLSearchParams(typeof init?.body === 'string' ? init.body : '')),
          authorization: headers.get('authorization'),
        };
        if (url.pathname === '/oauth/token') {
          as.tokenRequests.push(record);
          const next = as.tokenResponses.length > 1 ? as.tokenResponses.shift() : as.tokenResponses[0];
          return json(next?.status ?? 500, next?.body ?? {});
        }
        if (url.pathname === '/oauth/revoke') {
          as.revocations.push(record);
          return new Response(null, { status: as.revocationStatus });
        }
      }
      await Promise.resolve();
      return json(404, { error: 'not_found' });
    },
  };
  return as;
};
