import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryTransport } from '@modelcontextprotocol/client';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryStore } from '../../test/helpers/memory-store.js';
import {
  type ApprovalAnswer,
  type ElicitationPrompt,
  elicitingClient,
} from '../../test/helpers/tool-harness.js';
import type { StoredCredentials } from '../auth/stdio/credential-store.js';
import { loadLocalConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { runStdio } from './stdio.js';

const API = 'http://127.0.0.1:9';
const config = loadLocalConfig({
  BUGSECURE_API_URL: API,
  BUGSECURE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'bsmcp-stdio-')),
});

const login = (overrides: Partial<StoredCredentials> = {}): StoredCredentials => ({
  version: 1,
  issuer: API,
  clientId: 'bugsecure-mcp-cli',
  resource: API,
  tokenEndpoint: `${API}/oauth/token`,
  accessToken: 'stored-token',
  accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3_600,
  scope: 'programs:read reports:write',
  obtainedAt: 0,
  ...overrides,
});

let handle: StdioServerHandle | undefined;
afterEach(async () => {
  await handle?.close();
  handle = undefined;
});

const start = async (stored: StoredCredentials[], approve: ApprovalAnswer = 'accept') => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  handle = await runStdio(config, silentLogger, { store: memoryStore(stored), transport: serverTransport });
  const prompts: ElicitationPrompt[] = [];
  const client = elicitingClient(approve, prompts, { versionNegotiation: { mode: 'auto' } });
  await client.connect(clientTransport);
  return { client, prompts };
};

const stubApi = (data: Record<string, unknown>) => {
  const calls: { authorization: string | null; body: string }[] = [];
  vi.stubGlobal('fetch', (_url: string, init?: RequestInit) => {
    calls.push({
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return Promise.resolve(Response.json({ data }));
  });
  return calls;
};

describe('runStdio', () => {
  it('serves the 2026-07-28 protocol signed out, and explains how to sign in', async () => {
    const { client } = await start([]);
    expect(client.getProtocolEra()).toBe('modern');
    expect((await client.listTools()).tools.length).toBeGreaterThan(20);
    const result = await client.callTool({ name: 'search_programs', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('login');
  });

  it('refuses a login stored for another API instead of sending its token there', async () => {
    const calls = stubApi({ programs: [] });
    const { client } = await start([login({ resource: 'https://elsewhere.example' })]);
    const result = await client.callTool({ name: 'search_programs', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('https://elsewhere.example');
    expect(calls).toHaveLength(0);
  });

  it('calls the API with the stored login', async () => {
    const calls = stubApi({ programs: [] });
    const { client } = await start([login()]);
    const result = await client.callTool({ name: 'search_programs', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(calls.map((c) => c.authorization)).toEqual(['Bearer stored-token']);
  });

  it.each([
    ['accept', 1],
    ['decline', 0],
  ] as const)('asks before writing; answered %s → %i write(s)', async (approve, writes) => {
    const calls = stubApi({
      addReportComment: { id: 'c1', reportId: 'r1', isInternal: false, createdAt: '2026-09-21T10:00:00Z' },
    });
    const { client, prompts } = await start([login()], approve);
    const result = await client.callTool({
      name: 'add_report_comment',
      arguments: { reportId: 'r1', content: 'hi' },
    });
    expect(prompts).toHaveLength(1);
    expect(calls).toHaveLength(writes);
    expect(result.isError ?? false).toBe(writes === 0);
  });
});

describe('runStdio: an access token the API no longer accepts', () => {
  /**
   * The API as it answers a token it cannot verify (e.g. signed with a key it
   * no longer has): HTTP 200 + GraphQL UNAUTHENTICATED. Only `accepted` works.
   * The token endpoint answers the refresh grant with `refreshed` tokens.
   */
  const stubRotatedApi = (options: { accepted: string; refreshed: string[]; refreshStatus?: number }) => {
    const graphql: (string | null)[] = [];
    const refreshes: Record<string, string>[] = [];
    vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      if (String(url).endsWith('/oauth/token')) {
        refreshes.push(Object.fromEntries(new URLSearchParams(body)));
        if (options.refreshStatus !== undefined) {
          return Promise.resolve(
            Response.json({ error: 'invalid_grant' }, { status: options.refreshStatus }),
          );
        }
        const next = options.refreshed[Math.min(refreshes.length - 1, options.refreshed.length - 1)] ?? '';
        return Promise.resolve(
          Response.json({
            access_token: next,
            token_type: 'Bearer',
            expires_in: 600,
            refresh_token: `rt-${next}`,
          }),
        );
      }
      const authorization = new Headers(init?.headers).get('authorization');
      graphql.push(authorization);
      return Promise.resolve(
        authorization === `Bearer ${options.accepted}`
          ? Response.json({ data: { programs: [] } })
          : Response.json({
              data: null,
              errors: [{ message: 'Unrecognised access token', extensions: { code: 'UNAUTHENTICATED' } }],
            }),
      );
    });
    return { graphql, refreshes };
  };

  const startWith = async (store: ReturnType<typeof memoryStore>) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    handle = await runStdio(config, silentLogger, { store, transport: serverTransport });
    const client = elicitingClient('accept', [], { versionNegotiation: { mode: 'auto' } });
    await client.connect(clientTransport);
    return client;
  };

  it('refreshes transparently and retries the call once', async () => {
    const api = stubRotatedApi({ accepted: 'fresh-token', refreshed: ['fresh-token'] });
    const store = memoryStore([login({ refreshToken: 'rt-stored' })]);
    const client = await startWith(store);

    const result = await client.callTool({ name: 'search_programs', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(api.graphql).toEqual(['Bearer stored-token', 'Bearer fresh-token']);
    expect(api.refreshes).toHaveLength(1);
    expect(api.refreshes[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-stored' });
    expect(await store.load(API)).toMatchObject({
      accessToken: 'fresh-token',
      refreshToken: 'rt-fresh-token',
    });

    // The next call uses the refreshed token straight away.
    expect((await client.callTool({ name: 'search_programs', arguments: {} })).isError).toBeFalsy();
    expect(api.graphql).toHaveLength(3);
    expect(api.refreshes).toHaveLength(1);
  });

  it('ends in SESSION_EXPIRED (a re-login hint), not a loop, when the refreshed token is refused too', async () => {
    const api = stubRotatedApi({ accepted: 'never', refreshed: ['fresh-1', 'fresh-2', 'fresh-3'] });
    const client = await startWith(memoryStore([login({ refreshToken: 'rt-stored' })]));

    const result = await client.callTool({ name: 'search_programs', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('no longer valid');
    expect(JSON.stringify(result.content)).toContain('login');
    expect(api.graphql).toEqual(['Bearer stored-token', 'Bearer fresh-1']);
    expect(api.refreshes).toHaveLength(1);
  });

  it('ends in SESSION_EXPIRED when the refresh token is rejected', async () => {
    const api = stubRotatedApi({ accepted: 'never', refreshed: [], refreshStatus: 400 });
    const store = memoryStore([login({ refreshToken: 'rt-stored' })]);
    const client = await startWith(store);

    const result = await client.callTool({ name: 'search_programs', arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('login');
    expect(api.graphql).toEqual(['Bearer stored-token']);
    expect(await store.load(API)).toBeUndefined();
  });
});
