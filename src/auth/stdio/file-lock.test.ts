import {
  type BigIntStats,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { silentLogger } from '../../logger.js';

import {
  AbandonedLockGuardError,
  breakStaleLock,
  LockTimeoutError,
  StaleLockOwnerError,
  sweepStaleAside,
  withFileLock,
} from './file-lock.js';

const lockPath = (): string => join(mkdtempSync(join(tmpdir(), 'bsmcp-flock-')), 'x.lock');
const FIXTURE_PID = process.pid + 1;

beforeEach(() => {
  // Only this test's current process is alive unless a case says otherwise.
  // Never query a real host PID for a synthetic crashed owner.
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    expect(signal).toBe(0);
    if (pid === process.pid) return true;
    throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
  });
});

/**
 * A lock file's identity (device, inode, mtime): what `breakStaleLock` compares.
 * Read through a descriptor, so the stat is of the file that was opened, not
 * of whatever the path names by the time of the next call.
 */
const identityOf = (path: string): BigIntStats => {
  const fd = openSync(path, 'r');
  try {
    return fstatSync(fd, { bigint: true });
  } finally {
    closeSync(fd);
  }
};

describe('withFileLock', () => {
  it('serialises critical sections', async () => {
    const path = lockPath();
    const events: string[] = [];
    const section = (name: string) =>
      withFileLock(
        path,
        async () => {
          events.push(`${name}:start`);
          await sleep(20);
          events.push(`${name}:end`);
        },
        { pollMs: 5 },
      );
    await Promise.all([section('a'), section('b')]);
    expect(events).toHaveLength(4);
    expect(events[0]?.endsWith(':start')).toBe(true);
    expect(events[1]?.endsWith(':end')).toBe(true); // no interleaving
  });

  it('releases the lock when the section throws', async () => {
    const path = lockPath();
    await expect(withFileLock(path, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(withFileLock(path, () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('breaks a stale lock left by a crashed process', async () => {
    const path = lockPath();
    writeFileSync(path, `${String(FIXTURE_PID)}\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    await expect(withFileLock(path, () => Promise.resolve('ok'), { staleMs: 1_000 })).resolves.toBe('ok');
  });

  it('lets exactly one of several waiters break a stale lock, and never runs two sections at once', async () => {
    const path = lockPath();
    writeFileSync(path, `${String(FIXTURE_PID)}:crashed\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    let active = 0;
    let most = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withFileLock(
          path,
          async () => {
            active += 1;
            most = Math.max(most, active);
            await sleep(5);
            active -= 1;
            done.push(i);
          },
          { staleMs: 1_000, pollMs: 2, timeoutMs: 5_000 },
        ),
      ),
    );
    expect(most).toBe(1);
    expect(done.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // Nothing left behind: no lock, no set-aside copies.
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  it('deletes the stale lock it judged, and nothing else', async () => {
    const path = lockPath();
    writeFileSync(path, `${String(FIXTURE_PID)}:crashed\n`);
    const judged = identityOf(path);
    await expect(breakStaleLock(path, judged, 1_000)).resolves.toBe(true);
    expect(readdirSync(dirname(path))).toEqual([]);
    // Already broken by someone else: nothing to do but try to acquire.
    await expect(breakStaleLock(path, judged, 1_000)).resolves.toBe(true);
  });

  it('leaves alone a live lock that replaced the stale one after it was judged', async () => {
    const path = lockPath();
    writeFileSync(path, `${String(FIXTURE_PID)}:crashed\n`);
    const judged = identityOf(path);
    // Meanwhile a faster waiter broke the stale lock and took the lock: a new file, a live owner.
    renameSync(path, `${path}.gone`);
    writeFileSync(path, 'live-owner\n');
    const live = identityOf(path);

    await expect(breakStaleLock(path, judged, 1_000)).resolves.toBe(false);

    expect(readFileSync(path, 'utf8')).toBe('live-owner\n');
    const now = identityOf(path);
    expect([now.ino, now.mtimeNs]).toEqual([live.ino, live.mtimeNs]); // the same file, untouched
    expect(readdirSync(dirname(path)).sort()).toEqual(['x.lock', 'x.lock.gone']);
  });

  it('leaves alone a lock whose heartbeat came after it was judged stale', async () => {
    const path = lockPath();
    writeFileSync(path, 'slow-owner\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    const judged = identityOf(path);
    const now = new Date();
    utimesSync(path, now, now); // the owner was alive after all

    await expect(breakStaleLock(path, judged, 1_000)).resolves.toBe(false);

    expect(readFileSync(path, 'utf8')).toBe('slow-owner\n');
    expect(readdirSync(dirname(path))).toEqual(['x.lock']);
  });

  it('waits for an active guard and fails closed for an abandoned guard', async () => {
    const path = lockPath();
    writeFileSync(path, `${String(FIXTURE_PID)}:crashed\n`);
    const judged = identityOf(path);
    writeFileSync(`${path}.break`, 'breaking\n');

    await expect(breakStaleLock(path, judged, 1_000)).resolves.toBe(false);
    expect(existsSync(path)).toBe(true); // not while someone else is breaking it

    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.break`, old, old); // that breaker crashed
    await expect(breakStaleLock(path, judged, 1_000)).rejects.toBeInstanceOf(AbandonedLockGuardError);
    expect(readFileSync(`${path}.break`, 'utf8')).toBe('breaking\n');
    await expect(withFileLock(path, () => Promise.resolve(), { staleMs: 1_000 })).rejects.toMatchObject({
      hint: expect.stringContaining('Stop all bugsecure-mcp processes') as string,
    });
    // Simulate the documented manual recovery after stopping every client.
    rmSync(`${path}.break`);
    await expect(breakStaleLock(path, judged, 1_000)).resolves.toBe(true);
    expect(readdirSync(dirname(path))).toEqual([]);
  });

  it('never steals an expired lock from a live process, even before its next heartbeat', async () => {
    const path = lockPath();
    writeFileSync(path, `${String(process.pid)}:paused-owner\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    const judged = identityOf(path);

    await expect(breakStaleLock(path, judged, 1_000)).rejects.toBeInstanceOf(StaleLockOwnerError);
    await expect(
      withFileLock(path, () => Promise.resolve(), {
        staleMs: 1_000,
        timeoutMs: 40,
        pollMs: 5,
      }),
    ).rejects.toBeInstanceOf(StaleLockOwnerError);
    expect(readFileSync(path, 'utf8')).toBe(`${String(process.pid)}:paused-owner\n`);
  });

  it('does not treat a live guard owner as abandoned when its timestamp is old', async () => {
    const path = lockPath();
    writeFileSync(`${path}.break`, `${String(process.pid)}:paused-guard\n`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${path}.break`, old, old);
    const error = await withFileLock(path, () => Promise.resolve(), {
      staleMs: 1_000,
      timeoutMs: 40,
      pollMs: 5,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StaleLockOwnerError);
    expect(error).not.toBeInstanceOf(AbandonedLockGuardError);
    expect(existsSync(path)).toBe(false);
  });

  it.each([
    ['', 'alive'],
    ['', 'EPERM'],
    ['', 'EIO'],
    ['.break', 'alive'],
    ['.break', 'EPERM'],
    ['.break', 'EIO'],
  ])('explains a stale lock%s with a reused or uncertain PID (%s)', async (suffix, state) => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (state === 'alive') return true;
      throw Object.assign(new Error('Cannot inspect process'), { code: state });
    });
    const path = lockPath();
    const blocked = `${path}${suffix}`;
    const owner = `${String(FIXTURE_PID)}:previous-process\n`;
    writeFileSync(blocked, owner);
    const old = new Date(Date.now() - 60_000);
    utimesSync(blocked, old, old);
    const work = vi.fn(() => Promise.resolve());

    const error = await withFileLock(path, work, { staleMs: 1_000 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(StaleLockOwnerError);
    expect((error as StaleLockOwnerError).message).toContain(blocked);
    expect((error as StaleLockOwnerError).message).toContain(String(FIXTURE_PID));
    expect((error as StaleLockOwnerError).hint).toContain('Stop all bugsecure-mcp processes');
    expect((error as StaleLockOwnerError).hint).toContain('PID may have been reused');
    expect(readFileSync(blocked, 'utf8')).toBe(owner);
    expect(work).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'preserves successful work when release fails (abandoned guard: %s)',
    async (abandoned) => {
      const path = lockPath();
      const guard = `${path}.break`;
      const warn = vi.fn();
      const result = { stored: true };

      await expect(
        withFileLock(
          path,
          () => {
            writeFileSync(guard, abandoned ? 'abandoned' : `${String(process.pid)}:busy`);
            if (abandoned) {
              const old = new Date(Date.now() - 60_000);
              utimesSync(guard, old, old);
            }
            return Promise.resolve(result);
          },
          { timeoutMs: 20, pollMs: 5, logger: { ...silentLogger, warn } },
        ),
      ).resolves.toBe(result);

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'credentials lock release failed; operation outcome preserved',
        { path, error: expect.any(LockTimeoutError) as unknown },
      );
      expect(existsSync(path)).toBe(true);
      if (abandoned) {
        await expect(withFileLock(path, () => Promise.resolve())).rejects.toBeInstanceOf(
          AbandonedLockGuardError,
        );
      } else {
        // The other process finishes using the guard, but our unreleased main lock
        // stays excluded while its PID is alive. Age alone must not steal it.
        rmSync(guard);
        const old = new Date(Date.now() - 60_000);
        utimesSync(path, old, old);
        await expect(withFileLock(path, () => Promise.resolve())).rejects.toBeInstanceOf(StaleLockOwnerError);
        // Once the owner exits, normal stale-lock recovery is safe again.
        vi.spyOn(process, 'kill').mockImplementation(() => {
          throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        });
        await expect(withFileLock(path, () => Promise.resolve('recovered'))).resolves.toBe('recovered');
      }
    },
  );

  it('preserves the original work error when release also fails', async () => {
    const path = lockPath();
    const original = new Error('work failed');
    const warn = vi.fn();
    await expect(
      withFileLock(
        path,
        () => {
          writeFileSync(`${path}.break`, 'abandoned');
          const old = new Date(Date.now() - 60_000);
          utimesSync(`${path}.break`, old, old);
          return Promise.reject(original);
        },
        { logger: { ...silentLogger, warn } },
      ),
    ).rejects.toBe(original);
    expect(warn).toHaveBeenCalledWith(expect.any(String), {
      path,
      error: expect.any(AbandonedLockGuardError) as unknown,
    });
  });

  it('times out on a live lock', async () => {
    const path = lockPath();
    writeFileSync(path, '1\n');
    await expect(
      withFileLock(path, () => Promise.resolve(), { timeoutMs: 50, pollMs: 10 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
  });

  it('keeps a long critical section alive with a heartbeat, so it is never broken as stale', async () => {
    const path = lockPath();
    let broken = false;
    const long = withFileLock(path, () => sleep(250), { staleMs: 90 });
    await sleep(20);
    const competitor = withFileLock(
      path,
      () => {
        broken = true;
        return Promise.resolve();
      },
      { staleMs: 90, timeoutMs: 150, pollMs: 10 },
    );
    await expect(competitor).rejects.toBeInstanceOf(LockTimeoutError);
    expect(broken).toBe(false);
    await long;
  });

  it('writes a random owner token and releases only its own lock', async () => {
    const path = lockPath();
    await withFileLock(path, () => {
      const owner = readFileSync(path, 'utf8').trim();
      expect(owner).toMatch(/^\d+:[A-Za-z0-9_-]{22}$/);
      // Our lock was (wrongly) broken and taken over by someone else meanwhile.
      writeFileSync(path, 'someone-else\n');
      return Promise.resolve();
    });
    // We did not delete the new owner's lock.
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('someone-else\n');
    expect(statSync(path).isFile()).toBe(true);
  });

  it('sweeps files a crash left aside once they are older than staleMs, and nothing else', async () => {
    const path = lockPath();
    const dir = dirname(path);
    for (const name of ['x.lock.stale-123-abcDEF_-9', 'x.lock.break.stale-456-xyz', 'other.stale-1-a']) {
      writeFileSync(join(dir, name), 'left by a crash\n');
    }

    await sweepStaleAside(path, 1_000); // too recent: kept
    expect(readdirSync(dir)).toHaveLength(3);
    await sweepStaleAside(path, 1_000, Date.now() + 60_000); // a minute later
    expect(readdirSync(dir)).toEqual(['other.stale-1-a']);
  });

  it('sweeps them when it takes the lock', async () => {
    const path = lockPath();
    const dir = dirname(path);
    writeFileSync(join(dir, 'x.lock.stale-123-abc'), 'left by a crash\n');
    await sleep(20);

    await withFileLock(path, () => Promise.resolve(), { staleMs: 5 });

    expect(readdirSync(dir)).toEqual([]);
  });

  it('counts a moved-aside file’s age from its last change, so one renamed just now is kept', async () => {
    const path = lockPath();
    const aside = join(dirname(path), 'x.lock.stale-1-renamed');
    writeFileSync(path, 'old lock\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    renameSync(path, aside); // mtime stays a minute old; ctime is now

    await sweepStaleAside(path, 1_000);

    expect(existsSync(aside)).toBe(true);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'throws a permission error breaking a stale lock at once, instead of waiting out the timeout',
    async () => {
      const path = lockPath();
      writeFileSync(path, `${String(FIXTURE_PID)}:crashed\n`);
      const old = new Date(Date.now() - 60_000);
      utimesSync(path, old, old);
      chmodSync(dirname(path), 0o500); // cannot create the breaker lock, nor move the lock
      try {
        const started = Date.now();
        const error = await withFileLock(path, () => Promise.resolve(), {
          staleMs: 1_000,
          timeoutMs: 5_000,
          pollMs: 10,
        }).catch((e: unknown) => e);
        expect(error).not.toBeInstanceOf(LockTimeoutError);
        expect((error as NodeJS.ErrnoException).code).toBe('EACCES');
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        chmodSync(dirname(path), 0o700);
      }
    },
  );
});
