/**
 * Where `bugsecure-mcp login` keeps its tokens.
 *
 * 1. The OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret
 *    Service) via @napi-rs/keyring — the default whenever it works.
 * 2. Otherwise a JSON file in the user config directory, created with mode
 *    0600 inside a 0700 directory, written atomically, with a warning on
 *    stderr. (On Windows the file inherits the user profile's ACL.)
 *
 * Credentials are keyed by the authorization server's issuer, as the MCP
 * authorization spec requires (SEP-2352): tokens from one issuer are never
 * offered to another.
 */
import { chmod, type FileHandle, mkdir, open, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as z from 'zod';

import { randomToken } from '../../crypto.js';
import type { Logger } from '../../logger.js';

export const StoredCredentialsSchema = z.object({
  version: z.literal(1),
  issuer: z.string(),
  clientId: z.string(),
  /** RFC 8707 resource the tokens are bound to (the API URL). */
  resource: z.string(),
  tokenEndpoint: z.string(),
  revocationEndpoint: z.string().optional(),
  accessToken: z.string(),
  /** Seconds since the epoch. */
  accessTokenExpiresAt: z.number(),
  refreshToken: z.string().optional(),
  scope: z.string(),
  obtainedAt: z.number(),
});
export type StoredCredentials = z.infer<typeof StoredCredentialsSchema>;

export interface CredentialStore {
  readonly kind: 'keychain' | 'file';
  /** Human-readable location, for `whoami`/`logout` output. */
  readonly location: string;
  load(issuer: string): Promise<StoredCredentials | undefined>;
  save(credentials: StoredCredentials): Promise<void>;
  delete(issuer: string): Promise<boolean>;
}

export const KEYCHAIN_SERVICE = 'bugsecure-mcp';

/** Per-user config directory, following each platform's convention. */
export const defaultConfigDir = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string => {
  if (platform === 'win32')
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'bugsecure-mcp');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'bugsecure-mcp');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'bugsecure-mcp');
};

const parseStored = (raw: string): StoredCredentials | undefined => {
  try {
    const parsed = StoredCredentialsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** The subset of @napi-rs/keyring's AsyncEntry we use (injectable for tests). */
export interface KeyringEntry {
  getPassword(): Promise<string | undefined | null>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
export type KeyringFactory = (service: string, account: string) => KeyringEntry;

export const createKeychainStore = (factory: KeyringFactory): CredentialStore => {
  return {
    kind: 'keychain',
    location: `OS keychain (service "${KEYCHAIN_SERVICE}")`,
    async load(issuer) {
      const raw = await factory(KEYCHAIN_SERVICE, issuer).getPassword();
      return raw ? parseStored(raw) : undefined;
    },
    async save(credentials) {
      await factory(KEYCHAIN_SERVICE, credentials.issuer).setPassword(JSON.stringify(credentials));
    },
    async delete(issuer) {
      return factory(KEYCHAIN_SERVICE, issuer).deletePassword();
    },
  };
};

const FileSchema = z.object({ version: z.literal(1), entries: z.record(z.string(), z.unknown()) });

export const createFileStore = (dir: string, logger: Logger): CredentialStore => {
  const path = join(dir, 'credentials.json');

  const readAll = async (): Promise<Record<string, unknown>> => {
    // One handle for the check, the chmod and the read: by path, the file
    // could be swapped between them.
    let handle: FileHandle;
    try {
      handle = await open(path, 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    let raw: string;
    try {
      const info = await handle.stat();
      if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
        logger.warn('credentials file was readable by other users; restricting it to 0600', { path });
        await handle.chmod(0o600);
      }
      raw = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    try {
      const parsed = FileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data.entries;
    } catch {
      // fall through
    }
    logger.warn('ignoring unreadable credentials file', { path });
    return {};
  };

  const writeAll = async (entries: Record<string, unknown>): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(dir, 0o700);
    // Atomic replace: write a private temp file, fsync, rename over the target.
    const tmp = join(dir, `.credentials.${randomToken(8)}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  };

  return {
    kind: 'file',
    location: path,
    async load(issuer) {
      const entry = (await readAll())[issuer];
      return entry === undefined ? undefined : parseStored(JSON.stringify(entry));
    },
    async save(credentials) {
      const entries = await readAll();
      entries[credentials.issuer] = credentials;
      await writeAll(entries);
    },
    async delete(issuer) {
      const entries = await readAll();
      if (!(issuer in entries)) return false;
      // Build a new object rather than `delete` on a dynamic key.
      await writeAll(Object.fromEntries(Object.entries(entries).filter(([k]) => k !== issuer)));
      return true;
    },
  };
};

/** Load @napi-rs/keyring lazily: hosted deployments never need the native module. */
export const loadKeyring = async (): Promise<KeyringFactory | undefined> => {
  try {
    const { AsyncEntry } = await import('@napi-rs/keyring');
    return (service, account) => new AsyncEntry(service, account);
  } catch {
    return undefined;
  }
};

export interface CreateStoreOptions {
  readonly preference: 'auto' | 'keychain' | 'file';
  readonly configDir: string;
  readonly logger: Logger;
  /** Injectable for tests; defaults to @napi-rs/keyring. */
  readonly keyring?: KeyringFactory | undefined;
}

/**
 * Pick the credential store. `auto` probes the keychain with a harmless read
 * and falls back to the 0600 file (with a warning) if no keychain backend is
 * available, e.g. a headless Linux box without a Secret Service.
 */
export const createCredentialStore = async (options: CreateStoreOptions): Promise<CredentialStore> => {
  const fileStore = (): CredentialStore => createFileStore(options.configDir, options.logger);
  if (options.preference === 'file') return fileStore();

  const factory = options.keyring ?? (await loadKeyring());
  if (factory) {
    try {
      await factory(KEYCHAIN_SERVICE, '__probe__').getPassword();
      return createKeychainStore(factory);
    } catch (error) {
      if (options.preference === 'keychain') throw error;
    }
  } else if (options.preference === 'keychain') {
    throw new Error('The OS keychain is not available on this system (BUGSECURE_CREDENTIAL_STORE=keychain).');
  }
  const store = fileStore();
  options.logger.warn(
    'No OS keychain available; storing BugSecure credentials in a file readable only by you (0600). Set BUGSECURE_CREDENTIAL_STORE=file to silence this warning.',
    { path: store.location },
  );
  return store;
};
