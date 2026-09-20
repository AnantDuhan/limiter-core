import { Backend, CheckResult, RateLimiterStatus } from '../core/types';

/**
 * Lua script for atomic token bucket check + refill.
 *
 * Why Lua? Redis executes Lua scripts atomically — no other command
 * runs between lines, eliminating race conditions across many servers.
 *
 * KEYS[1]  = rate limit key  (e.g. "rl:user-123")
 * ARGV[1]  = rate            (max tokens per window)
 * ARGV[2]  = burst           (max bucket capacity)
 * ARGV[3]  = windowMs        (window in milliseconds)
 * ARGV[4]  = nowMs           (Redis server time in ms)
 * ARGV[5]  = toleranceMs     (clock skew tolerance)
 *
 * Returns: [allowed (0|1), remaining, resetAtMs, retryAfterSec]
 */
const TOKEN_BUCKET_LUA = `
local key         = KEYS[1]
local rate        = tonumber(ARGV[1])
local burst       = tonumber(ARGV[2])
local windowMs    = tonumber(ARGV[3])
local nowMs       = tonumber(ARGV[4])
local toleranceMs = tonumber(ARGV[5])

local data       = redis.call('HMGET', key, 'tokens', 'lastRefill')
local tokens     = tonumber(data[1])
local lastRefill = tonumber(data[2])

if tokens == nil or lastRefill == nil then
  tokens     = burst
  lastRefill = nowMs
else
  local drift = nowMs - lastRefill
  if drift < -toleranceMs then
    tokens     = burst
    lastRefill = nowMs
  elseif drift > 0 then
    local added = (drift / windowMs) * rate
    tokens = math.min(burst, tokens + added)
    lastRefill = nowMs
  end
end

local allowed    = 0
local retryAfter = 0

if tokens >= 1 then
  tokens  = tokens - 1
  allowed = 1
else
  local needed = 1 - tokens
  retryAfter   = math.ceil((needed * windowMs / rate) / 1000)
end

local ttlSec = math.ceil(windowMs * 2 / 1000)
redis.call('HSET', key, 'tokens', tokens, 'lastRefill', lastRefill)
redis.call('EXPIRE', key, ttlSec)

local resetAtMs = lastRefill + windowMs
return { allowed, math.floor(tokens), resetAtMs, retryAfter }
`;

/**
 * Lua script for sliding window counter using a Redis sorted set.
 *
 * KEYS[1]  = rate limit key
 * ARGV[1]  = rate       (max requests per window)
 * ARGV[2]  = windowMs   (window size in ms)
 * ARGV[3]  = nowMs      (Redis server time in ms)
 *
 * Returns: [allowed (0|1), remaining, resetAtMs, retryAfterSec]
 */
const SLIDING_WINDOW_LUA = `
local key      = KEYS[1]
local rate     = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local nowMs    = tonumber(ARGV[3])

local windowStart = nowMs - windowMs
redis.call('ZREMRANGEBYSCORE', key, '-inf', windowStart)

local count = tonumber(redis.call('ZCARD', key))

local allowed    = 0
local remaining  = 0
local retryAfter = 0

if count < rate then
  local member = nowMs .. ':' .. redis.call('INCR', key .. ':seq')
  redis.call('ZADD', key, nowMs, member)
  redis.call('EXPIRE', key .. ':seq', math.ceil(windowMs * 2 / 1000))
  allowed   = 1
  remaining = rate - count - 1
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest and oldest[2] then
    retryAfter = math.ceil((tonumber(oldest[2]) + windowMs - nowMs) / 1000)
  else
    retryAfter = math.ceil(windowMs / 1000)
  end
  remaining = 0
end

redis.call('EXPIRE', key, math.ceil(windowMs * 2 / 1000))
return { allowed, remaining, nowMs + windowMs, retryAfter }
`;

/**
 * Redis-backed rate limiter for distributed deployments.
 *
 * - Atomic Lua scripts: no race conditions across multiple servers
 * - Clock skew: uses Redis TIME command, never client Date.now()
 * - Auto-cleanup: keys expire after 2 windows of inactivity
 * - Fail open: if Redis is down, requests are allowed through
 * - Supports token-bucket and sliding-window strategies
 *
 * @example
 * ```typescript
 * import { createClient } from 'redis';
 *
 * const redis = createClient({ url: 'redis://localhost:6379' });
 * await redis.connect();
 *
 * const limiter = new RateLimiter({
 *   strategy: 'token-bucket',
 *   rate: 100,
 *   window: '1 minute',
 *   backend: 'redis',
 *   redisClient: redis,
 * });
 * ```
 */
