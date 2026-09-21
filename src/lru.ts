/**
 * A minimal bounded LRU map with per-entry expiry. `Map` iterates in insertion
 * order, so re-inserting on access makes the first key the least recently used.
 */
/** How many least-recently-used entries eviction looks at for an expired one. */
const EVICTION_SCAN = 32;

export class ExpiringLru<K, V> {
  readonly #max: number;
  readonly #entries = new Map<K, { value: V; expiresAt: number }>();
  readonly #now: () => number;

  constructor(max: number, now: () => number = Date.now) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
    this.#max = max;
    this.#now = now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    if (entry.expiresAt <= this.#now()) return undefined;
    this.#entries.set(key, entry);
    return entry.value;
  }

  /** Store `value` until `expiresAt` (ms since epoch). Past expiries are not stored. */
  set(key: K, value: V, expiresAt: number): void {
    this.#entries.delete(key);
    if (expiresAt <= this.#now()) return;
    this.#entries.set(key, { value, expiresAt });
    while (this.#entries.size > this.#max) this.#evictOne();
  }

  /**
   * Make room for one entry: an already-expired entry among the least recently
   * used few if there is one (dropping it loses nothing), else the least
   * recently used. So a flood of new keys first displaces what has lapsed —
   * for the rate limiter, buckets that are full again — before anything live.
   */
  #evictOne(): void {
    const now = this.#now();
    let scanned = 0;
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) {
        this.#entries.delete(key);
        return;
      }
      scanned += 1;
      if (scanned >= EVICTION_SCAN) break;
    }
    const oldest = this.#entries.keys().next();
    if (oldest.done !== true) this.#entries.delete(oldest.value);
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }
}
