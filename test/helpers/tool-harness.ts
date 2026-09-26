/**
 * Drive tools through a REAL MCP client and server, in process.
 *
 *   const h = await connectTools({ graphql: fakeGraphQL({...}), grantedScopes: ['programs:read'] });
 *   const result = await h.call('search_programs', { query: 'bank' });
 *   await h.close();
 *
 * The server is built with the production `buildServer` and served by the
 * SDK's `createMcpHandler`; the client is the SDK `Client` negotiating the
 * 2026-07-28 protocol over the handler's `fetch` (no sockets). Pass
 * `era: 'legacy'` to exercise a 2025-era client instead.
 *
 * Write tools ask for approval through elicitation: `approve` decides how the
 * test client answers ('accept' by default; 'none' = a client without the
 * elicitation capability). Every prompt it receives is kept in `prompts`.
 */
import { randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import type { AuthMode } from '../../src/errors.js';
import type { GraphQLClient } from '../../src/graphql/client.js';
import { silentLogger } from '../../src/logger.js';
import { SCOPES, type Scope } from '../../src/scopes.js';
import { REPORTER_ID } from './report-fixtures.js';
import { buildServer } from '../../src/server.js';
import { ApprovalGate, ApprovalReplayGuard } from '../../src/tools/approval.js';
import type { AnyTool } from '../../src/tools/define-tool.js';

export type ApprovalAnswer = 'accept' | 'accept-unticked' | 'decline' | 'cancel' | 'none';

export interface HarnessOptions {
  readonly graphql: GraphQLClient;
  /** Scopes on the session; `'all'` (default) = every scope, `'signed-out'` = no login. */
  readonly grantedScopes?: readonly Scope[] | 'all' | 'signed-out';
  readonly readOnly?: boolean;
  readonly mode?: AuthMode;
  readonly tools?: readonly AnyTool[];
  readonly era?: 'modern' | 'legacy';
  readonly approve?: ApprovalAnswer;
  /** The signed-in user's id (token `sub`); default: the fixtures' reporter. `null` = unknown. */
  readonly viewerId?: string | null;
  /** Scopes the user approved (hosted), when BugSecure granted fewer (`grantedScopes`). */
  readonly approvedScopes?: readonly Scope[];
}

export interface ElicitationPrompt {
  readonly message: string;
  readonly requestedSchema: unknown;
}

export interface Harness {
  readonly client: Client;
  /** Every approval prompt the client was shown, in order. */
  readonly prompts: ElicitationPrompt[];
  call(name: string, args?: Record<string, unknown>): ReturnType<Client['callTool']>;
  listToolNames(): Promise<string[]>;
  close(): Promise<void>;
}

export const elicitingClient = (
  approve: ApprovalAnswer,
  prompts: ElicitationPrompt[],
  options: ConstructorParameters<typeof Client>[1] = {},
): Client => {
  const client = new Client(
    { name: 'bugsecure-test-harness', version: '0.0.0' },
    { ...options, capabilities: approve === 'none' ? {} : { elicitation: { form: {} } } },
  );
  if (approve !== 'none') {
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message: string; requestedSchema?: unknown };
      prompts.push({ message: params.message, requestedSchema: params.requestedSchema });
      switch (approve) {
        case 'accept':
          return Promise.resolve({ action: 'accept' as const, content: { approve: true } });
        case 'accept-unticked':
          return Promise.resolve({ action: 'accept' as const, content: { approve: false } });
        case 'decline':
        case 'cancel':
          return Promise.resolve({ action: approve });
      }
    });
  }
  return client;
};

export const connectTools = async (options: HarnessOptions): Promise<Harness> => {
  const granted = options.grantedScopes ?? 'all';
  const scopes: ReadonlySet<Scope> | undefined =
    granted === 'signed-out' ? undefined : new Set(granted === 'all' ? SCOPES : granted);
  const approvals = new ApprovalGate({
    key: randomBytes(32),
    principal: 'test',
    replay: new ApprovalReplayGuard(),
    logger: silentLogger,
  });
  const handler = createMcpHandler(() =>
    buildServer({
      mode: options.mode ?? 'local',
      graphql: options.graphql,
      logger: silentLogger,
      grantedScopes: () => Promise.resolve(scopes),
      viewerId: () =>
        Promise.resolve(options.viewerId === null ? undefined : (options.viewerId ?? REPORTER_ID)),
      ...(options.approvedScopes === undefined
        ? {}
        : { approvedScopes: () => Promise.resolve(new Set(options.approvedScopes)) }),
      readOnly: options.readOnly ?? false,
      approvals,
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }),
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://harness.test/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const prompts: ElicitationPrompt[] = [];
  const client = elicitingClient(
    options.approve ?? 'accept',
    prompts,
    options.era === 'legacy' ? {} : { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);

  return {
    client,
    prompts,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
    listToolNames: async () => (await client.listTools()).tools.map((t) => t.name),
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
};

/** The text of the first content block of a tool result. */
export const textOf = (result: { content?: unknown }): string => {
  const blocks = result.content as { type: string; text?: string }[] | undefined;
  const first = blocks?.[0];
  if (first?.type !== 'text' || first.text === undefined) throw new Error('result has no text content');
  return first.text;
};

/** Strip the per-response nonce so fenced output can be compared literally. */
export const unfence = (value: string): string => {
  return value.replace(/untrusted-content-[0-9a-f]{16}/g, 'untrusted-content');
};
