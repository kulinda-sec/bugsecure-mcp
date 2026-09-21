#!/usr/bin/env node
/**
 * Entry point for the `bugsecure-mcp` binary.
 */
import { UsageError, parseCommandLine } from './cli/args.js';
import { runCommand } from './cli/commands.js';
import { ConfigError } from './config.js';
import { OAuthRequestError } from './auth/oauth.js';
import { LoginError } from './auth/stdio/loopback.js';
import { BugSecureError } from './errors.js';

const io = {
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
  env: process.env,
};

const main = async (): Promise<void> => {
  const command = parseCommandLine(process.argv.slice(2));
  const result = await runCommand(command, io);
  if (typeof result === 'number') {
    process.exitCode = result;
    return;
  }
  // A long-running server: shut down cleanly on the usual signals.
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    result.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    io.stderr(`${error.message}\nRun \`bugsecure-mcp --help\` for usage.\n`);
    process.exitCode = 2;
  } else if (
    error instanceof ConfigError ||
    error instanceof OAuthRequestError ||
    error instanceof LoginError ||
    error instanceof BugSecureError
  ) {
    io.stderr(`bugsecure-mcp: ${error.message}\n`);
    process.exitCode = 1;
  } else {
    io.stderr(`bugsecure-mcp: unexpected error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
});
