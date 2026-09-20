# Changelog

All notable changes to `@limiter/core` will be documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project follows [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-09-20

### Added
- `RateLimiter` class — main entry point with pluggable backends
- `MemoryBackend` — token bucket algorithm for single-process / dev use
- `RedisBackend` — distributed backend using atomic Lua scripts
  - Token bucket strategy with burst allowance
  - Sliding window counter strategy
  - Clock skew handling via Redis `TIME` command
  - `EVALSHA` caching for performance
  - Auto-expiring keys (2× window TTL)
  - Fail-open behaviour when Redis is unavailable
- `expressMiddleware` — Express 4.x middleware adapter
  - Custom `keyExtractor`, `onLimitReached`, `skip`
  - `X-RateLimit-*` and `Retry-After` headers
- `fastifyPlugin` — Fastify 4.x plugin adapter
  - Same options as Express adapter
  - Graceful shutdown via `onClose` hook
- Full TypeScript support — types included, no `@types/` needed
- 44-test suite covering unit + integration

### Strategies
- `token-bucket` — smooth rate limiting with configurable burst
- `sliding-window` — precise per-window counting (Redis only)

### Window formats
- String: `"1 second"`, `"5 minutes"`, `"1 hour"`, `"1 day"`
- Number: milliseconds (`60000`)
