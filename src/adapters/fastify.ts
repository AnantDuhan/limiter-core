import { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import { RateLimiter } from '../core/RateLimiter';
import { CheckResult } from '../core/types';

/**
 * Options for Fastify plugin
 */
export interface FastifyPluginOptions {
  /**
   * The RateLimiter instance to use
   */
  limiter: RateLimiter;

  /**
   * Extract the rate limit key from the request
   * @default req.ip
   */
  keyExtractor?: (req: FastifyRequest) => string;

  /**
   * Custom handler when rate limit is exceeded
   * @default sends 429 JSON response
   */
  onLimitReached?: (req: FastifyRequest, reply: FastifyReply, result: CheckResult) => void;

  /**
   * Skip rate limiting for certain requests
   */
  skip?: (req: FastifyRequest) => boolean;

  /**
   * Add standard rate limit headers
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
 * Fastify plugin for @limiter/core
 *
 * @example Basic usage
 * ```typescript
 * import Fastify from 'fastify';
 * import { RateLimiter } from '@limiter/core';
 * import { fastifyPlugin } from '@limiter/core/adapters/fastify';
 *
 * const app = Fastify();
 * const limiter = new RateLimiter({ rate: 100, window: '1 minute', backend: 'memory', strategy: 'token-bucket' });
 *
 * await app.register(fastifyPlugin, { limiter });
 * ```
 *
 * @example Per-user with custom 429 handler
 * ```typescript
 * await app.register(fastifyPlugin, {
 *   limiter,
 *   keyExtractor: (req) => (req as any).user?.id ?? req.ip,
 *   onLimitReached: (req, reply, result) => {
 *     reply.status(429).send({ error: 'Too fast!', retryAfter: result.retryAfter });
 *   }
 * });
 * ```
 */
const rateLimiterPlugin: FastifyPluginAsync<FastifyPluginOptions> = async (fastify, options) => {
  const {
    limiter,
    keyExtractor = (req: FastifyRequest) => req.ip ?? '0.0.0.0',
    onLimitReached,
    skip,
    addHeaders = true,
    headerPrefix = 'X-RateLimit',
  } = options;

  const config = limiter.getConfig();

  fastify.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      // Skip if skip function returns true
      if (skip && skip(req)) {
        return;
      }

      // Extract key
      const key = keyExtractor(req);

      if (!key) {
        return;
      }

      // Check rate limit
      const result = await limiter.check(key);

      // Attach result to request for downstream use
      (req as any).rateLimit = result;

      // Add standard headers
      if (addHeaders) {
        reply.header(`${headerPrefix}-Limit`, config.rate);
        reply.header(`${headerPrefix}-Remaining`, Math.max(0, result.remaining));
        reply.header(`${headerPrefix}-Reset`, Math.floor(result.resetAt.getTime() / 1000));
      }

      if (!result.allowed) {
        if (result.retryAfter !== undefined) {
          reply.header('Retry-After', result.retryAfter);
        }

        if (onLimitReached) {
          onLimitReached(req, reply, result);
        } else {
          reply.status(429).send({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded. Please slow down.',
            retryAfter: result.retryAfter,
            resetAt: result.resetAt.toISOString(),
          });
        }
      }
    } catch (err) {
      // Fail open
      fastify.log.error({ err }, '[@limiter/core] Fastify plugin error');
    }
  });

  // Graceful shutdown
  fastify.addHook('onClose', async () => {
    await limiter.close();
  });
};

export const fastifyPlugin = fp(rateLimiterPlugin, {
  fastify: '4.x',
  name: '@limiter/core',
});
