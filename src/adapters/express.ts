import { Request, Response, NextFunction, RequestHandler } from 'express';
import { RateLimiter } from '../core/RateLimiter';
import { CheckResult } from '../core/types';

/**
 * Options for Express middleware
 */
export interface ExpressMiddlewareOptions {
  /**
   * Extract the rate limit key from the request
   * @default req.ip
   * @example keyExtractor: (req) => req.headers['x-api-key'] as string
   * @example keyExtractor: (req) => req.user?.id
   */
  keyExtractor?: (req: Request) => string;

  /**
   * Custom handler when rate limit is exceeded
   * @default sends 429 JSON response
   */
  onLimitReached?: (req: Request, res: Response, result: CheckResult) => void;

  /**
   * Skip rate limiting for certain requests
   * @example skip: (req) => req.ip === '127.0.0.1'
   */
  skip?: (req: Request) => boolean;

  /**
   * Add standard rate limit headers to every response
   * X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset
   * @default true
   */
  addHeaders?: boolean;

  /**
   * Header prefix
   * @default 'X-RateLimit'
   */
  headerPrefix?: string;
}

/**
 * Express middleware for @limiter/core
 *
 * @example Basic usage
 * ```typescript
 * import express from 'express';
 * import { RateLimiter } from '@limiter/core';
 * import { expressMiddleware } from '@limiter/core/adapters/express';
 *
 * const app = express();
 * const limiter = new RateLimiter({ rate: 100, window: '1 minute', backend: 'memory', strategy: 'token-bucket' });
 *
 * app.use(expressMiddleware(limiter));
 * ```
 *
 * @example Per-user rate limiting
 * ```typescript
 * app.use(expressMiddleware(limiter, {
 *   keyExtractor: (req) => req.user?.id ?? req.ip,
 *   onLimitReached: (req, res, result) => {
 *     res.status(429).json({ error: 'Slow down!', retryAfter: result.retryAfter });
 *   }
 * }));
 * ```
 */
export function expressMiddleware(
  limiter: RateLimiter,
  options: ExpressMiddlewareOptions = {}
): RequestHandler {
  const {
    keyExtractor = (req: Request) => req.ip ?? '0.0.0.0',
    onLimitReached,
    skip,
    addHeaders = true,
    headerPrefix = 'X-RateLimit',
  } = options;

  const config = limiter.getConfig();

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Skip check if skip function returns true
      if (skip && skip(req)) {
        return next();
      }

      // Extract key
      const key = keyExtractor(req);

      if (!key) {
        // No key means we can't rate limit — fail open
        return next();
      }

      // Check rate limit
      const result = await limiter.check(key);

      // Attach result to request for downstream use
      (req as any).rateLimit = result;

      // Add standard headers
      if (addHeaders) {
        res.setHeader(`${headerPrefix}-Limit`, config.rate);
        res.setHeader(`${headerPrefix}-Remaining`, Math.max(0, result.remaining));
        res.setHeader(`${headerPrefix}-Reset`, Math.floor(result.resetAt.getTime() / 1000));
      }

      if (!result.allowed) {
        // Add Retry-After header
        if (result.retryAfter !== undefined) {
          res.setHeader('Retry-After', result.retryAfter);
        }

        // Use custom handler or default 429
        if (onLimitReached) {
          onLimitReached(req, res, result);
        } else {
          res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded. Please slow down.',
            retryAfter: result.retryAfter,
            resetAt: result.resetAt.toISOString(),
          });
        }
        return;
      }

      next();
    } catch (err) {
      // Fail open: if rate limiter errors, let request through
      console.error('[@limiter/core] Express middleware error:', err);
      next();
    }
  };
}
