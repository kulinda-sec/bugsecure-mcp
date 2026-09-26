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
 * - acquisition, release and stale recovery share a short-lived guard, so
 *   nobody can acquire the path while a stale file is being examined;
 * - a stale lock is left alone while its owner process is still alive;
 * - a crash while holding the guard fails closed: it must be removed after
 *   stopping all clients. Automatically stealing that guard would merely
 *   move the same recovery race to a second file;
 * - files a crash left beside the lock (`<lock>.stale-…`, moved aside while
 *   being broken) are swept once they are older than `staleMs`;
 * - a file system error while breaking a lock is not waited out: one that
 *   cannot pass (a permission denied, say) is thrown at once, and a transient
 *   one that lasts until the timeout is named in the LockTimeoutError.
 */
import type { BigIntStats } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { randomToken } from '../../crypto.js';
import { createLogger, type Logger } from '../../logger.js';

const defaultLogger = createLogger({ level: 'warn' });

export interface FileLockOptions {
  /** Give up waiting after this long. */
  readonly timeoutMs?: number;
  /** After this age, recover a dead owner's lock or explain why recovery needs a human. */
  readonly staleMs?: number;
  readonly pollMs?: number;
  /** Reports cleanup failures without replacing the protected operation's result. */
  readonly logger?: Logger;
}

export class LockTimeoutError extends Error {
  override readonly name = 'LockTimeoutError';
  readonly hint: string | undefined;

  constructor(message: string, options: ErrorOptions & { readonly hint?: string } = {}) {
    super(message, options);
    this.hint = options.hint;
  }
}

export class AbandonedLockGuardError extends LockTimeoutError {
  constructor(path: string) {
    super(`The credentials lock guard at ${path} is stale.`, {
      hint: `Stop all bugsecure-mcp processes, then remove the lock guard at ${path} and restart the clients. Do not remove it while any client is running.`,
    });
  }
}

export class StaleLockOwnerError extends LockTimeoutError {
  constructor(path: string, pid: number) {
    super(
      `The stale credentials lock at ${path} names PID ${String(pid)}, which is still alive or cannot be checked.`,
      {
        hint: `Stop all bugsecure-mcp processes, then verify that PID ${String(pid)} is not a bugsecure-mcp process before removing ${path} and restarting the clients. The PID may have been reused. Do not remove the file while any client is running.`,
      },
    );
  }
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

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** A paused process can resume with a rotating refresh token: never steal its lock. */
const liveOwnerPid = (owner: string | undefined): number | undefined => {
  const pid = Number(/^(\d+)(?::|$)/.exec(owner ?? '')?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    process.kill(pid, 0);
    return pid;
  } catch (error) {
    // Permission denied or an unknown error is not proof that the process died.
    return errno(error) === 'ESRCH' ? undefined : pid;
  }
};

/** Same file, untouched since: same inode on the same device, same modification time. */
const sameLockFile = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs;

const statOf = async (path: string): Promise<BigIntStats | undefined> => {
  try {
    return await stat(path, { bigint: true });
  } catch (error) {
    if (errno(error) === 'ENOENT') return undefined;
    throw error;
  }
};

/**
 * Shared by every acquisition, release and stale recovery. Never steal this
 * guard: a checked-then-removed guard can be replaced between the two calls.
 */
const tryGuarded = async <T>(path: string, staleMs: number, fn: () => Promise<T>): Promise<T | undefined> => {
  const guard = `${path}.break`;
  if (!(await tryAcquire(guard, `${String(process.pid)}:${randomToken(16)}`))) {
    const held = await statOf(guard);
    if (held !== undefined && Date.now() - Number(held.mtimeMs) > staleMs) {
      const owner = await readOwner(guard);
      const current = await statOf(guard);
      if (current !== undefined && sameLockFile(current, held)) {
        const pid = liveOwnerPid(owner);
        if (pid !== undefined) throw new StaleLockOwnerError(guard, pid);
        throw new AbandonedLockGuardError(guard);
      }
    }
    return undefined;
  }
  try {
    return await fn();
  } finally {
    // No other process removes or replaces an owned guard.
    await rm(guard, { force: true });
  }
};

/**
 * Move the lock file judged stale out of the way and delete it, or, if what
 * was moved turns out not to be that file, put it back. Never deletes a lock
 * that is not the one judged stale.
 *
 * Called only under the shared guard: nobody can acquire or release the
 * path until the moved file has been checked and, if necessary, restored.
 */
const removeIfStill = async (path: string, judged: BigIntStats): Promise<boolean> => {
  const aside = `${path}${STALE_SUFFIX}${String(process.pid)}-${randomToken(9)}`;
  try {
    await rename(path, aside);
  } catch (error) {
    if (errno(error) === 'ENOENT') return true; // gone already: try to acquire
    throw error;
  }
  const moved = await statOf(aside);
  // Gone from aside already: only a sweep removes these, and it removes only stale files.
  if (moved === undefined) return true;
  if (sameLockFile(moved, judged)) {
    await rm(aside, { force: true });
    return true;
  }
  await rename(aside, path);
  return false;
};

/** What `removeIfStill` names a file it moved aside: `<path>.stale-<pid>-<random>`. */
const STALE_SUFFIX = '.stale-';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Delete the files `removeIfStill` moved aside and a crash left behind (for the
 * lock and for its breaker lock), once older than `staleMs`. Age counts from
 * the last change of the file itself (ctime: a rename sets it), so a file
 * another process has just moved aside and is still examining is never taken.
 * Best effort: a sweep that fails is left for the next one.
 *
 * Exported for tests.
 */
export const sweepStaleAside = async (path: string, staleMs: number, now = Date.now()): Promise<void> => {
  const dir = dirname(path);
  const leftover = new RegExp(
    `^${escapeRegExp(basename(path))}(?:\\.break)?${escapeRegExp(STALE_SUFFIX)}\\d+-[A-Za-z0-9_-]+$`,
  );
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names.filter((n) => leftover.test(n))) {
    const file = join(dir, name);
    const info = await statOf(file).catch(() => undefined);
    if (info === undefined) continue;
    const changed = Math.max(Number(info.mtimeMs), Number(info.ctimeMs));
    if (now - changed > staleMs) await rm(file, { force: true }).catch(() => undefined);
  }
};