export class RedisBackend implements Backend {
  private redis: any;
  private readonly clockSkewTolerance: number;
  private tokenBucketSha: string | null = null;
  private slidingWindowSha: string | null = null;

  constructor(redisClient: any, clockSkewTolerance: number = 5000) {
    if (!redisClient) {
      throw new Error('Redis client is required for RedisBackend');
    }
    this.redis = redisClient;
    this.clockSkewTolerance = clockSkewTolerance;
  }

  async check(
    key: string,
    rate: number,
    window: number,
    burst: number = rate,
    strategy: 'token-bucket' | 'sliding-window' = 'token-bucket'
  ): Promise<CheckResult> {
    try {
      const nowMs = await this.getRedisTime();
      const result = strategy === 'sliding-window'
        ? await this.evalSlidingWindow(key, rate, window, nowMs)
        : await this.evalTokenBucket(key, rate, burst, window, nowMs);

      const [allowed, remaining, resetAtMs, retryAfter] = result;
      return {
        allowed: allowed === 1,
        remaining,
        resetAt: new Date(resetAtMs),
        retryAfter: retryAfter > 0 ? retryAfter : undefined,
      };
    } catch (err) {
      console.error('[@limiter/core] Redis check error — failing open:', err);
      return { allowed: true, remaining: rate, resetAt: new Date(Date.now() + window) };
    }
  }

  async getStatus(key: string): Promise<RateLimiterStatus | null> {
    try {
      const data = await this.redis.hGetAll(key);
      if (!data || Object.keys(data).length === 0) return null;
      return {
        remaining: Math.floor(parseFloat(data.tokens ?? '0')),
        resetAt: new Date(parseInt(data.lastRefill ?? '0', 10) + 60000),
        rate: 0,
        window: 0,
        strategy: 'token-bucket',
      };
    } catch (err) {
      console.error('[@limiter/core] Redis getStatus error:', err);
      return null;
    }
  }

  async reset(key: string): Promise<void> {
    try {
      await this.redis.del(key, `${key}:seq`);
    } catch (err) {
      console.error('[@limiter/core] Redis reset error:', err);
      throw err;
    }
  }

  async close(): Promise<void> {
    // Lifecycle managed externally — caller connects and disconnects
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Use Redis TIME so all servers share the same clock */
  private async getRedisTime(): Promise<number> {
    const [seconds, microseconds] = await this.redis.time();
    return parseInt(seconds, 10) * 1000 + Math.floor(parseInt(microseconds, 10) / 1000);
  }

  private async evalTokenBucket(
    key: string, rate: number, burst: number, windowMs: number, nowMs: number
  ): Promise<number[]> {
    const args = [rate, burst, windowMs, nowMs, this.clockSkewTolerance].map(String);
    try {
      if (this.tokenBucketSha) {
        return await this.redis.evalSha(this.tokenBucketSha, { keys: [key], arguments: args });
      }
    } catch (err: any) {
      if (!err.message?.includes('NOSCRIPT')) throw err;
      this.tokenBucketSha = null;
    }
    const result = await this.redis.eval(TOKEN_BUCKET_LUA, { keys: [key], arguments: args });
    this.tokenBucketSha = await this.redis.scriptLoad(TOKEN_BUCKET_LUA);
    return result as number[];
  }

  private async evalSlidingWindow(
    key: string, rate: number, windowMs: number, nowMs: number
  ): Promise<number[]> {
    const args = [rate, windowMs, nowMs].map(String);
    try {
      if (this.slidingWindowSha) {
        return await this.redis.evalSha(this.slidingWindowSha, { keys: [key], arguments: args });
      }
    } catch (err: any) {
      if (!err.message?.includes('NOSCRIPT')) throw err;
      this.slidingWindowSha = null;
    }
    const result = await this.redis.eval(SLIDING_WINDOW_LUA, { keys: [key], arguments: args });
    this.slidingWindowSha = await this.redis.scriptLoad(SLIDING_WINDOW_LUA);
    return result as number[];
  }
}
