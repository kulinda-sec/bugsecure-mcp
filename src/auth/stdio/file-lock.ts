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
 * - a lock whose heartbeat stopped for `staleMs` (holder crashed) is broken,
 *   by one waiter at a time, which removes it only if it is still that same
 *   abandoned file and never deletes a live lock (`breakStaleLock`);
 * - files a crash left beside the lock (`<lock>.stale-…`, moved aside while
 *   being broken) are swept once they are older than `staleMs`;
 * - a file system error while breaking a lock is not waited out: one that
 *   cannot pass (a permission denied, say) is thrown at once, and a transient
 *   one that lasts until the timeout is named in the LockTimeoutError.
 */
import type { BigIntStats } from 'node:fs';
import { link, mkdir, open, readdir, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Same file, untouched since: same inode on the same device, same modification time. */
const sameLockFile = (a: BigIntStats, b: BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs;

const statOf = async (path: string): Promise<BigIntStats | undefined> => {
  try {
    return await stat(path, { bigint: true });
  } catch {
    return undefined;
  }
};

/**
 * Move the lock file judged stale out of the way and delete it, or, if what
 * was moved turns out not to be that file, put it back. Never deletes a lock
 * that is not the one judged stale.
 *
 * `rename` is atomic, so what is examined is exactly what was taken from the
 * lock path, and nobody else can take it any more. A live lock moved by
 * mistake (its owner heartbeat after all, or released and a new holder took
 * the lock in between) is put back with `link`, which fails rather than
 * replace a lock someone took in the instant it was away. Only in that
 * instant can two holders overlap; the moved-away owner then finds another
 * owner's token at release and leaves it alone.
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
  try {
    await link(aside, path);
  } catch (error) {
    if (errno(error) !== 'EEXIST') {
      // No hard links on this file system: move it back. Unlike `link`, this would replace
      // a lock taken in the instant it was away: the same, rare overlap as above.
      await rename(aside, path);
      return false;
    }
  }
  await rm(aside, { force: true });
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
    const info = await statOf(file);
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
 * Several waiters often judge the same abandoned lock stale together. With a
 * plain check-then-delete, a slow one would delete the lock a faster one had
 * already broken and re-acquired. So breaking is itself serialised, by a
 * short-lived second lock (`<path>.break`, O_EXCL like the lock): its holder
 * checks again that the lock file is still the one judged stale (same inode,
 * device and mtime: no heartbeat, no new holder) and only then removes it
 * (`removeIfStill`). Waiters that find a break in progress wait and look again.
 * A breaker lock left by a crashed breaker is removed once it is older than
 * `staleMs`, with the same identity-checked removal (`removeIfStill`); it is
 * held for a few file system calls, so that takes a crash in exactly that
 * moment.
 *
 * Exported for tests.
 */
export const breakStaleLock = async (
  path: string,
  judged: BigIntStats,
  staleMs: number,
): Promise<boolean> => {
  const breaker = `${path}.break`;
  const token = `${String(process.pid)}:${randomToken(16)}`;
  if (!(await tryAcquire(breaker, token))) {
    const held = await statOf(breaker);
    // A breaker lock abandoned by a crash: removed exactly like the lock itself, so a
    // breaker that just took it afresh (a new file, or a new mtime) is never deleted.
    if (held !== undefined && Date.now() - Number(held.mtimeMs) > staleMs) {
      await removeIfStill(breaker, held);
    }
    return false;
  }
  try {
    const current = await statOf(path);
    if (current === undefined) return true;
    if (!sameLockFile(current, judged)) return false; // a heartbeat, or a new holder: not stale
    return await removeIfStill(path, judged);
  } finally {
    if ((await readOwner(breaker)) === token) await rm(breaker, { force: true });
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
  while (!(await tryAcquire(path, owner))) {
    let judged: BigIntStats;
    try {
      judged = await stat(path, { bigint: true });
    } catch {
      continue; // vanished between open and stat: retry immediately
    }
    if (Date.now() - Number(judged.mtimeMs) > staleMs) {
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
  // Holding a fresh lock (nobody judges it stale): a good moment to clear what crashes left.
  await sweepStaleAside(path, staleMs);

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
