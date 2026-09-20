# @limiter/core

Production-grade distributed rate limiter for Node.js.

**Same code on localhost and production.** Use memory in development, Redis in production — one config change, no API difference.

```bash
npm install @limiter/core
```

---

## Quick Start

```typescript
import { RateLimiter } from '@limiter/core';

const limiter = new RateLimiter({
  strategy: 'token-bucket',
  rate: 100,           // 100 requests
  window: '1 minute',  // per minute
  burst: 150,          // allow spike up to 150
  backend: 'memory',   // swap to 'redis' in production
});

const { allowed, remaining, retryAfter } = await limiter.check('user-123');

if (!allowed) {
  res.status(429).json({ error: 'Too many requests', retryAfter });
}
```

---

## Backends

### Memory (development / single-process)

```typescript
const limiter = new RateLimiter({
  strategy: 'token-bucket',
  rate: 100,
  window: '1 minute',
  backend: 'memory',
});
```

### Redis (production / distributed)

```typescript
import { createClient } from 'redis';

const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

const limiter = new RateLimiter({
  strategy: 'token-bucket',
  rate: 100,
  window: '1 minute',
  backend: 'redis',      // ← only line that changes
  redisClient: redis,
});
```

---

## Express Middleware

```typescript
import express from 'express';
import { RateLimiter, expressMiddleware } from '@limiter/core';

const app = express();
const limiter = new RateLimiter({ rate: 100, window: '1 minute', backend: 'memory', strategy: 'token-bucket' });

// Global: all routes
app.use(expressMiddleware(limiter));

// Route-specific
app.post('/login', expressMiddleware(limiter, {
  keyExtractor: (req) => req.body.email,           // rate limit by email
  onLimitReached: (req, res, result) => {
    res.status(429).json({ error: 'Too many login attempts', retryAfter: result.retryAfter });
  },
}));

// Skip health checks
app.use(expressMiddleware(limiter, {
  skip: (req) => req.path === '/health',
}));
```

Response headers added automatically:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 87
X-RateLimit-Reset: 1718123456
Retry-After: 30     (only on 429)
```

---

## Fastify Plugin

```typescript
import Fastify from 'fastify';
import { RateLimiter, fastifyPlugin } from '@limiter/core';

const app = Fastify();
const limiter = new RateLimiter({ rate: 100, window: '1 minute', backend: 'memory', strategy: 'token-bucket' });

await app.register(fastifyPlugin, {
  limiter,
  keyExtractor: (req) => req.headers['x-api-key'] as string ?? req.ip,
});
```

---

## Strategies

### Token Bucket (default)
Smooth rate limiting with burst support. Tokens refill gradually — a user who hasn't made requests for 30 seconds gets some tokens back.

```typescript
{ strategy: 'token-bucket', rate: 100, window: '1 minute', burst: 150 }
```

### Sliding Window
Exact per-window counting. Every request in the last N milliseconds is counted — no burst allowance.

```typescript
{ strategy: 'sliding-window', rate: 100, window: '1 minute' }
// Note: sliding-window requires Redis backend
```

---

## API Reference

### `new RateLimiter(config)`

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `strategy` | `'token-bucket' \| 'sliding-window'` | ✓ | — | Algorithm |
| `rate` | `number` | ✓ | — | Max requests per window |
| `window` | `string \| number` | ✓ | — | Time window (`'1 minute'` or ms) |
| `backend` | `'memory' \| 'redis'` | ✓ | — | Storage backend |
| `burst` | `number` | | `rate` | Max burst (token-bucket only) |
| `redisClient` | Redis client | required if redis | — | redis v4/v5 client |
| `clockSkewTolerance` | `number` | | `5000` | Clock skew tolerance in ms |

### `limiter.check(key)` → `Promise<CheckResult>`

| Field | Type | Description |
|-------|------|-------------|
| `allowed` | `boolean` | Whether the request is allowed |
| `remaining` | `number` | Requests remaining in window |
| `resetAt` | `Date` | When the window resets |
| `retryAfter` | `number?` | Seconds to wait (only if denied) |

### `limiter.reset(key)` — clear quota for a key
### `limiter.getStatus(key)` — get current bucket status
### `limiter.close()` — clean up resources

---

## Window Formats

```typescript
'1 second'    // 1000ms
'30 seconds'
'1 minute'    // 60000ms
'5 minutes'
'1 hour'
'1 day'
60000         // raw milliseconds
```

---

## Key Strategies

```typescript
// By IP (default)
keyExtractor: (req) => req.ip

// By user ID
keyExtractor: (req) => req.user?.id

// By API key
keyExtractor: (req) => req.headers['x-api-key']

// By org (shared limit across a team)
keyExtractor: (req) => `org:${req.user?.orgId}`

// Composite: per-user per-route
keyExtractor: (req) => `${req.user?.id}:${req.path}`
```

---

## Comparison

| | @limiter/core | express-rate-limit | bottleneck | redis-rate-limiter |
|---|:---:|:---:|:---:|:---:|
| Distributed (Redis) | ✅ | ❌ | ❌ | ✅ |
| Memory + Redis same API | ✅ | ❌ | ❌ | ❌ |
| Token bucket | ✅ | ✅ | ✅ | ❌ |
| Sliding window | ✅ | ✅ | ❌ | ❌ |
| Burst allowance | ✅ | ❌ | ✅ | ❌ |
| Clock skew handling | ✅ | ❌ | ❌ | ❌ |
| TypeScript | ✅ | ✅ | ✅ | ❌ |
| Express adapter | ✅ | ✅ | ❌ | ❌ |
| Fastify adapter | ✅ | ❌ | ❌ | ❌ |

---

## License

MIT © [Anant Duhan](https://github.com/AnantDuhan)
