/**
 * Token-bucket rate limiting of tool invocations (spec 2026-07-28,
 * server/tools § Security Considerations: servers MUST rate limit tool
 * invocations). Hosted mode keys buckets by the authenticated user AND client,
 * so one runaway agent cannot starve the same user's other clients, nor other
 * users.
 *
 * Memory is bounded: buckets live in an LRU of at most `maxKeys` entries. A
 * bucket's entry expires when it would be full again, and eviction drops such
 * lapsed buckets first; only when every tracked key is still refilling does
 * the least recently used one go (and come back full). Displacing a busy
 * bucket that way takes `maxKeys` other active keys, i.e. that many other
 * authenticated users — the hosted app also limits per user, whatever the
 * client, so minting client ids does not help.
 */
import { ExpiringLru } from './lru.js';

export interface RateLimitOptions {
  /** Sustained rate: tokens added per minute. */
  readonly perMinute: number;
  /** Bucket size: how many calls may be made in a burst. */
  readonly burst: number;
  /** Most distinct keys tracked at once. */
  readonly maxKeys: number;
  readonly now?: () => number;
}

export type RateLimitDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** Whole seconds until one token is available. */ readonly retryAfterSeconds: number;
    };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  readonly #buckets: ExpiringLru<string, Bucket>;
  readonly #ratePerMs: number;
  readonly #burst: number;
  readonly #now: () => number;
  /** A bucket untouched this long is full again: no need to keep it. */
  readonly #refillMs: number;

  constructor(options: RateLimitOptions) {
    if (!(options.perMinute > 0) || !(options.burst >= 1)) {
      throw new RangeError('rate limit needs perMinute > 0 and burst >= 1');
    }
    this.#now = options.now ?? Date.now;
    this.#buckets = new ExpiringLru(options.maxKeys, this.#now);
    this.#ratePerMs = options.perMinute / 60_000;
    this.#burst = options.burst;
    this.#refillMs = Math.ceil(options.burst / this.#ratePerMs);
  }

  /** Take one token for `key`. */
  take(key: string): RateLimitDecision {
    const now = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.#burst, updatedAt: now };
    bucket.tokens = Math.min(this.#burst, bucket.tokens + (now - bucket.updatedAt) * this.#ratePerMs);
    bucket.updatedAt = now;
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.#buckets.set(key, bucket, now + this.#refillMs);
    if (allowed) return { allowed: true };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / this.#ratePerMs / 1000)),
    };
  }
}
