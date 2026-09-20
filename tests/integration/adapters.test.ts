import express from 'express';
import request from 'supertest';
import { RateLimiter } from '../../src/core/RateLimiter';
import { expressMiddleware } from '../../src/adapters/express';

function makeLimiter(rate: number, burst = rate) {
  return new RateLimiter({ strategy: 'token-bucket', rate, window: '1 minute', burst, backend: 'memory' });
}

describe('Express Middleware', () => {
  it('allows requests within rate limit', async () => {
    const app = express();
    app.use(expressMiddleware(makeLimiter(5)));
    app.get('/', (_, res) => res.json({ ok: true }));

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 429 when rate limit exceeded', async () => {
    const app = express();
    app.use(expressMiddleware(makeLimiter(2, 2)));
    app.get('/', (_, res) => res.json({ ok: true }));

    await request(app).get('/');
    await request(app).get('/');
    const denied = await request(app).get('/');
    expect(denied.status).toBe(429);
    expect(denied.body.error).toBe('Too Many Requests');
    expect(denied.body.retryAfter).toBeGreaterThan(0);
  });

  it('adds X-RateLimit-* headers', async () => {
    const app = express();
    app.use(expressMiddleware(makeLimiter(10)));
    app.get('/', (_, res) => res.json({ ok: true }));

    const res = await request(app).get('/');
    expect(res.headers['x-ratelimit-limit']).toBe('10');
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('adds Retry-After header on 429', async () => {
    const app = express();
    app.use(expressMiddleware(makeLimiter(1, 1)));
    app.get('/', (_, res) => res.json({ ok: true }));

    await request(app).get('/');
    const denied = await request(app).get('/');
    expect(denied.status).toBe(429);
    expect(denied.headers['retry-after']).toBeDefined();
  });

  it('uses custom keyExtractor', async () => {
    const app = express();
    app.use(expressMiddleware(makeLimiter(1, 1), {
      keyExtractor: (req) => req.headers['x-user-id'] as string ?? 'anon',
    }));
    app.get('/', (_, res) => res.json({ ok: true }));

    // User A hits limit
    await request(app).get('/').set('x-user-id', 'alice');
    const aliceDenied = await request(app).get('/').set('x-user-id', 'alice');
    expect(aliceDenied.status).toBe(429);

    // User B still has quota (separate key)
    const bobAllowed = await request(app).get('/').set('x-user-id', 'bob');
    expect(bobAllowed.status).toBe(200);
  });

  it('calls onLimitReached when provided', async () => {
    const app = express();
    app.use(expressMiddleware(makeLimiter(1, 1), {
      onLimitReached: (_, res) => res.status(429).json({ custom: 'slow down!' }),
    }));
    app.get('/', (_, res) => res.json({ ok: true }));

    await request(app).get('/');
    const denied = await request(app).get('/');
    expect(denied.status).toBe(429);
    expect(denied.body.custom).toBe('slow down!');
  });

  it('skips rate limiting when skip() returns true', async () => {
    const app = express();
    app.use(expressMiddleware(makeLimiter(1, 1), {
      skip: () => true,
    }));
    app.get('/', (_, res) => res.json({ ok: true }));

    // Should never be limited
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
    }
  });

  it('omits headers when addHeaders=false', async () => {
    const app = express();
    app.use(expressMiddleware(makeLimiter(10), { addHeaders: false }));
    app.get('/', (_, res) => res.json({ ok: true }));

    const res = await request(app).get('/');
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('attaches result to req.rateLimit', async () => {
    const app = express();
    app.use(expressMiddleware(makeLimiter(10)));
    app.get('/', (req: any, res) => res.json(req.rateLimit));

    const res = await request(app).get('/');
    expect(res.body.allowed).toBe(true);
    expect(res.body.remaining).toBeDefined();
  });
});
