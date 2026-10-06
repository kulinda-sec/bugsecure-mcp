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
 * Write tools send the user to the BugSecure review page through a URL-mode
 * elicitation: `open` decides how the test client answers it ('accept' by
 * default = the user opened the page; 'none' = a client without the URL
 * elicitation capability). Every elicitation it receives is kept in
 * `prompts`. The decision itself comes from the fake API: spread
 * `fakeAgentApprovals(mode).handlers` into the `graphql` handlers.
 */
import { randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';

import type { AuthMode } from '../../src/errors.js';
import type { GraphQLClient } from '../../src/graphql/client.js';
import { silentLogger } from '../../src/logger.js';
import { SCOPES, type Scope } from '../../src/scopes.js';
import { FAKE_WEB_URL } from './fake-graphql.js';
import { REPORTER_ID } from './report-fixtures.js';
import { buildServer } from '../../src/server.js';
import { ApprovalGate, type ApprovalGateOptions } from '../../src/tools/approval.js';
import type { AnyTool } from '../../src/tools/define-tool.js';

/** How the test client answers the URL-mode elicitation; 'none' = no URL elicitation capability. */
export type OpenAnswer = 'accept' | 'decline' | 'cancel' | 'none';

export interface HarnessOptions {
  readonly graphql: GraphQLClient;
  /** Scopes on the session; `'all'` (default) = every scope, `'signed-out'` = no login. */
  readonly grantedScopes?: readonly Scope[] | 'all' | 'signed-out';
  readonly readOnly?: boolean;
  readonly mode?: AuthMode;
  readonly tools?: readonly AnyTool[];
  readonly era?: 'modern' | 'legacy';
  readonly open?: OpenAnswer;
  /** The signed-in user's id (token `sub`); default: the fixtures' reporter. `null` = unknown. */
  readonly viewerId?: string | null;
  /** Scopes the user approved (hosted), when BugSecure granted fewer (`grantedScopes`). */
  readonly approvedScopes?: readonly Scope[];
  /** The web origin the gate accepts review URLs on; `null` = none configured. Default: the fake API's. */
  readonly webUrl?: string | null;
  /** Gate options beyond the defaults (poll timings are shortened already). */
  readonly gate?: Partial<
    Pick<ApprovalGateOptions, 'pollIntervalMs' | 'pollBudgetMs' | 'writeTimeoutMs' | 'answerMarginMs'>
  >;
  /** The call's deadline and the write timeout the runner uses (default: the client's 60 s from the call, 20 s). */
  readonly timing?: {
    readonly deadlineAt?: () => number;
    readonly writeTimeoutMs?: number;
    readonly clientDeadlineMs?: number;
    readonly answerMarginMs?: number;
    readonly minWriteAttemptMs?: number;
  };
  /** Delay before the test client answers the URL elicitation: time the user spends on the review page. */
  readonly openDelayMs?: number;
}

export interface ElicitationPrompt {
  readonly message: string;
  /** The review URL (URL mode); absent for a form-mode elicitation. */
  readonly url: string | undefined;
  readonly mode: string | undefined;
}

export interface Harness {
  readonly client: Client;
  /** Every elicitation the client was shown, in order. */
  readonly prompts: ElicitationPrompt[];
  call(name: string, args?: Record<string, unknown>): ReturnType<Client['callTool']>;
  listToolNames(): Promise<string[]>;
  close(): Promise<void>;
}

/** The gate options every harness uses: fast polling, the fake API's web origin. */
export const TEST_GATE: Pick<ApprovalGateOptions, 'pollIntervalMs' | 'pollBudgetMs' | 'webUrl'> = {
  pollIntervalMs: 0,
  pollBudgetMs: 50,
  webUrl: FAKE_WEB_URL,
};

/** A gate for tests that build their own server. */
export const testGate = (options: Partial<ApprovalGateOptions> = {}): ApprovalGate =>
  new ApprovalGate({
    key: randomBytes(32),
    principal: 'test',
    logger: silentLogger,
    ...TEST_GATE,
    ...options,
  });

export const elicitingClient = (
  open: OpenAnswer,
  prompts: ElicitationPrompt[],
  options: ConstructorParameters<typeof Client>[1] = {},
  openDelayMs = 0,
): Client => {
  const client = new Client(
    { name: 'bugsecure-test-harness', version: '0.0.0' },
    { ...options, capabilities: open === 'none' ? {} : { elicitation: { url: {} } } },
  );
  if (open !== 'none') {
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message: string; url?: string; mode?: string };
      prompts.push({ message: params.message, url: params.url, mode: params.mode });
      return new Promise((resolve) =>
        setTimeout(() => {
          resolve({ action: open });
        }, openDelayMs),
      );
    });
  }
  return client;
};

export const connectTools = async (options: HarnessOptions): Promise<Harness> => {
  const granted = options.grantedScopes ?? 'all';
  const scopes: ReadonlySet<Scope> | undefined =
    granted === 'signed-out' ? undefined : new Set(granted === 'all' ? SCOPES : granted);
  const approvals = testGate({
    webUrl: options.webUrl === null ? undefined : (options.webUrl ?? FAKE_WEB_URL),
    ...options.gate,
    ...(options.timing?.writeTimeoutMs === undefined
      ? {}
      : { writeTimeoutMs: options.timing.writeTimeoutMs }),
    ...(options.timing?.answerMarginMs === undefined
      ? {}
      : { answerMarginMs: options.timing.answerMarginMs }),
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
      ...(options.timing?.deadlineAt === undefined ? {} : { deadlineAt: options.timing.deadlineAt }),
      ...(options.timing?.writeTimeoutMs === undefined
        ? {}
        : { writeTimeoutMs: options.timing.writeTimeoutMs }),
      ...(options.timing?.clientDeadlineMs === undefined
        ? {}
        : { clientDeadlineMs: options.timing.clientDeadlineMs }),
      ...(options.timing?.answerMarginMs === undefined
        ? {}
        : { answerMarginMs: options.timing.answerMarginMs }),
      ...(options.timing?.minWriteAttemptMs === undefined
        ? {}
        : { minWriteAttemptMs: options.timing.minWriteAttemptMs }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    }),
  );
  const transport = new StreamableHTTPClientTransport(new URL('http://harness.test/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const prompts: ElicitationPrompt[] = [];
  const client = elicitingClient(
    options.open ?? 'accept',
    prompts,
    options.era === 'legacy' ? {} : { versionNegotiation: { mode: 'auto' } },
    options.openDelayMs ?? 0,
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
