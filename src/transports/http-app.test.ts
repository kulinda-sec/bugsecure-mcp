import { type Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { fakeAuthorizationServer } from '../../test/helpers/fake-authorization-server.js';
import { lookups } from '../../test/helpers/fake-graphql.js';
import {
  type ApprovalAnswer,
  type ElicitationPrompt,
  elicitingClient,
} from '../../test/helpers/tool-harness.js';
import { TEST_ISSUER, TEST_RESOURCE, testSigner, type TestSigner } from '../../test/helpers/jwt.js';
import { createAccessTokenVerifier } from '../auth/hosted/jwt.js';
import { TokenExchanger } from '../auth/hosted/token-exchange.js';
import { type HostedConfig, loadHostedConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { ALL_TOOLS } from '../tools/index.js';
import { bearerToken, calledToolNames, createHttpApp, type HttpApp } from './http-app.js';

let signer: TestSigner;
beforeAll(async () => {
  signer = await testSigner();
});

const MCP_URL = TEST_RESOURCE; // https://mcp.test/mcp
const PRM_URL = 'https://mcp.test/.well-known/oauth-protected-resource/mcp';

const hostedConfig = (env: Record<string, string> = {}): HostedConfig => {
  return loadHostedConfig({
    BUGSECURE_API_URL: 'https://api.test',
    BUGSECURE_ISSUER: TEST_ISSUER,
    BUGSECURE_MCP_RESOURCE: TEST_RESOURCE,
    BUGSECURE_CLIENT_SECRET: 'hosted-secret',
    BUGSECURE_MCP_APPROVAL_KEY: 'approval-key-approval-key-approval-key-0123',
    BUGSECURE_ALLOWED_ORIGINS: 'app.example',
    ...env,
  });
};

interface Setup {
  app: HttpApp;
  apiCalls: { authorization: string | null; body: string }[];
  as: ReturnType<typeof fakeAuthorizationServer>;
}

/** Answers the API with `api(authorization)` instead of success, when it returns a Response. */
type ApiOverride = (authorization: string | null) => Response | undefined;

const setup = (env: Record<string, string> = {}, api?: ApiOverride): Setup => {
  const config = hostedConfig(env);
  const as = fakeAuthorizationServer(TEST_ISSUER);
  as.tokenResponses = [
    { status: 200, body: { access_token: 'api-token', token_type: 'Bearer', expires_in: 600 } },
  ];
  const apiCalls: Setup['apiCalls'] = [];
  const apiFetch: typeof fetch = async (_url, init) => {
    const authorization = new Headers(init?.headers).get('authorization');
    apiCalls.push({ authorization, body: typeof init?.body === 'string' ? init.body : '' });
    await Promise.resolve();
    const override = api?.(authorization);
    if (override) return override;
    const body = typeof init?.body === 'string' ? init.body : '';
    const { query, variables } = JSON.parse(body) as { query: string; variables?: Record<string, unknown> };
    const operation = /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '';
    const org = lookups();
    const data =
      operation === 'AddReportComment' || operation === 'AddTriageComment'
        ? {
            addReportComment: {
              id: 'c1',
              reportId: 'r1',
              isInternal: operation === 'AddTriageComment',
              createdAt: '2026-09-21T10:00:00Z',
            },
          }
        : operation in org
          ? org[operation]?.(variables ?? {})
          : { programs: [] };
    return new Response(JSON.stringify({ data }), { headers: { 'content-type': 'application/json' } });
  };
  const app = createHttpApp({
    config,
    logger: silentLogger,
    verifyAccessToken: createAccessTokenVerifier({
      issuer: TEST_ISSUER,
      audience: TEST_RESOURCE,
      keys: signer.keys,
    }),
    exchanger: new TokenExchanger({
      tokenEndpoint: `${TEST_ISSUER}/oauth/token`,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      apiResource: config.apiUrl,
      cacheSize: 10,
      logger: silentLogger,
      fetch: as.fetch,
    }),
    fetch: apiFetch,
  });
  // Like a real HTTP/1.1 client (and our Node adapter), always send Host.
  const withHost: HttpApp = {
    fetch: (request) => {
      if (request.headers.has('host')) return app.fetch(request);
      const headers = new Headers(request.headers);
      headers.set('host', new URL(request.url).host);
      return app.fetch(new Request(request, { headers }));
    },
    close: () => app.close(),
  };
  return { app: withHost, apiCalls, as };
};

const rpc = (method: string, params: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

const post = (app: HttpApp, body: string, headers: Record<string, string> = {}): Promise<Response> => {
  return app.fetch(
    new Request(MCP_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    }),
  );
};

let current: Setup | undefined;
afterEach(async () => {
  await current?.app.close();
  current = undefined;
});

describe('protected resource metadata (RFC 9728)', () => {
  it('is served at the URL derived from the resource, advertising the read scopes only', async () => {
    current = setup();
    const res = await current.app.fetch(new Request(PRM_URL));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      resource: TEST_RESOURCE,
      authorization_servers: [TEST_ISSUER],
      // Minimal set for basic use (spec: Scope Selection Strategy), plus every
      // scope only some accounts can hold: never stepped up (they would loop),
      // so the first connection is the only time to ask.
      scopes_supported: [
        'programs:read',
        'profile:read',
        'reports:read',
        'reports:write',
        'triage:read',
        'triage:write',
        'grade:write',
        'profile:write',
        'disclosures:write',
      ],
      bearer_methods_supported: ['header'],
      resource_name: 'BugSecure MCP',
      resource_documentation: 'https://github.com/kulinda-sec/bugsecure-mcp#readme',
    });
  });

  it('is not served at the root well-known URL, whose resource would be the origin (RFC 9728 §3.3)', async () => {
    current = setup();
    const res = await current.app.fetch(new Request('https://mcp.test/.well-known/oauth-protected-resource'));
    expect(res.status).toBe(404);
  });

  it('answers preflight and refuses writes', async () => {
    current = setup();
    expect((await current.app.fetch(new Request(PRM_URL, { method: 'OPTIONS' }))).status).toBe(204);
    expect((await current.app.fetch(new Request(PRM_URL, { method: 'POST' }))).status).toBe(405);
  });
});

