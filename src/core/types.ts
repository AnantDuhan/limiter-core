/**
 * Configuration for RateLimiter
 */
export interface RateLimiterConfig {
  /**
   * Rate limiting strategy
   * - 'token-bucket': Smooth rate limiting with burst allowance
   * - 'sliding-window': Maximum accuracy, every request counted
   */
  strategy: 'token-bucket' | 'sliding-window';

  /**
   * Number of requests allowed in the window
   * @example 100 means 100 requests per window
   */
  rate: number;

  /**
   * Time window for the rate limit
   * @example '1 minute', '1 hour', or 60000 (milliseconds)
   */
  window: string | number;

  /**
   * Burst allowance: temporary spike above rate
   * @default rate (same as rate if not specified)
   * @example burst: 150 allows up to 150 requests in a short period
   */
  burst?: number;

  /**
   * Backend storage
   * - 'memory': Single-process, development
   * - 'redis': Distributed, production
   */
  backend: 'memory' | 'redis';

  /**
   * Redis client instance (required if backend is 'redis')
   * Expects redis v4 or v5 client
   */
  redisClient?: any;

  /**
   * Clock skew tolerance in milliseconds
   * Handles NTP drift between servers
   * @default 5000 (5 seconds)
   */
  clockSkewTolerance?: number;
}

/**
 * Result of a rate limit check
 */
export interface CheckResult {
  /**
   * Whether the request is allowed to proceed
   */
  allowed: boolean;

  /**
   * Number of requests remaining in current window
   */
  remaining: number;

  /**
   * When the rate limit window resets (UTC date)
   */
  resetAt: Date;

  /**
   * Seconds to wait before retrying (only if denied)
   */
  retryAfter?: number;
}

/**
 * Current status of a rate limit bucket
 */
export interface RateLimiterStatus {
  /**
   * Requests remaining in current window
   */
  remaining: number;

  /**
   * When the window resets
   */
  resetAt: Date;

  /**
   * Configured rate (requests per window)
   */
  rate: number;

  /**
   * Window size in milliseconds
   */
  window: number;

  /**
   * Current strategy in use
   */
  strategy: string;
}

/**
 * Abstract backend interface
 * Implementations must handle storage and rate limit logic
 */
export interface Backend {
  /**
   * Check if a request is allowed
   * @param key Unique identifier (user ID, IP, API key, etc.)
   * @param rate Number of requests allowed per window
   * @param window Size of window in milliseconds
   * @param burst Burst allowance (if supported by strategy)
   * @param strategy Which strategy to use
   * @returns CheckResult with allowed status and remaining quota
   */
  check(
    key: string,
    rate: number,
    window: number,
    burst?: number,
    strategy?: 'token-bucket' | 'sliding-window'
  ): Promise<CheckResult>;

  /**
   * Get current status of a rate limit bucket
   * @param key Unique identifier
   * @returns Status or null if key doesn't exist
   */
  getStatus(key: string): Promise<RateLimiterStatus | null>;

  /**
   * Reset a rate limit bucket (clear quota)
   * @param key Unique identifier
   */
  reset(key: string): Promise<void>;

  /**
   * Close backend and clean up resources
   */
  close(): Promise<void>;
}

/**
 * Internal bucket state for token bucket algorithm
 * @internal
 */
export interface TokenBucketState {
  tokens: number;
  lastRefillTime: number;
}
