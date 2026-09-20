export { RateLimiter } from './core/RateLimiter';

export type {
  RateLimiterConfig,
  CheckResult,
  RateLimiterStatus,
  Backend,
  TokenBucketState,
} from './core/types';

export { MemoryBackend } from './backends/MemoryBackend';
export { RedisBackend } from './backends/RedisBackend';

export { expressMiddleware } from './adapters/express';
export type { ExpressMiddlewareOptions } from './adapters/express';

export { fastifyPlugin } from './adapters/fastify';
export type { FastifyPluginOptions } from './adapters/fastify';
