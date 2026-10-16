/**
 * Minimal fixed-window in-memory rate limiter.
 * Suitable for a single-process, single-host deployment.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true if the request is allowed, false if rate-limited. */
  check(key: string, now = Date.now()): boolean {
    // Opportunistic cleanup to avoid unbounded growth.
    if (this.buckets.size > 10_000) {
      for (const [k, b] of this.buckets) {
        if (b.resetAt <= now) this.buckets.delete(k);
      }
    }
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  reset(): void {
    this.buckets.clear();
  }
}
