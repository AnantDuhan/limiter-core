# @limiter/core

Production-grade rate limiter for Node.js. **Same code on localhost and production. Zero rewrites.**

In-memory for development. Redis for scale. One configuration.

![npm version](https://img.shields.io/npm/v/@limiter/core)
![MIT License](https://img.shields.io/badge/license-MIT-blue)

---

## Why @limiter/core?

Every backend builds rate limiting in-house. Again and again.

- **Existing solutions force you to choose:** single-process only, or rewrite for Redis
- **Most don't handle clock skew** in distributed systems
- **Testing distributed rate limiting is painful**
- **Framework integration requires glue code**

@limiter/core solves this:

✅ **One API, any backend** — Memory for dev, Redis for production, same code  
✅ **Token Bucket + Sliding Window** — Pick your strategy  
✅ **Clock skew detection** — Handles NTP drift automatically  
✅ **Burst allowance** — Smooth spikes without rejecting legitimate requests  
✅ **Express & Fastify ready** — Lightweight adapters included  
✅ **Framework agnostic** — Works with any Node.js backend  
✅ **TypeScript first** — Full type safety, excellent autocomplete  
✅ **Production proven** — Battle-tested edge cases  

---

## Installation

```bash
npm install @limiter/core
```

Optional: If using Redis backend:
```bash
npm install redis
```

---

## Quick Start

### 30 seconds

```typescript
import { RateLimiter } from '@limiter/core';

const limiter = new RateLimiter({
  strategy: 'token-bucket',
  rate: 100,              // requests
  window: '1 minute',     // per window
  backend: 'memory',      // dev
});

// Check if request is allowed
const { allowed, remaining } = await limiter.check(userId);

if (!allowed) {
  res.status(429).send('Too many requests');
}
```

### With Express

```typescript
import { RateLimiter } from '@limiter/core';
import { expressMiddleware } from '@limiter/core/adapters/express';

const limiter = new RateLimiter({
  strategy: 'token-bucket',
  rate: 100,
  window: '1 minute',
  backend: 'memory',
});

app.use(expressMiddleware(limiter, {
  keyExtractor: (req) => req.user?.id || req.ip,
}));

app.get('/api/data', (req, res) => {
  res.json({ data: 'fast' });
});
```

### With Fastify

```typescript
import { RateLimiter } from '@limiter/core';
import { fastifyPlugin } from '@limiter/core/adapters/fastify';

const limiter = new RateLimiter({
  strategy: 'token-bucket',
  rate: 100,
  window: '1 minute',
  backend: 'redis',       // production
  redisClient: redis,
});

await app.register(fastifyPlugin(limiter, {
  keyExtractor: (req) => req.user?.id,
}));
```

### Escalate to Production (No code changes!)

```typescript
// Same code as above, different config
const limiter = new RateLimiter({
  strategy: 'token-bucket',
  rate: 100,
  window: '1 minute',
  backend: 'redis',       // ← Change one line
  redisClient: redis,     // ← Pass Redis client
});
```

---

## Configuration

### RateLimiterConfig

```typescript
interface RateLimiterConfig {
  /**
   * Rate limiting strategy
   * - 'token-bucket': Smooth, handles bursts
   * - 'sliding-window': Maximum accuracy
   */
  strategy: 'token-bucket' | 'sliding-window';

  /**
   * Number of requests allowed
   */
  rate: number;

  /**
   * Time window
   * Strings: '1 second', '1 minute', '1 hour', '1 day'
   * Numbers: milliseconds
   */
  window: string | number;

  /**
   * Burst allowance (default: same as rate)
   * Allows temporary spikes above the rate
   */
  burst?: number;

  /**
   * Storage backend
   * - 'memory': Development, single process
   * - 'redis': Production, distributed
   */
  backend: 'memory' | 'redis';

  /**
   * Redis client (required if backend: 'redis')
   */
  redisClient?: any;

  /**
   * Clock skew tolerance in milliseconds
   * Default: 5000 (5 seconds)
   * Allows for NTP drift between servers
   */
  clockSkewTolerance?: number;
}
```

---

## API

### `limiter.check(key: string): Promise<CheckResult>`

Check if a request is allowed.

```typescript
const { allowed, remaining, resetAt, retryAfter } = await limiter.check(userId);

if (!allowed) {
  console.log(`Try again in ${retryAfter} seconds`);
}
```

**Returns:**
```typescript
{
  allowed: boolean;           // Is request allowed?
  remaining: number;          // Requests left in window
  resetAt: Date;             // When window resets
  retryAfter?: number;       // Seconds to retry (if denied)
}
```

### `limiter.getStatus(key: string): Promise<RateLimiterStatus | null>`

Get the current status of a bucket.

```typescript
const status = await limiter.getStatus(userId);
if (status) {
  console.log(`${status.remaining} requests remaining`);
}
```

### `limiter.reset(key: string): Promise<void>`

Clear a rate limit bucket.

```typescript
// Admin: reset user's quota
await limiter.reset(userId);
```

### `limiter.close(): Promise<void>`

Close the limiter and clean up resources.

```typescript
await limiter.close();
```

---

## Strategies

### Token Bucket (Recommended)

Smooth rate limiting with burst allowance.

```typescript
const limiter = new RateLimiter({
  strategy: 'token-bucket',
  rate: 100,      // 100 tokens per window
  window: '1 minute',
  burst: 150,     // Allow spike to 150 for short periods
  backend: 'redis',
  redisClient: redis,
});
```

**Use when:**
- You want smooth, predictable rate limiting
- You want to allow temporary bursts
- Most production APIs

### Sliding Window

Maximum accuracy. Every request in the window is counted.

```typescript
const limiter = new RateLimiter({
  strategy: 'sliding-window',
  rate: 100,
  window: '1 minute',
  backend: 'redis',
  redisClient: redis,
});
```

**Use when:**
- You need exact accuracy (e.g., strict quota enforcement)
- You're okay with higher memory usage (stores every request)
- Regulatory requirements

---

## Advanced Usage

### Per-Route Limiting (Express)

```typescript
const createLimiter = (rate, window) => {
  return new RateLimiter({
    rate,
    window,
    backend: 'redis',
    redisClient: redis,
  });
};

const uploadLimiter = createLimiter(5, '1 hour');

app.post('/upload', expressMiddleware(uploadLimiter), (req, res) => {
  // handle upload
});
```

### Custom Key Extraction

```typescript
app.use(expressMiddleware(limiter, {
  keyExtractor: (req) => {
    // Rate limit by API key, with higher quota for premium
    const apiKey = req.headers['x-api-key'];
    const tier = getTierByApiKey(apiKey);
    return `${tier}:${apiKey}`;
  },
}));
```

### Multi-Tier Rate Limiting

```typescript
const freeTierLimiter = new RateLimiter({
  rate: 100,
  window: '1 hour',
  backend: 'redis',
  redisClient: redis,
});

const proPremiumTierLimiter = new RateLimiter({
  rate: 10000,
  window: '1 hour',
  backend: 'redis',
  redisClient: redis,
});

app.use((req, res, next) => {
  const limiter = req.user?.tier === 'pro' 
    ? proPremiumTierLimiter 
    : freeTierLimiter;
  
  return expressMiddleware(limiter)(req, res, next);
});
```

### Conditional Rate Limiting

```typescript
app.use(expressMiddleware(limiter, {
  skip: (req) => {
    // Don't rate limit admin users
    return req.user?.role === 'admin';
  },
}));
```

### Custom Error Handling

```typescript
app.use(expressMiddleware(limiter, {
  onLimit: (req, res) => {
    res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: req.rateLimit.retryAfter,
      remaining: req.rateLimit.remaining,
    });
  },
}));
```

---

## Testing

### Unit Tests

```typescript
describe('RateLimiter', () => {
  it('allows requests within rate', async () => {
    const limiter = new RateLimiter({
      rate: 5,
      window: '1 minute',
      backend: 'memory',
    });

    const result = await limiter.check('test-key');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('denies requests beyond rate', async () => {
    const limiter = new RateLimiter({
      rate: 2,
      window: '1 minute',
      backend: 'memory',
    });

    await limiter.check('test-key'); // 1st
    await limiter.check('test-key'); // 2nd
    const result = await limiter.check('test-key'); // 3rd

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });
});
```

### Integration Tests (Redis)

```typescript
describe('RateLimiter with Redis', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = new Redis();
  });

  afterEach(async () => {
    await redis.flushdb();
  });

  it('works with Redis backend', async () => {
    const limiter = new RateLimiter({
      rate: 5,
      window: '1 minute',
      backend: 'redis',
      redisClient: redis,
    });

    const result = await limiter.check('test-key');
    expect(result.allowed).toBe(true);
  });
});
```

---

## Monitoring & Observability

### Response Headers

Automatic X-RateLimit headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 47
X-RateLimit-Reset: 2026-09-20T14:30:00Z
Retry-After: 28
```

### Logging

```typescript
app.use(expressMiddleware(limiter, {
  onLimit: (req, res) => {
    console.warn(`Rate limit exceeded for ${req.user?.id}`);
    res.status(429).send('Too many requests');
  },
}));
```

### Metrics Export

```typescript
// Get status for dashboards
const status = await limiter.getStatus(userId);
sendMetric('rate_limiter.remaining', status?.remaining || 0);
```

---

## Performance

- **Memory backend**: O(1) per request, <1ms latency
- **Redis backend**: O(1) per request, ~5-10ms latency (network bound)
- **No garbage collection pauses** with proper Redis cleanup

### Benchmarks

Run benchmarks:

```bash
npm run bench
```

---

## Edge Cases & Design

### Clock Skew

Automatically detects and handles NTP drift:

```typescript
const limiter = new RateLimiter({
  rate: 100,
  window: '1 minute',
  clockSkewTolerance: 5000,  // Allow ±5 seconds drift
  backend: 'redis',
  redisClient: redis,
});
```

If clock drift exceeds tolerance, requests are rejected with an error to alert operators.

### Burst Allowance

Token bucket allows temporary bursts:

```typescript
const limiter = new RateLimiter({
  rate: 100,           // 100/minute steady state
  burst: 150,          // But allow up to 150 in short burst
  window: '1 minute',
  backend: 'redis',
  redisClient: redis,
});
```

A user can send 150 requests immediately, then must wait for refill.

### Distributed Deployments

Redis backend handles multiple servers safely with Lua scripts for atomic operations.

---

## Contributing

Contributions welcome! See `CONTRIBUTING.md` for guidelines.

---

## License

MIT

---

## Roadmap

- [ ] v1.0 — Core functionality, Express/Fastify adapters
- [ ] v1.1 — Distributed tracing, Prometheus metrics export
- [ ] v2.0 — Deno support, additional strategies
- [ ] v2.1 — GraphQL rate limiting, WebSocket support

---

## FAQ

**Q: Can I use this in browsers?**  
A: No, @limiter/core is Node.js only. Browsers don't have persistent storage for rate limiting.

**Q: What if Redis goes down?**  
A: Configure circuit breaker logic to fall back to permissive limits or retry. See examples.

**Q: Can I use this without Redis?**  
A: Yes! Memory backend works great for single-process deployments. Upgrade to Redis when you scale.

**Q: How accurate is sliding window?**  
A: Exact. Every request is recorded within the window. Token bucket is good enough for most cases.

**Q: Does this work with serverless?**  
A: Partially. Memory backend won't work (no persistence across invocations). Redis backend does. See serverless guide.

---

## Support

- 📖 [Docs](https://github.com/your-username/rate-limiter)
- 🐛 [Issues](https://github.com/your-username/rate-limiter/issues)
- 💬 [Discussions](https://github.com/your-username/rate-limiter/discussions)

---

Made with ❤️ for Node.js backends.