/**
 * Errors of breaking a stale lock that can pass by themselves, so the waiter
 * waits and looks again: the file vanished or appeared in between, or, on
 * Windows, another process has it open. Anything else is thrown.
 */
const isTransient = (error: unknown): boolean => {
  const code = errno(error);
  if (code === 'ENOENT' || code === 'EEXIST' || code === 'EBUSY') return true;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES');
};

/**
 * Break the lock at `path`, judged stale from `judged` (its stat when found
 * stale). Resolves `true` when the lock path may now be free (try to acquire
 * at once), `false` when it should be left alone for now.
 *
 * The same guard protects acquisitions, so the temporary absence of the
 * lock during `removeIfStill` cannot admit a second owner. A live owner is
 * never broken merely because its heartbeat was delayed.
 *
 * Exported for tests.
 */
export const breakStaleLock = async (
  path: string,
  judged: BigIntStats,
  staleMs: number,
): Promise<boolean> => {
  return (
    (await tryGuarded(path, staleMs, async () => {
      const current = await statOf(path);
      if (current === undefined) return true;
      if (!sameLockFile(current, judged)) return false; // a heartbeat, or a new holder: not stale
      const pid = liveOwnerPid(await readOwner(path));
      if (pid !== undefined) throw new StaleLockOwnerError(path, pid);
      return await removeIfStill(path, judged);
    })) ?? false
  );
};

const releaseLock = async (
  path: string,
  owner: string,
  staleMs: number,
  timeoutMs: number,
  pollMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (
    !(await tryGuarded(path, staleMs, async () => {
      if ((await readOwner(path)) === owner) await rm(path, { force: true });
      return true;
    }))
  ) {
    if (Date.now() >= deadline) throw new LockTimeoutError(`Timed out releasing ${path}`);
    await sleep(pollMs);
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
  /** The last transient error breaking a stale lock, named if it lasts until the timeout. */
  let breakError: unknown;
  while (!(await tryGuarded(path, staleMs, () => tryAcquire(path, owner)))) {
    const judged = await statOf(path);
    if (judged !== undefined && Date.now() - Number(judged.mtimeMs) > staleMs) {
      let free = false;
      try {
        free = await breakStaleLock(path, judged, staleMs);
        breakError = undefined;
      } catch (error) {
        if (!isTransient(error)) throw error; // e.g. permission denied: waiting will not help
        breakError = error; // e.g. the file is busy (Windows): wait and look again
      }
      if (free) continue;
    }
    if (Date.now() >= deadline) {
      throw new LockTimeoutError(
        breakError === undefined
          ? `Timed out waiting for ${path}`
          : `Timed out waiting for ${path}: its stale lock could not be broken (${errno(breakError) ?? 'error'})`,
        breakError === undefined ? undefined : { cause: breakError },
      );
    }
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
    await sweepStaleAside(path, staleMs);
    return await fn();
  } finally {
    clearInterval(heartbeat);
    try {
      await releaseLock(path, owner, staleMs, timeoutMs, pollMs);
    } catch (error) {
      // The operation may have already rotated and stored credentials. Cleanup
      // must neither turn that success into a failure nor hide its original error.
      // A remaining lock stays excluded while this process lives; subsequent
      // acquisitions explain recovery once it or its guard is stale.
      try {
        (options.logger ?? defaultLogger).warn(
          'credentials lock release failed; operation outcome preserved',
          {
            path,
            error,
          },
        );
      } catch {
        // A failed diagnostic sink must not replace the operation's outcome either.
      }
    }
  }
};
