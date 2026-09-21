/**
 * Local mode: the MCP host spawns `bugsecure-mcp` and talks JSON-RPC over
 * stdin/stdout. This process is itself the OAuth client (`bugsecure-mcp-cli`)
 * and calls the API directly with the user's stored login. Per the MCP
 * authorization spec, stdio servers take credentials from their environment
 * (here: the OS keychain) rather than running an OAuth flow over the protocol.
 */
import { randomBytes } from 'node:crypto';

import type { Transport } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';

import {
  type CredentialStore,
  createCredentialStore,
  defaultConfigDir,
} from '../auth/stdio/credential-store.js';
import { LocalSession } from '../auth/stdio/session.js';
import type { LocalConfig } from '../config.js';
import { createGraphQLClient } from '../graphql/client.js';
import type { Logger } from '../logger.js';
import { buildServer } from '../server.js';
import { ApprovalGate, ApprovalReplayGuard } from '../tools/approval.js';

export interface RunStdioOptions {
  /** Injectable for tests; defaults to the configured store. */
  readonly store?: CredentialStore;
  /** Injectable for tests; defaults to stdio of this process. */
  readonly transport?: Transport;
}

const defaultStore = (config: LocalConfig, configDir: string, logger: Logger): Promise<CredentialStore> => {
  return createCredentialStore({ preference: config.credentialStore, configDir, logger });
};

export const runStdio = async (
  config: LocalConfig,
  logger: Logger,
  options: RunStdioOptions = {},
): Promise<StdioServerHandle> => {
  const configDir = config.configDir ?? defaultConfigDir();
  // Not `options.store ?? (await …)`: V8 coverage mis-attributes the rest of the
  // function to that short-circuited branch.
  const store = await (options.store === undefined
    ? defaultStore(config, configDir, logger)
    : Promise.resolve(options.store));
  const session = new LocalSession({
    issuer: config.issuer,
    resource: config.apiUrl,
    store,
    lockDir: configDir,
    logger,
  });
  const graphql = createGraphQLClient({
    url: config.graphqlUrl,
    tokens: session,
    timeoutMs: config.requestTimeoutMs,
    logger,
  });
  // One process serves one user through one client, and every approval round
  // comes back to this process: a per-process key and replay memory suffice.
  const approvals = new ApprovalGate({
    key: randomBytes(32),
    principal: 'local',
    replay: new ApprovalReplayGuard(),
    logger,
  });

  try {
    if ((await session.grantedScopes()) === undefined) {
      logger.warn('not signed in: tools will ask the user to run `bugsecure-mcp login`');
    }
  } catch (error) {
    logger.warn('stored credentials are not usable; tools will explain how to sign in', { error });
  }

  const handle = serveStdio(
    () =>
      buildServer({
        mode: 'local',
        graphql,
        logger,
        grantedScopes: () => session.grantedScopes(),
        viewerId: () => session.subject().catch(() => undefined),
        readOnly: config.readOnly,
        approvals,
      }),
    {
      ...(options.transport === undefined ? {} : { transport: options.transport }),
      onerror: (error) => {
        logger.warn('mcp stdio error', { error });
      },
    },
  );
  logger.info('bugsecure-mcp ready on stdio', {
    api: config.apiUrl,
    readOnly: config.readOnly,
    store: store.kind,
  });
  return handle;
};
