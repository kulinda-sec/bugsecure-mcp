/**
 * Builds the MCP server instance for one session (stdio: one connection;
 * streamable HTTP: one request — the 2026-07-28 protocol is stateless).
 */
import { McpServer } from '@modelcontextprotocol/server';

import type { AuthMode } from './errors.js';
import type { GraphQLClient } from './graphql/client.js';
import { serverInstructions } from './instructions.js';
import type { Logger } from './logger.js';
import type { Scope } from './scopes.js';
import type { ApprovalGate } from './tools/approval.js';
import { type AnyTool, registerTools, selectTools, SessionMemo } from './tools/define-tool.js';
import { ALL_TOOLS } from './tools/index.js';
import { VERSION } from './version.js';

export interface BuildServerOptions {
  readonly mode: AuthMode;
  readonly graphql: GraphQLClient;
  readonly logger: Logger;
  /** Scopes on this session's token, resolved per call; `undefined` when not signed in. */
  grantedScopes(): Promise<ReadonlySet<Scope> | undefined>;
  /** The signed-in user's id (the access token's `sub`), when known. */
  viewerId?(): Promise<string | undefined>;
  /** Scopes the user approved, when BugSecure may grant fewer (hosted; see RegisterToolsOptions). */
  approvedScopes?(): Promise<ReadonlySet<Scope> | undefined>;
  readonly readOnly: boolean;
  /** Approval prompts for write tools. */
  readonly approvals: ApprovalGate;
  /** Per-caller tool invocation limit (hosted). */
  readonly rateLimit?: ((toolName: string) => void) | undefined;
  /** Defaults to every registered tool; injectable for tests. */
  readonly tools?: readonly AnyTool[];
}

export const SERVER_NAME = 'bugsecure-mcp';

export const buildServer = (options: BuildServerOptions): McpServer => {
  // Every tool is listed whatever the token's scopes (a call without them is
  // answered with the exact re-authorization to perform); --read-only removes
  // write tools entirely. The list is therefore the same for every caller.
  const tools = selectTools(options.tools ?? ALL_TOOLS, { readOnly: options.readOnly });

  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'BugSecure',
      version: VERSION,
      websiteUrl: 'https://github.com/kulinda-sec/bugsecure-mcp',
    },
    {
      // The tool list never changes while the server runs: say so, so clients
      // do not hold a `subscriptions/listen` stream open waiting for changes.
      capabilities: { tools: { listChanged: false } },
      instructions: serverInstructions({ readOnly: options.readOnly }),
      cacheHints: {
        // The same for every caller of a deployment, but served behind
        // authentication: cacheable privately; short enough to pick up an upgrade.
        'tools/list': { ttlMs: 600_000, cacheScope: 'private' },
      },
    },
  );

  registerTools(server, tools, {
    mode: options.mode,
    logger: options.logger,
    graphql: options.graphql,
    grantedScopes: () => options.grantedScopes(),
    viewerId: () => options.viewerId?.() ?? Promise.resolve(undefined),
    approvedScopes: () => options.approvedScopes?.() ?? Promise.resolve(undefined),
    // One per session: stdio builds one server per connection, hosted one per request.
    memo: new SessionMemo(),
    approvals: options.approvals,
    rateLimit: options.rateLimit,
  });
  return server;
};
