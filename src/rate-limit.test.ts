import { describe, expect, it } from 'vitest';

import { RateLimiter } from './rate-limit.js';

describe('RateLimiter (token bucket)', () => {
  it('allows a burst, then refills at the sustained rate', () => {
    let now = 0;
    const limiter = new RateLimiter({ perMinute: 60, burst: 3, maxKeys: 10, now: () => now });
    expect([1, 2, 3].map(() => limiter.take('a').allowed)).toEqual([true, true, true]);
    expect(limiter.take('a')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    now += 1_000; // one token per second
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('keeps separate budgets per key', () => {
    const limiter = new RateLimiter({ perMinute: 1, burst: 1, maxKeys: 10, now: () => 0 });
    expect(limiter.take('alice').allowed).toBe(true);
    expect(limiter.take('alice')).toEqual({ allowed: false, retryAfterSeconds: 60 });
    expect(limiter.take('bob').allowed).toBe(true);
  });

  it('bounds memory: at most maxKeys buckets are tracked', () => {
    const limiter = new RateLimiter({ perMinute: 1, burst: 1, maxKeys: 2, now: () => 0 });
    limiter.take('a');
    limiter.take('b');
    limiter.take('c'); // evicts 'a', the least recently used
    expect(limiter.take('a').allowed).toBe(true);
  });

  it('rejects a configuration that would never allow a call', () => {
    expect(() => new RateLimiter({ perMinute: 0, burst: 1, maxKeys: 1 })).toThrow(RangeError);
    expect(() => new RateLimiter({ perMinute: 1, burst: 0, maxKeys: 1 })).toThrow(RangeError);
  });
  it('evicts a bucket that is full again before a busy one', () => {
    let now = 0;
    const limiter = new RateLimiter({ perMinute: 60, burst: 2, maxKeys: 2, now: () => now });
    limiter.take('busy');
    limiter.take('busy'); // drained: refilling for 2 s
    now = 1_500;
    limiter.take('idle'); // full again after 2 s
    now = 3_600; // 'idle' has refilled (lapsed); 'busy' was drained longer ago but is also full now
    limiter.take('busy');
    limiter.take('busy'); // drained again, most recently used
    now = 3_700;
    limiter.take('newcomer'); // must evict: 'idle' has lapsed, so it goes, not 'busy'
    expect(limiter.take('busy')).toMatchObject({ allowed: false });
  });
});
