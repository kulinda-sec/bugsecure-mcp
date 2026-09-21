/**
 * CLI command implementations. Everything user-facing for login/logout/whoami
 * is printed here; the MCP server paths print nothing to stdout (it belongs to
 * the protocol) and log to stderr.
 */
import { createCredentialStore, defaultConfigDir } from '../auth/stdio/credential-store.js';
import { openBrowser } from '../auth/stdio/browser.js';
import { login } from '../auth/stdio/login.js';
import { decodeJwtPayload, logout } from '../auth/stdio/session.js';
import { type ConfigFlags, loadHostedConfig, loadLocalConfig } from '../config.js';
import { ORG_SCOPE_ELIGIBILITY, RESEARCHER_SCOPE_ELIGIBILITY } from '../errors.js';
import { ORG_GATED_SCOPES, parseScopeString, RESEARCHER_ONLY_SCOPES, type Scope } from '../scopes.js';
import { createLogger, type Logger } from '../logger.js';
import { PACKAGE_NAME, VERSION } from '../version.js';
import { type Command, HELP } from './args.js';

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: NodeJS.ProcessEnv;
}

/** Something that must stay alive until the process is signalled (a server). */
export interface Running {
  close(): Promise<void>;
}

/**
 * Why requested scopes are missing from a grant, if any are. The authorization
 * server only grants what the account can use now (organisation-side scopes
 * need a seat in an organisation that opted in; staff never get them), and the
 * user may also untick scopes on the consent screen.
 */
export const droppedScopesNotice = (requested: readonly Scope[], granted: ReadonlySet<Scope>): string => {
  const dropped = requested.filter((s) => !granted.has(s));
  if (dropped.length === 0) return '';
  const gated = dropped.some((s) => ORG_GATED_SCOPES.has(s))
    ? ` ${ORG_SCOPE_ELIGIBILITY} Tools needing them will explain what is missing.`
    : '';
  const researcher = dropped.some((s) => RESEARCHER_ONLY_SCOPES.has(s))
    ? ` ${RESEARCHER_SCOPE_ELIGIBILITY}`
    : '';
  return `Not granted: ${dropped.join(', ')} (declined on the consent screen, or not available to this account).${gated}${researcher}\n`;
};

const flags = (
  common: Extract<Command, { common: unknown }>['common'],
  extra: Partial<ConfigFlags> = {},
): ConfigFlags => {
  return { apiUrl: common.apiUrl, readOnly: common.readOnly, logLevel: common.logLevel, ...extra };
};

const localContext = async (common: Extract<Command, { common: unknown }>['common'], io: CliIo) => {
  const config = loadLocalConfig(io.env, flags(common));
  const logger: Logger = createLogger({ level: config.logLevel, write: io.stderr });
  const configDir = config.configDir ?? defaultConfigDir(io.env);
  const store = await createCredentialStore({ preference: config.credentialStore, configDir, logger });
  return { config, logger, store, configDir };
};

/** Runs a command. Returns an exit code, or a running server for long-lived commands. */
export const runCommand = async (command: Command, io: CliIo): Promise<number | Running> => {
  switch (command.kind) {
    case 'help':
      io.stdout(HELP);
      return 0;

    case 'version':
      io.stdout(`${PACKAGE_NAME} ${VERSION}\n`);
      return 0;

    case 'stdio': {
      const config = loadLocalConfig(io.env, flags(command.common));
      const logger = createLogger({ level: config.logLevel, write: io.stderr });
      const { runStdio } = await import('../transports/stdio.js');
      return runStdio(config, logger);
    }

    case 'http': {
      const config = loadHostedConfig(
        io.env,
        flags(command.common, {
          ...(command.host === undefined ? {} : { host: command.host }),
          ...(command.port === undefined ? {} : { port: command.port }),
        }),
      );
      const logger = createLogger({ level: config.logLevel, write: io.stderr });
      const { runHosted } = await import('../transports/hosted.js');
      return runHosted(config, logger);
    }

    case 'login': {
      const { config, store, configDir } = await localContext(command.common, io);
      io.stderr(`Signing in to ${config.apiUrl} with scopes: ${command.scopes.join(', ')}\n`);
      const credentials = await login({
        config,
        scopes: command.scopes,
        store,
        lockDir: configDir,
        presentUrl: async (url) => {
          io.stderr(`\nOpen this URL in your browser to approve access:\n\n  ${url}\n\n`);
          if (command.openBrowser && !(await openBrowser(url))) {
            io.stderr('(Could not open a browser automatically; copy the URL above.)\n');
          }
          io.stderr('Waiting for approval…\n');
        },
      });
      io.stderr(
        `\nSigned in. Granted scopes: ${credentials.scope || '(none)'}\nCredentials stored in: ${store.location}\n` +
          droppedScopesNotice(command.scopes, parseScopeString(credentials.scope)) +
          'Restart your MCP client to pick up the new permissions.\n',
      );
      return 0;
    }

    case 'logout': {
      const { config, logger, store, configDir } = await localContext(command.common, io);
      const result = await logout({ issuer: config.issuer, store, lockDir: configDir, logger });
      if (!result.hadCredentials) io.stderr('Not signed in.\n');
      else
        io.stderr(
          result.revoked
            ? 'Signed out; access revoked.\n'
            : 'Signed out locally (revocation could not be confirmed).\n',
        );
      return 0;
    }

    case 'whoami': {
      const { config, store } = await localContext(command.common, io);
      const stored = await store.load(config.issuer);
      if (!stored) {
        io.stderr(`Not signed in to ${config.issuer}. Run: ${PACKAGE_NAME.replace(/^@[^/]+\//, '')} login\n`);
        return 1;
      }
      const claims = decodeJwtPayload(stored.accessToken) ?? {};
      const info = {
        issuer: stored.issuer,
        api: stored.resource,
        subject: typeof claims.sub === 'string' ? claims.sub : undefined,
        clientId: stored.clientId,
        scopes: stored.scope.split(' ').filter((s) => s !== ''),
        accessTokenExpiresAt: new Date(stored.accessTokenExpiresAt * 1000).toISOString(),
        refreshable: stored.refreshToken !== undefined,
        store: store.location,
      };
      if (command.json) {
        io.stdout(`${JSON.stringify(info, null, 2)}\n`);
      } else {
        io.stdout(
          [
            `Issuer:        ${info.issuer}`,
            `API:           ${info.api}${info.api === config.apiUrl ? '' : `  (NOT the configured ${config.apiUrl}: run login again)`}`,
            `Account (sub): ${info.subject ?? 'unknown'}`,
            `Client:        ${info.clientId}`,
            `Scopes:        ${info.scopes.join(' ') || '(none)'}`,
            `Access token:  expires ${info.accessTokenExpiresAt}${info.refreshable ? ' (refreshed automatically)' : ''}`,
            `Stored in:     ${info.store}`,
            '(Token contents are decoded locally for display, not verified.)',
            '',
          ].join('\n'),
        );
      }
      return 0;
    }
  }
};
