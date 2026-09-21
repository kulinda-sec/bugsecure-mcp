import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import { LockTimeoutError, withFileLock } from './file-lock.js';

const lockPath = (): string => join(mkdtempSync(join(tmpdir(), 'bsmcp-flock-')), 'x.lock');

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
    writeFileSync(path, '99999\n');
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    await expect(withFileLock(path, () => Promise.resolve('ok'), { staleMs: 1_000 })).resolves.toBe('ok');
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
});
