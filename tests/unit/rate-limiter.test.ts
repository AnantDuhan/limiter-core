import { RateLimiter } from '../../src/core/RateLimiter';

describe('RateLimiter', () => {
  it('initializes with memory backend', () => {
    const limiter = new RateLimiter({
      strategy: 'token-bucket',
      rate: 100,
      window: '1 minute',
      backend: 'memory',
    });
    const config = limiter.getConfig();
    expect(config.rate).toBe(100);
    expect(config.strategy).toBe('token-bucket');
    expect(config.backend).toBe('memory');
    expect(config.burst).toBe(100); // defaults to rate
    expect(config.clockSkewTolerance).toBe(5000);
  });

  it('throws on invalid rate', () => {
    expect(() => new RateLimiter({
      strategy: 'token-bucket', rate: -1, window: '1 minute', backend: 'memory',
    })).toThrow('rate must be a positive number');
  });

  it('throws on missing window', () => {
    expect(() => new RateLimiter({
      strategy: 'token-bucket', rate: 10, window: '', backend: 'memory',
    })).toThrow('window is required');
  });

  it('throws on invalid strategy', () => {
    expect(() => new RateLimiter({
      strategy: 'invalid' as any, rate: 10, window: '1 minute', backend: 'memory',
    })).toThrow('strategy must be');
  });

  it('throws on empty key', async () => {
    const limiter = new RateLimiter({
      strategy: 'token-bucket', rate: 10, window: '1 minute', backend: 'memory',
    });
    await expect(limiter.check('')).rejects.toThrow('key is required');
  });

  it('allows requests within limit', async () => {
    const limiter = new RateLimiter({
      strategy: 'token-bucket', rate: 5, window: '1 minute', burst: 5, backend: 'memory',
    });
    const result = await limiter.check('user-1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    await limiter.close();
  });

  it('denies requests beyond limit', async () => {
    const limiter = new RateLimiter({
      strategy: 'token-bucket', rate: 2, window: '1 minute', burst: 2, backend: 'memory',
    });
    await limiter.check('user-2');
    await limiter.check('user-2');
    const denied = await limiter.check('user-2');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfter).toBeGreaterThan(0);
    await limiter.close();
  });

  it('parses string windows correctly', async () => {
    const windows = [
      { window: '1 second',  ms: 1000 },
      { window: '1 minute',  ms: 60000 },
      { window: '1 hour',    ms: 3600000 },
      { window: '1 day',     ms: 86400000 },
    ];
    for (const { window, ms } of windows) {
      const limiter = new RateLimiter({
        strategy: 'token-bucket', rate: 10, window, backend: 'memory',
      });
      const result = await limiter.check('w-test');
      const diff = Math.abs(result.resetAt.getTime() - (Date.now() + ms));
      expect(diff).toBeLessThan(200);
      await limiter.close();
    }
  });

  it('resets a key', async () => {
    const limiter = new RateLimiter({
      strategy: 'token-bucket', rate: 1, window: '1 minute', burst: 1, backend: 'memory',
    });
    await limiter.check('user-3');
    const denied = await limiter.check('user-3');
    expect(denied.allowed).toBe(false);
    await limiter.reset('user-3');
    const allowed = await limiter.check('user-3');
    expect(allowed.allowed).toBe(true);
    await limiter.close();
  });

  it('throws when redis backend used without client', () => {
    expect(() => new RateLimiter({
      strategy: 'token-bucket', rate: 10, window: '1 minute', backend: 'redis',
    })).toThrow('Redis client required');
  });
});