describe('authentication', () => {
  it('401s without a token, pointing at the resource metadata', async () => {
    current = setup();
    const res = await post(current.app, rpc('tools/list'));
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${PRM_URL}"`);
    expect(challenge).toContain(
      'scope="programs:read profile:read reports:read reports:write triage:read triage:write grade:write profile:write disclosures:write"',
    );
    expect(challenge).not.toContain('error='); // RFC 6750 §3.1: no error code without credentials
  });

  it('401s with invalid_token for a token minted for another audience', async () => {
    current = setup();
    const token = await signer.sign({ aud: 'https://api.test' });
    const res = await post(current.app, rpc('tools/list'), { authorization: `Bearer ${token}` });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('401s with invalid_request for a malformed Authorization header', async () => {
    current = setup();
    const res = await post(current.app, rpc('tools/list'), { authorization: 'Basic abc' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_request"');
  });

  it('never accepts a token in the query string', async () => {
    current = setup();
    const token = await signer.sign();
    const res = await current.app.fetch(
      new Request(`${MCP_URL}?access_token=${token}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: rpc('tools/list'),
      }),
    );
    expect(res.status).toBe(401);
  });
});

describe('transport hardening', () => {
  it('403s a disallowed Origin and allows the configured one, echoing it (never *)', async () => {
    current = setup();
    const token = await signer.sign();
    const bad = await post(current.app, rpc('tools/list'), {
      origin: 'https://evil.example',
      authorization: `Bearer ${token}`,
    });
    expect(bad.status).toBe(403);

    const preflight = await current.app.fetch(
      new Request(MCP_URL, { method: 'OPTIONS', headers: { origin: 'https://app.example' } }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');
  });

  it('compares the whole Origin (scheme, host and port), not the hostname alone', async () => {
    current = setup();
    for (const origin of [
      'http://app.example',
      'https://app.example:8443',
      'https://app.example.evil',
      'null',
    ]) {
      const res = await current.app.fetch(new Request(MCP_URL, { method: 'OPTIONS', headers: { origin } }));
      expect(res.status, origin).toBe(403);
    }
    for (const origin of ['https://app.example', 'https://APP.example:443']) {
      const res = await current.app.fetch(new Request(MCP_URL, { method: 'OPTIONS', headers: { origin } }));
      expect(res.status, origin).toBe(origin === 'https://app.example' ? 204 : 403);
    }
  });

  it('403s a foreign Host header (DNS rebinding)', async () => {
    current = setup();
    const res = await post(current.app, rpc('tools/list'), { host: 'attacker.example' });
    expect(res.status).toBe(403);
  });

  it('405s GET and DELETE on the MCP endpoint (no legacy SSE stream, no sessions)', async () => {
    current = setup();
    for (const method of ['GET', 'DELETE']) {
      const res = await current.app.fetch(new Request(MCP_URL, { method }));
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toContain('POST');
    }
  });

  it('404s unknown paths and serves a health check', async () => {
    current = setup();
    expect((await current.app.fetch(new Request('https://mcp.test/nope'))).status).toBe(404);
    expect((await current.app.fetch(new Request('https://mcp.test/healthz'))).status).toBe(200);
  });
});

describe('scope step-up (403 insufficient_scope)', () => {
  it('challenges a call to a tool the token lacks scopes for, keeping the granted scopes', async () => {
    current = setup();
    const token = await signer.sign({ scope: 'profile:read reports:read' });
    const res = await post(current.app, rpc('tools/call', { name: 'submit_report', arguments: {} }), {
      authorization: `Bearer ${token}`,
    });
    expect(res.status).toBe(403);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('error="insufficient_scope"');
    // granted ∪ required, so a client re-authorizing with exactly this set loses nothing
    expect(challenge).toContain('scope="profile:read reports:read reports:write"');
    expect(challenge).toContain(`resource_metadata="${PRM_URL}"`);
    expect(current.as.tokenRequests).toHaveLength(0); // nothing exchanged, nothing called
  });

  it('never steps up for organisation-side scopes: the tool explains who is eligible instead', async () => {
    current = setup();
    // Missing only triage:write (organisation-gated): no 403, whatever the account.
    const token = await signer.sign({ scope: 'programs:read profile:read' });
    const res = await post(
      current.app,
      rpc('tools/call', { name: 'update_report_status', arguments: { reportId: 'r1', status: 'IN_TRIAGE' } }),
      { authorization: `Bearer ${token}` },
    );
    expect(res.status).not.toBe(403); // reaches MCP handling (the tool's own error: see below)
    expect(current.apiCalls).toHaveLength(0);

    // Missing a user-side scope too: step up for that one only.
    const narrow = await signer.sign({ scope: 'programs:read' });
    const up = await post(
      current.app,
      rpc('tools/call', { name: 'update_report_status', arguments: { reportId: 'r1', status: 'IN_TRIAGE' } }),
      { authorization: `Bearer ${narrow}` },
    );
    expect(up.status).toBe(403);
    expect(up.headers.get('www-authenticate')).toContain('scope="programs:read profile:read"');
  });

  it('never steps up for the researcher-only scopes either: consent drops them for other accounts', async () => {
    current = setup();
    const token = await signer.sign({ scope: 'programs:read profile:read reports:read' });
    for (const name of ['update_my_profile', 'save_disclosure_draft']) {
      const res = await post(current.app, rpc('tools/call', { name, arguments: {} }), {
        authorization: `Bearer ${token}`,
      });
      expect(res.status, name).not.toBe(403);
    }
    // A scope every account can hold still steps up.
    const res = await post(
      current.app,
      rpc('tools/call', { name: 'mark_notifications_read', arguments: { all: true } }),
      {
        authorization: `Bearer ${token}`,
      },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('notifications:write');
  });

  it('checks every call of a batch, and steps up for the first that needs more', async () => {
    current = setup();
    const token = await signer.sign({ scope: 'programs:read' });
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_programs', arguments: {} } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'submit_report', arguments: {} } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'grade_report', arguments: {} } },
    ]);
    const res = await post(current.app, batch, { authorization: `Bearer ${token}` });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('scope="programs:read reports:write"');
    expect(current.as.tokenRequests).toHaveLength(0);
  });

  it('lets unknown tools and hidden write tools through to the ordinary "not found" error', async () => {
    current = setup({ BUGSECURE_READ_ONLY: '1' });
    const token = await signer.sign({ scope: 'programs:read' });
    for (const name of ['no_such_tool', 'submit_report']) {
      const res = await post(current.app, rpc('tools/call', { name, arguments: {} }), {
        authorization: `Bearer ${token}`,
      });
      expect(res.status).not.toBe(403);
    }
  });
});

describe('request body handling', () => {
  /** A body that fails the test if anything reads it. */
  const untouchableBody = (): ReadableStream<Uint8Array> => {
    return new ReadableStream({
      pull() {
        throw new Error('the body was read before authentication');
      },
    });
  };

  it('never reads the body of an unauthenticated request', async () => {
    current = setup();
    for (const headers of [{}, { authorization: 'Bearer not-a-jwt' }, { host: 'evil.example' }]) {
      const res = await current.app.fetch(
        new Request(MCP_URL, {
          method: 'POST',
          headers: { host: 'mcp.test', 'content-type': 'application/json', ...headers },
          body: untouchableBody(),
          duplex: 'half',
        }),
      );
      expect([401, 403]).toContain(res.status);
    }
  });

  it('refuses an oversized body (413) and malformed JSON (JSON-RPC parse error)', async () => {
    current = setup({ BUGSECURE_MAX_BODY_BYTES: '1024' });
    const auth = { authorization: `Bearer ${await signer.sign()}` };
    expect((await post(current.app, 'x'.repeat(2048), auth)).status).toBe(413);
    const bad = await post(current.app, '{not json', auth);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32700 } });
  });
});

describe('MCP over the hosted endpoint', () => {
  const connect = async (
    setupResult: Setup,
    token: string,
    approve: ApprovalAnswer = 'accept',
    prompts: ElicitationPrompt[] = [],
    era: 'modern' | 'legacy' = 'modern',
  ): Promise<Client> => {
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${token}`);
        return setupResult.app.fetch(new Request(url, { ...init, headers }));
      },
    });
    const client = elicitingClient(
      approve,
      prompts,
      era === 'modern' ? { versionNegotiation: { mode: 'auto' } } : {},
    );
    await client.connect(transport);
    return client;
  };

  it('lists every tool and calls the API with an EXCHANGED token', async () => {
    current = setup();
    const inbound = await signer.sign({ scope: 'programs:read' });
    const client = await connect(current, inbound);
    try {
      expect(client.getProtocolEra()).toBe('modern');
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toHaveLength(ALL_TOOLS.length);
      expect(names).toContain('submit_report');

      const result = await client.callTool({ name: 'search_programs', arguments: {} });
      expect(result.isError).toBeFalsy();

      // No token passthrough: the API saw the exchanged token, never the inbound one.
      expect(current.apiCalls.map((c) => c.authorization)).toEqual(['Bearer api-token']);
      expect(current.as.tokenRequests[0]?.form.subject_token).toBe(inbound);
    } finally {
      await client.close();
    }
  });

  describe('an exchanged token the API rejects (HTTP 200 + UNAUTHENTICATED)', () => {
    const unauthenticated = (): Response =>
      Response.json({
        data: null,
        errors: [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }],
      });
    const exchanged = (token: string) => ({
      status: 200,
      body: { access_token: token, token_type: 'Bearer', expires_in: 600 },
    });

    it('evicts it and re-exchanges the inbound token once, transparently', async () => {
      current = setup({}, (auth) => (auth === 'Bearer api-1' ? unauthenticated() : undefined));
      current.as.tokenResponses = [exchanged('api-1'), exchanged('api-2')];
      const inbound = await signer.sign({ scope: 'programs:read' });
      const client = await connect(current, inbound);
      try {
        expect((await client.callTool({ name: 'search_programs', arguments: {} })).isError).toBeFalsy();
        expect(current.apiCalls.map((c) => c.authorization)).toEqual(['Bearer api-1', 'Bearer api-2']);
        expect(current.as.tokenRequests.map((r) => r.form.subject_token)).toEqual([inbound, inbound]);
        // The re-exchanged token is cached for the next call.
        expect((await client.callTool({ name: 'search_programs', arguments: {} })).isError).toBeFalsy();
        expect(current.as.tokenRequests).toHaveLength(2);
      } finally {
        await client.close();
      }
    });

    it('stops after one re-exchange: SESSION_EXPIRED, not a loop', async () => {
      current = setup({}, () => unauthenticated());
      current.as.tokenResponses = [exchanged('api-1'), exchanged('api-2'), exchanged('api-3')];
      const client = await connect(current, await signer.sign({ scope: 'programs:read' }));
      try {
        const result = await client.callTool({ name: 'search_programs', arguments: {} });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('no longer valid');
        expect(JSON.stringify(result.content)).toContain('reconnect');
        expect(current.apiCalls).toHaveLength(2);
        expect(current.as.tokenRequests).toHaveLength(2);
      } finally {
        await client.close();
      }
    });

    it('does not re-exchange on other GraphQL errors', async () => {
      current = setup({}, () =>
        Response.json({ errors: [{ message: 'nope', extensions: { code: 'FORBIDDEN' } }] }),
      );
      const client = await connect(current, await signer.sign({ scope: 'programs:read' }));
      try {
        expect((await client.callTool({ name: 'search_programs', arguments: {} })).isError).toBe(true);
        expect(current.apiCalls).toHaveLength(1);
        expect(current.as.tokenRequests).toHaveLength(1);
      } finally {
        await client.close();
      }
    });

    it('answers 401 invalid_token when the AS refuses the re-exchange, so the client refreshes', async () => {
      current = setup({}, () => unauthenticated());
      current.as.tokenResponses = [exchanged('api-1'), { status: 400, body: { error: 'invalid_grant' } }];
      const inbound = await signer.sign({ scope: 'programs:read' });
      const client = await connect(current, inbound);
      try {
        // Modern (2026-07-28) answers are plain JSON: the tool error becomes the 401 itself.
        await expect(client.callTool({ name: 'search_programs', arguments: {} })).rejects.toThrow(
          /invalid_token/,
        );
        expect(current.apiCalls).toHaveLength(1);
        expect(current.as.tokenRequests).toHaveLength(2);
      } finally {
        await client.close();
      }
      // Every later request with that token is refused up front, without asking the AS again.
      const again = await post(current.app, rpc('tools/list'), { authorization: `Bearer ${inbound}` });
      expect(again.status).toBe(401);
      expect(again.headers.get('www-authenticate')).toContain('error="invalid_token"');
      expect(current.as.tokenRequests).toHaveLength(2);
      // A new token (what the client gets by refreshing) works.
      current.as.tokenResponses = [exchanged('api-fresh')];
      const fresh = await connect(
        current,
        await signer.sign({ scope: 'programs:read', jti: 'jti-refreshed' }),
      );
      try {
        await fresh.listTools();
      } finally {
        await fresh.close();
      }
    });

    it('on a streamed (2025 legacy) answer: a tool error now, 401 on the next request', async () => {
      current = setup({}, () => unauthenticated());
      current.as.tokenResponses = [exchanged('api-1'), { status: 400, body: { error: 'invalid_grant' } }];
      const inbound = await signer.sign({ scope: 'programs:read' });
      const client = await connect(current, inbound, 'accept', [], 'legacy');
      try {
        expect(client.getProtocolEra()).toBe('legacy');
        const result = await client.callTool({ name: 'search_programs', arguments: {} });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toContain('reconnect');
      } finally {
        await client.close();
      }
      const again = await post(current.app, rpc('tools/list'), { authorization: `Bearer ${inbound}` });
      expect(again.status).toBe(401);
    });
  });

  it('answers a call missing only an organisation-side scope with who is eligible, not a consent loop', async () => {
    current = setup();
    const client = await connect(current, await signer.sign({ scope: 'programs:read profile:read' }));
    try {
      const result = await client.callTool({
        name: 'update_report_status',
        arguments: { reportId: 'r1', status: 'IN_TRIAGE' },
      });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toContain('only granted to a member of an organisation whose Administrator');
      expect(text).toContain('BugSecure staff accounts are never granted them');
      expect(current.apiCalls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it('hides write tools on a read-only deployment', async () => {
    current = setup({ BUGSECURE_READ_ONLY: '1' });
    const client = await connect(current, await signer.sign({ scope: 'programs:read reports:write' }));
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('submit_report');
    } finally {
      await client.close();
    }
  });

  it('reaches an organisation-side write with the scopes the first connection asks for', async () => {
    // triage:write is never stepped up, so it must come from the first consent (HOSTED_INITIAL_SCOPES):
    // a token carrying it gets the triage write all the way to the API, with its idempotency key.
    current = setup();
    const prompts: ElicitationPrompt[] = [];
    const client = await connect(
      current,
      await signer.sign({ scope: 'profile:read triage:read triage:write' }),
      'accept',
      prompts,
    );
    try {
      const result = await client.callTool({
        name: 'add_triage_comment',
        arguments: { reportId: 'r1', content: 'Reproduced on staging.', visibleToResearcher: false },
      });
      expect(result.isError).toBeFalsy();
      expect(prompts).toHaveLength(1);
      const sent = current.apiCalls.map(
        (c) => JSON.parse(c.body) as { query: string; variables?: Record<string, unknown> },
      );
      const write = sent.find((c) => c.query.includes('AddTriageComment'));
      expect(write?.variables?.clientRequestId).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/));
    } finally {
      await client.close();
    }
  });

  it('asks the user before a write (elicitation over stateless HTTP), and writes only on approval', async () => {
    for (const approve of ['accept', 'decline'] as const) {
      current = setup();
      const prompts: ElicitationPrompt[] = [];
      const client = await connect(current, await signer.sign({ scope: 'reports:write' }), approve, prompts);
      try {
        const result = await client.callTool({
          name: 'add_report_comment',
          arguments: { reportId: 'r1', content: 'Here is the account.' },
        });
        expect(prompts[0]?.message).toContain('Here is the account.');
        expect(result.isError ?? false).toBe(approve === 'decline');
        expect(current.apiCalls).toHaveLength(approve === 'accept' ? 1 : 0);
      } finally {
        await client.close();
        await current.app.close();
      }
    }
    current = undefined;
  });

  it('gates tools on the scopes the exchange granted, not the inbound token’s', async () => {
    current = setup();
    // The authorization server narrows the exchange: reports:write is no longer available.
    current.as.tokenResponses = [
      {
        status: 200,
        body: { access_token: 'api-token', token_type: 'Bearer', expires_in: 600, scope: 'reports:read' },
      },
    ];
    const prompts: ElicitationPrompt[] = [];
    const client = await connect(
      current,
      await signer.sign({ scope: 'reports:read reports:write' }),
      'accept',
      prompts,
    );
    try {
      const result = await client.callTool({
        name: 'add_report_comment',
        arguments: { reportId: 'r1', content: 'hi' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('needs the reports:write permission');
      // Approved on the inbound token, withheld by the exchange: asking again would not help.
      expect(JSON.stringify(result.content)).toContain('BugSecure did not grant reports:write');
      expect(JSON.stringify(result.content)).not.toContain('and approve:');
      // Refused up front: no approval asked, nothing sent to the API.
      expect(prompts).toHaveLength(0);
      expect(current.apiCalls).toHaveLength(0);
      expect(current.as.tokenRequests).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it('refuses writes from a client that cannot show approval prompts', async () => {
    current = setup();
    const client = await connect(current, await signer.sign({ scope: 'reports:write' }), 'none');
    try {
      const result = await client.callTool({
        name: 'add_report_comment',
        arguments: { reportId: 'r1', content: 'hi' },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain('does not support approval prompts');
      expect(current.apiCalls).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it('rate-limits a user across all their clients, and writes more tightly', async () => {
    current = setup({
      BUGSECURE_RATE_LIMIT_PER_MINUTE: '1',
      BUGSECURE_RATE_LIMIT_BURST: '1',
      BUGSECURE_RATE_LIMIT_WRITES_PER_MINUTE: '1',
      BUGSECURE_RATE_LIMIT_WRITE_BURST: '1',
    });
    const clients = await Promise.all(
      ['a', 'b', 'c'].map(async (id) =>
        connect(current!, await signer.sign({ scope: 'programs:read', client_id: `client-${id}` })),
      ),
    );
    try {
      // Per client: 1; per user: 2 (twice the per-client budget) — a third client id does not help.
      const results = [];
      for (const client of clients)
        results.push(await client.callTool({ name: 'search_programs', arguments: {} }));
      expect(results.map((r) => r.isError ?? false)).toEqual([false, false, true]);
      expect(JSON.stringify(results[2]?.content)).toContain('for this account');
    } finally {
      await Promise.all(clients.map((c) => c.close()));
    }

    const writer = await connect(
      current,
      await signer.sign({ scope: 'reports:write', sub: 'user-writer', client_id: 'w' }),
      'none',
    );
    try {
      const first = await writer.callTool({
        name: 'add_report_comment',
        arguments: { reportId: 'r1', content: 'a' },
      });
      expect(JSON.stringify(first.content)).toContain('does not support approval prompts');
      const second = await writer.callTool({
        name: 'add_report_comment',
        arguments: { reportId: 'r1', content: 'a' },
      });
      expect(JSON.stringify(second.content)).toContain('Too many BugSecure tool calls');
    } finally {
      await writer.close();
    }
  });

  it('a refused call takes nothing from the budgets checked after the one that refused it', async () => {
    // Per client 1, per user 2: a client hammering past its own budget must not use up the
    // account's, which the user's other clients share.
    current = setup({ BUGSECURE_RATE_LIMIT_PER_MINUTE: '1', BUGSECURE_RATE_LIMIT_BURST: '1' });
    const noisy = await connect(current, await signer.sign({ scope: 'programs:read', client_id: 'noisy' }));
    const quiet = await connect(current, await signer.sign({ scope: 'programs:read', client_id: 'quiet' }));
    try {
      expect((await noisy.callTool({ name: 'search_programs', arguments: {} })).isError).toBeFalsy();
      for (let i = 0; i < 3; i++) {
        const refused = await noisy.callTool({ name: 'search_programs', arguments: {} });
        expect(JSON.stringify(refused.content)).toContain('from this connection');
      }
      expect((await quiet.callTool({ name: 'search_programs', arguments: {} })).isError).toBeFalsy();
      // Now the account's budget (2) is spent, by the two calls that ran.
      const third = await connect(current, await signer.sign({ scope: 'programs:read', client_id: 'third' }));
      try {
        const refused = await third.callTool({ name: 'search_programs', arguments: {} });
        expect(JSON.stringify(refused.content)).toContain('for this account');
      } finally {
        await third.close();
      }
    } finally {
      await noisy.close();
      await quiet.close();
    }
  });

  it('rate-limits tool calls per user and client, with a retry hint', async () => {
    current = setup({ BUGSECURE_RATE_LIMIT_PER_MINUTE: '1', BUGSECURE_RATE_LIMIT_BURST: '2' });
    const client = await connect(current, await signer.sign({ scope: 'programs:read' }));
    const other = await connect(
      current,
      await signer.sign({ scope: 'programs:read', client_id: 'other-client' }),
    );
    try {
      for (let i = 0; i < 2; i++) {
        expect((await client.callTool({ name: 'search_programs', arguments: {} })).isError).toBeFalsy();
      }
      const limited = await client.callTool({ name: 'search_programs', arguments: {} });
      expect(limited.isError).toBe(true);
      expect(JSON.stringify(limited.content)).toMatch(/Try again in \d+ seconds/);
      // Another client of the same user has its own budget.
      expect((await other.callTool({ name: 'search_programs', arguments: {} })).isError).toBeFalsy();
    } finally {
      await client.close();
      await other.close();
    }
  });
});

describe('helpers', () => {
  it('parses Bearer credentials strictly', () => {
    expect(bearerToken(null)).toEqual({ kind: 'missing' });
    expect(bearerToken('Bearer abc.def-_~+/=')).toEqual({ kind: 'token', token: 'abc.def-_~+/=' });
    expect(bearerToken('bearer abc')).toEqual({ kind: 'token', token: 'abc' });
    expect(bearerToken('Bearer')).toEqual({ kind: 'malformed' });
    expect(bearerToken('Bearer a b')).toEqual({ kind: 'malformed' });
    expect(bearerToken('Basic abc')).toEqual({ kind: 'malformed' });
  });

  it('extracts called tool names from single and batched messages', () => {
    expect(calledToolNames({ method: 'tools/call', params: { name: 'a' } })).toEqual(['a']);
    expect(
      calledToolNames([{ method: 'tools/call', params: { name: 'a' } }, { method: 'tools/list' }, null, 3]),
    ).toEqual(['a']);
    expect(calledToolNames(undefined)).toEqual([]);
  });
});
