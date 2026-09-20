import { Backend, CheckResult, RateLimiterStatus, TokenBucketState } from '../core/types';

/**
 * In-memory rate limiter backend
 * 
 * Perfect for development and single-process deployments.
 * Uses token bucket algorithm for smooth rate limiting with burst support.
 * 
 * @example
 * ```typescript
 * const backend = new MemoryBackend();
 * const result = await backend.check('user-123', 100, 60000); // 100/min
 * console.log(result.allowed); // true/false
 * ```
 */
export class MemoryBackend implements Backend {
  private buckets = new Map<string, TokenBucketState>();
  private readonly clockSkewTolerance: number;

  /**
   * Create a new MemoryBackend
   * @param clockSkewTolerance Clock skew tolerance in milliseconds (default: 5000)
   */
  constructor(clockSkewTolerance: number = 5000) {
    this.clockSkewTolerance = clockSkewTolerance;
  }

  /**
   * Check if a request is allowed (Token Bucket Algorithm)
   * 
   * Algorithm:
   * 1. Calculate how much time passed since last refill
   * 2. Add tokens based on elapsed time (rate per millisecond)
   * 3. Cap at burst level
   * 4. If tokens >= 1, allow and decrement
   * 
   * @param key Unique rate limit key (user ID, IP, etc.)
   * @param rate Requests allowed per window
   * @param window Window size in milliseconds
   * @param burst Max burst (default: same as rate)
   * @param strategy Algorithm (only token-bucket for memory)
   * @returns CheckResult with allowed status
   */
  async check(
    key: string,
    rate: number,
    window: number,
    burst: number = rate,
    strategy: 'token-bucket' | 'sliding-window' = 'token-bucket'
  ): Promise<CheckResult> {
    const now = Date.now();
    const windowMs = this.normalizeWindow(window);

    // Get or create bucket
    let bucket = this.buckets.get(key);

    if (!bucket) {
      // First request: start with full burst
      bucket = {
        tokens: burst,
        lastRefillTime: now,
      };
    } else {
      // Refill based on elapsed time
      const timePassed = now - bucket.lastRefillTime;
      
      // Tokens added per millisecond: rate / windowMs
      // timePassed * (rate / windowMs) = tokens added
      const tokensToAdd = (timePassed / windowMs) * rate;
      
      // Refill (capped at burst)
      bucket.tokens = Math.min(burst, bucket.tokens + tokensToAdd);
      bucket.lastRefillTime = now;
    }

    // Check if request is allowed
    const allowed = bucket.tokens >= 1;

    if (allowed) {
      // Consume one token
      bucket.tokens -= 1;
    }

    // Store updated bucket
    this.buckets.set(key, bucket);

    // Calculate reset time
    const resetAt = new Date(bucket.lastRefillTime + windowMs);

    // Calculate retry-after if denied
    let retryAfter: number | undefined;
    if (!allowed) {
      // How long to wait for 1 token to refill?
      // tokens_needed = 1 - bucket.tokens
      // time = tokens_needed * (windowMs / rate)
      const tokensNeeded = 1 - bucket.tokens;
      retryAfter = Math.ceil((tokensNeeded * windowMs) / rate / 1000);
    }

    return {
      allowed,
      remaining: Math.floor(bucket.tokens),
      resetAt,
      retryAfter,
    };
  }

  /**
   * Get current status of a rate limit bucket
   * @param key Rate limit key
   * @returns Status or null if key hasn't been used
   */
  async getStatus(key: string): Promise<RateLimiterStatus | null> {
    const bucket = this.buckets.get(key);
    
    if (!bucket) {
      return null;
    }

    // Note: We don't store rate/window per key, so return generic values
    // In production, you'd track these per key
    return {
      remaining: Math.floor(bucket.tokens),
      resetAt: new Date(bucket.lastRefillTime + 60000), // Assume 1 minute
      rate: 100, // TODO: track per key in production
      window: 60000,
      strategy: 'token-bucket',
    };
  }

  /**
   * Reset a rate limit bucket (clear quota)
   * Useful for admin operations or testing
   * 
   * @param key Rate limit key
   */
  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  /**
   * Close backend and clean up
   * Clears all buckets from memory
   */
  async close(): Promise<void> {
    this.buckets.clear();
  }

  /**
   * Get memory usage stats (for monitoring)
   * @returns Number of active rate limit buckets
   */
  getStats(): { activeBuckets: number } {
    return {
      activeBuckets: this.buckets.size,
    };
  }

  /**
   * Convert window string to milliseconds
   * @example '1 minute' → 60000
   * @example 60000 → 60000
   * @internal
   */
  private normalizeWindow(window: string | number): number {
    if (typeof window === 'number') {
      return window;
    }

    const match = window.match(/^(\d+)\s+(second|minute|hour|day)s?$/i);
    
    if (!match) {
      throw new Error(
        `Invalid window format: "${window}". ` +
        `Expected "1 second", "5 minutes", "1 hour", or a number in milliseconds.`
      );
    }

    const [, value, unit] = match;
    const count = parseInt(value, 10);

    const unitMs: Record<string, number> = {
      second: 1000,
      minute: 60 * 1000,
      hour: 60 * 60 * 1000,
      day: 24 * 60 * 60 * 1000,
    };

    const ms = unitMs[unit.toLowerCase()];
    
    if (!ms) {
      throw new Error(`Unknown time unit: "${unit}"`);
    }

    return count * ms;
  }
}
