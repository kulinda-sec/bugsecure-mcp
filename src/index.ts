/**
 * Programmatic API. Most people use the `bugsecure-mcp` binary; this entry
 * point exists for embedding the server (e.g. behind your own HTTP stack) and
 * for tests. Anything not exported here is internal and may change.
 */
export { buildServer, type BuildServerOptions, SERVER_NAME } from './server.js';
export { createHttpApp, type HttpApp, type HttpAppOptions } from './transports/http-app.js';
export { createGraphQLClient, type AccessTokenProvider, type GraphQLClient } from './graphql/client.js';
export {
  defineTool,
  isWriteTool,
  selectTools,
  type AnyTool,
  type ToolContext,
  type ToolDefinition,
  type ToolHints,
  type ToolResult,
} from './tools/define-tool.js';
export { ALL_TOOLS } from './tools/index.js';
export { SCOPES, WRITE_SCOPES, type Scope } from './scopes.js';
export { untrusted, escapeUntrusted } from './untrusted.js';
export { BugSecureError, type ErrorCode } from './errors.js';
export { loadHostedConfig, loadLocalConfig, type HostedConfig, type LocalConfig } from './config.js';
export { createLogger, type Logger } from './logger.js';
export { VERSION } from './version.js';
