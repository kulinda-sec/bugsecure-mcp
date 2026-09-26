import { mkdtemp, open, readdir, rename, utimes, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { breakStaleLock, LockTimeoutError, withFileLock } from './file-lock.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>();
  return { ...fs, rename: vi.fn(fs.rename) };
});

describe('lock recovery and acquisition', () => {
  it('excludes new holders until a moved live lock has been restored', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'bsmcp-flock-race-')), 'x.lock');
    // A legacy owner without a PID: the heartbeat is the only liveness signal.
    await writeFile(path, 'legacy-owner\n');
    const old = new Date(Date.now() - 60_000);
    await utimes(path, old, old);
    // Identity through a descriptor: the stat is of the file that was opened, not of the path later.
    // The descriptor stays open to the end: what it reads then is this very inode, put back.
    const handle = await open(path, 'r');
    const judged = await handle.stat({ bigint: true });
    const moved = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    const fs = await vi.importActual<typeof FsPromises>('node:fs/promises');
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      // Heartbeat after the breaker's final stat, immediately before it moves the file.
      const now = new Date();
      await utimes(path, now, now);
      await fs.rename(from, to);
      moved.resolve(undefined);
      await resume.promise;
    });

    const breaking = breakStaleLock(path, judged, 1_000);
    await moved.promise;
    let entered = false;
    const contender = withFileLock(
      path,
      () => {
        entered = true;
        return Promise.resolve();
      },
      { timeoutMs: 120, staleMs: 1_000, pollMs: 5 },
    );
    const refused = expect(contender).rejects.toBeInstanceOf(LockTimeoutError);
    try {
      try {
        await sleep(30);
        expect(entered).toBe(false);
        expect(await readdir(dirname(path))).not.toContain('x.lock'); // moved aside, not yet restored
      } finally {
        resume.resolve(undefined);
      }
      await expect(breaking).resolves.toBe(false);
      await refused;
      expect(entered).toBe(false);
      // Restored under its name, and it is the same file: the descriptor opened before the
      // move still reads the owner's token.
      expect(await readdir(dirname(path))).toEqual(['x.lock']);
      expect(await handle.readFile('utf8')).toBe('legacy-owner\n');
    } finally {
      await handle.close();
    }
  });
});
