/**
 * A cross-process mutex built on `open(path, 'wx')` (O_CREAT|O_EXCL).
 *
 * Why: several MCP clients (desktop app, IDE, CLI) may each run their own
 * `bugsecure-mcp` process sharing one login, and `login`/`logout` may run
 * while they do. Refresh tokens rotate on every use and the authorization
 * server treats a *reused* refresh token as theft, revoking the whole grant.
 * Every read-modify-write of the stored credentials (refresh, login, logout)
 * therefore runs under this lock: refreshes are strictly sequential, and a
 * refresh can never overwrite a login that completed while it waited.
 *
 * Robustness:
 * - the lock file holds a random owner token; it is removed only by the
 *   owner, and only while it still holds that token — so a holder that was
 *   presumed dead and had its lock broken cannot delete its successor's lock;
 * - the owner refreshes the file's mtime (a heartbeat) while it works, so a
 *   long but live critical section is never mistaken for an abandoned one;
 * - a lock whose heartbeat stopped for `staleMs` (holder crashed) is broken.
 */
import { mkdir, open, readFile, rm, stat, utimes } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { randomToken } from '../../crypto.js';

export interface FileLockOptions {
  /** Give up waiting after this long. */
  readonly timeoutMs?: number;
  /** A lock whose heartbeat is older than this is assumed abandoned and broken. */
  readonly staleMs?: number;
  readonly pollMs?: number;
}

export class LockTimeoutError extends Error {
  override readonly name = 'LockTimeoutError';
}

const readOwner = async (path: string): Promise<string | undefined> => {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch {
    return undefined;
  }
};

const tryAcquire = async (path: string, owner: string): Promise<boolean> => {
  try {
    const handle = await open(path, 'wx', 0o600);
    try {
      await handle.writeFile(`${owner}\n`);
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
};

export const withFileLock = async <T>(
  path: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> => {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const staleMs = options.staleMs ?? 30_000;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  const owner = `${String(process.pid)}:${randomToken(16)}`;

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  while (!(await tryAcquire(path, owner))) {
    try {
      const { mtimeMs } = await stat(path);
      if (Date.now() - mtimeMs > staleMs) {
        // Break it only if it is still the same abandoned lock we just judged stale.
        const stale = await readOwner(path);
        const again = await stat(path);
        if (again.mtimeMs === mtimeMs && (await readOwner(path)) === stale) await rm(path, { force: true });
        continue;
      }
    } catch {
      continue; // vanished between open and stat: retry immediately
    }
    if (Date.now() >= deadline) throw new LockTimeoutError(`Timed out waiting for ${path}`);
    await sleep(pollMs);
  }

  // Heartbeat: keep the lock visibly alive while fn() runs.
  const heartbeat = setInterval(
    () => {
      const now = new Date();
      utimes(path, now, now).catch(() => undefined);
    },
    Math.max(50, Math.floor(staleMs / 3)),
  );
  heartbeat.unref();
  try {
    return await fn();
  } finally {
    clearInterval(heartbeat);
    // Release only our own lock.
    if ((await readOwner(path)) === owner) await rm(path, { force: true });
  }
};
