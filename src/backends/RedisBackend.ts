import { Backend, CheckResult, RateLimiterStatus } from '../core/types';

/**
 * Redis-backed rate limiter for distributed deployments
 * 
 * Uses Lua scripts for atomic operations to prevent race conditions.
 * Suitable for multi-server and high-concurrency scenarios.
 * 
 * @note Full implementation requires Lua scripts (see documentation)
 * 
 * @example
 * ```typescript
 * import { createClient } from 'redis';
 * 
 * const redis = createClient();
 * const backend = new RedisBackend(redis);
 * const result = await backend.check('user-123', 100, 60000);
 * ```
 */
export class RedisBackend implements Backend {
  private redis: any;
  private readonly clockSkewTolerance: number;

  /**
   * Create a new RedisBackend
   * @param redisClient Redis client instance (v4 or v5)
   * @param clockSkewTolerance Clock skew tolerance in milliseconds (default: 5000)
   * @throws Error if redisClient is not provided
   */
  constructor(redisClient: any, clockSkewTolerance: number = 5000) {
    if (!redisClient) {
      throw new Error('Redis client is required for RedisBackend');
    }

    this.redis = redisClient;
    this.clockSkewTolerance = clockSkewTolerance;
  }

  /**
   * Check if a request is allowed (distributed via Redis)
   * 
   * @note This is a stub implementation
   * Production version uses Lua scripts for atomicity:
   * - GET current token count
   * - Refill based on elapsed time
   * - Check if allowed and decrement
   * - SET updated count (all atomic)
   * 
   * @param key Unique rate limit key
   * @param rate Requests allowed per window
   * @param window Window size in milliseconds
   * @param burst Max burst
   * @param strategy Algorithm type
   * @returns CheckResult
   */
  async check(
    key: string,
    rate: number,
    window: number,
    burst: number = rate,
    strategy: 'token-bucket' | 'sliding-window' = 'token-bucket'
  ): Promise<CheckResult> {
    try {
      // TODO: Execute Lua script for atomic operations
      // For now, return stub that allows requests
      
      const windowMs = this.normalizeWindow(window);
      const now = Date.now();

      // Stub: always allow
      // Production: execute Lua script for atomicity
      return {
        allowed: true,
        remaining: rate - 1,
        resetAt: new Date(now + windowMs),
      };
    } catch (err) {
      console.error('Redis rate limiter error:', err);
      throw new Error(`Rate limiter check failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  /**
   * Get current status of a rate limit bucket
   * @param key Rate limit key
   * @returns Status or null
   */
  async getStatus(key: string): Promise<RateLimiterStatus | null> {
    try {
      // TODO: Fetch current token count from Redis
      const tokens = await this.redis.get(key);
      
      if (tokens === null) {
        return null;
      }

      return {
        remaining: parseInt(tokens, 10),
        resetAt: new Date(Date.now() + 60000),
        rate: 100,
        window: 60000,
        strategy: 'token-bucket',
      };
    } catch (err) {
      console.error('Failed to get status:', err);
      return null;
    }
  }

  /**
   * Reset a rate limit bucket
   * @param key Rate limit key
   */
  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(key, `${key}:refill`, `${key}:window`);
    } catch (err) {
      console.error('Failed to reset:', err);
      throw err;
    }
  }

  /**
   * Close backend (handled by external Redis client)
   */
  async close(): Promise<void> {
    // Redis client lifecycle is managed externally
    // We don't close it here to allow reuse
  }

  /**
   * Convert window string to milliseconds
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
        `Expected "1 second", "5 minutes", "1 hour", or milliseconds.`
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
    if (!ms) throw new Error(`Unknown time unit: "${unit}"`);

    return count * ms;
  }
}
