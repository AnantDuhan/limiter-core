import {
  RateLimiterConfig,
  CheckResult,
  RateLimiterStatus,
  Backend,
} from './types';
import { MemoryBackend } from '../backends/MemoryBackend';
import { RedisBackend } from '../backends/RedisBackend';

/**
 * Main RateLimiter class
 * 
 * Provides production-grade rate limiting with pluggable backends.
 * Works seamlessly from development (memory) to production (Redis).
 * 
 * @example Basic usage
 * ```typescript
 * import { RateLimiter } from '@limiter/core';
 * 
 * const limiter = new RateLimiter({
 *   strategy: 'token-bucket',
 *   rate: 100,
 *   window: '1 minute',
 *   backend: 'memory',
 * });
 * 
 * const { allowed } = await limiter.check('user-123');
 * if (!allowed) {
 *   res.status(429).send('Too many requests');
 * }
 * ```
 * 
 * @example Production with Redis
 * ```typescript
 * import { createClient } from 'redis';
 * 
 * const redis = createClient();
 * const limiter = new RateLimiter({
 *   strategy: 'token-bucket',
 *   rate: 100,
 *   window: '1 minute',
 *   backend: 'redis',      // ← Just change one line
 *   redisClient: redis,
 * });
 * ```
 */
export class RateLimiter {
  private backend: Backend;
  private config: RateLimiterConfig;

  /**
   * Create a new RateLimiter
   * @param config Configuration object
   * @throws Error if config is invalid or backend can't be initialized
   */
  constructor(config: RateLimiterConfig) {
    // Validate config
    if (!config.rate || config.rate <= 0) {
      throw new Error('rate must be a positive number');
    }

    if (!config.window) {
      throw new Error('window is required');
    }

    if (!config.strategy || !['token-bucket', 'sliding-window'].includes(config.strategy)) {
      throw new Error('strategy must be "token-bucket" or "sliding-window"');
    }

    // Set defaults and merge config
    this.config = {
      burst: config.burst || config.rate,
      clockSkewTolerance: config.clockSkewTolerance || 5000,
      ...config,
    };

    // Initialize backend
    if (config.backend === 'memory') {
      this.backend = new MemoryBackend(this.config.clockSkewTolerance);
    } else if (config.backend === 'redis') {
      if (!config.redisClient) {
        throw new Error('Redis client required for redis backend');
      }
      this.backend = new RedisBackend(config.redisClient, this.config.clockSkewTolerance);
    } else {
      throw new Error(`Unknown backend: ${config.backend}`);
    }
  }

  /**
   * Check if a request should be allowed
   * 
   * This is the main method you'll call for every request.
   * 
   * @param key Unique identifier (user ID, IP, API key, org ID, etc.)
   * @returns CheckResult with allowed status and remaining quota
   * 
   * @example
   * ```typescript
   * const { allowed, remaining, retryAfter } = await limiter.check(userId);
   * 
   * if (!allowed) {
   *   res.set('Retry-After', retryAfter);
   *   res.status(429).send({ error: 'Rate limit exceeded' });
   *   return;
   * }
   * 
   * // Process request
   * // remaining is useful for headers: X-RateLimit-Remaining
   * ```
   */
  async check(key: string): Promise<CheckResult> {
    if (!key) {
      throw new Error('key is required for rate limit check');
    }

    const windowMs = this.normalizeWindow(this.config.window);

    return this.backend.check(
      key,
      this.config.rate,
      windowMs,
      this.config.burst,
      this.config.strategy
    );
  }

  /**
   * Get the current status of a rate limit bucket
   * 
   * Useful for displaying quota info to users or debugging.
   * 
   * @param key Unique identifier
   * @returns Status with remaining requests and reset time, or null if key hasn't been used
   * 
   * @example
   * ```typescript
   * const status = await limiter.getStatus(userId);
   * if (status) {
   *   console.log(`${status.remaining} requests remaining`);
   *   console.log(`Resets at: ${status.resetAt}`);
   * }
   * ```
   */
  async getStatus(key: string): Promise<RateLimiterStatus | null> {
    if (!key) {
      throw new Error('key is required for status check');
    }

    return this.backend.getStatus(key);
  }

  /**
   * Reset a rate limit bucket
   * 
   * Clears quota for a user. Useful for admin operations or testing.
   * 
   * @param key Unique identifier
   * 
   * @example
   * ```typescript
   * // Admin resets user's quota after investigation
   * await limiter.reset('user-123');
   * ```
   */
  async reset(key: string): Promise<void> {
    if (!key) {
      throw new Error('key is required for reset');
    }

    return this.backend.reset(key);
  }

  /**
   * Close the rate limiter and clean up resources
   * 
   * Call this when shutting down your server.
   * 
   * @example
   * ```typescript
   * process.on('SIGTERM', async () => {
   *   await limiter.close();
   *   process.exit(0);
   * });
   * ```
   */
  async close(): Promise<void> {
    return this.backend.close();
  }

  /**
   * Get current configuration
   * Useful for debugging or logging
   * 
   * @returns A copy of the current configuration
   */
  getConfig(): RateLimiterConfig {
    return {
      strategy: this.config.strategy,
      rate: this.config.rate,
      window: this.config.window,
      burst: this.config.burst,
      backend: this.config.backend,
      clockSkewTolerance: this.config.clockSkewTolerance,
    };
  }

  /**
   * Get the backend instance (advanced usage)
   * 
   * @internal
   */
  getBackend(): Backend {
    return this.backend;
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
