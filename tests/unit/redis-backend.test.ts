import { RedisBackend } from '../../src/backends/RedisBackend';

/** Build a mock Redis client that simulates the real redis v4 API */
function makeMockRedis() {
  const store: Record<string, Record<string, string>> = {};
  const zsets: Record<string, Array<{ score: number; member: string }>> = {};
  const counters: Record<string, number> = {};
  let serverTime = Date.now();

  return {
    _setTime: (ms: number) => { serverTime = ms; },
    _getHash: (key: string) => store[key],

    time: jest.fn(async () => {
      const secs = Math.floor(serverTime / 1000);
      const micros = (serverTime % 1000) * 1000;
      return [String(secs), String(micros)];
    }),

    hGetAll: jest.fn(async (key: string) => store[key] ?? {}),

    del: jest.fn(async (...keys: string[]) => {
      keys.forEach(k => { delete store[k]; delete zsets[k]; delete counters[k]; });
      return keys.length;
    }),

    // Used by Lua scripts via eval
    eval: jest.fn(async (script: string, opts: { keys: string[]; arguments: string[] }) => {
      const key = opts.keys[0];
      const args = opts.arguments;

      if (script.includes('HMGET')) {
        // Token bucket script
        const rate        = parseFloat(args[0]);
        const burst       = parseFloat(args[1]);
        const windowMs    = parseFloat(args[2]);
        const nowMs       = parseFloat(args[3]);
        const toleranceMs = parseFloat(args[4]);

        const existing = store[key];
        let tokens     = existing ? parseFloat(existing.tokens) : burst;
        let lastRefill = existing ? parseFloat(existing.lastRefill) : nowMs;

        if (existing) {
          const drift = nowMs - lastRefill;
          if (drift < -toleranceMs) {
            tokens = burst; lastRefill = nowMs;
          } else if (drift > 0) {
            tokens = Math.min(burst, tokens + (drift / windowMs) * rate);
            lastRefill = nowMs;
          }
        }

        let allowed = 0;
        let retryAfter = 0;
        if (tokens >= 1) { tokens -= 1; allowed = 1; }
        else { retryAfter = Math.ceil(((1 - tokens) * windowMs / rate) / 1000); }

        store[key] = { tokens: String(tokens), lastRefill: String(lastRefill) };
        return [allowed, Math.floor(tokens), lastRefill + windowMs, retryAfter];
      }

      if (script.includes('ZREMRANGEBYSCORE')) {
        // Sliding window script
        const rate     = parseFloat(args[0]);
        const windowMs = parseFloat(args[1]);
        const nowMs    = parseFloat(args[2]);

        if (!zsets[key]) zsets[key] = [];
        zsets[key] = zsets[key].filter(e => e.score > nowMs - windowMs);
        const count = zsets[key].length;

        let allowed = 0; let remaining = 0; let retryAfter = 0;
        if (count < rate) {
          counters[key] = (counters[key] ?? 0) + 1;
          zsets[key].push({ score: nowMs, member: `${nowMs}:${counters[key]}` });
          allowed = 1; remaining = rate - count - 1;
        } else {
          const oldest = zsets[key][0];
          retryAfter = oldest ? Math.ceil((oldest.score + windowMs - nowMs) / 1000) : Math.ceil(windowMs / 1000);
        }
        return [allowed, remaining, nowMs + windowMs, retryAfter];
      }

      return [1, 0, Date.now() + 60000, 0];
    }),

    evalSha: jest.fn().mockRejectedValue(new Error('NOSCRIPT')),
    scriptLoad: jest.fn(async () => 'mock-sha-123'),
  };
}

describe('RedisBackend', () => {
  it('throws when constructed without a redis client', () => {
    expect(() => new RedisBackend(null)).toThrow('Redis client is required');
  });

  describe('Token Bucket', () => {
    it('allows requests within rate limit', async () => {
      const redis = makeMockRedis();
      const backend = new RedisBackend(redis);
      const r = await backend.check('u1', 5, 60000, 5, 'token-bucket');
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(4);
      expect(r.resetAt).toBeInstanceOf(Date);
    });

    it('denies when tokens exhausted', async () => {
      const redis = makeMockRedis();
      const backend = new RedisBackend(redis);
      for (let i = 0; i < 3; i++) await backend.check('u2', 3, 60000, 3, 'token-bucket');
      const denied = await backend.check('u2', 3, 60000, 3, 'token-bucket');
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfter).toBeGreaterThan(0);
    });

    it('refills tokens over time', async () => {
      const redis = makeMockRedis();
      const backend = new RedisBackend(redis);
      const now = Date.now();
      redis._setTime(now);

      // Drain
      for (let i = 0; i < 10; i++) await backend.check('u3', 10, 1000, 10, 'token-bucket');
      const denied = await backend.check('u3', 10, 1000, 10, 'token-bucket');
      expect(denied.allowed).toBe(false);

      // Advance time 500ms → ~5 tokens refilled
      redis._setTime(now + 500);
      const refilled = await backend.check('u3', 10, 1000, 10, 'token-bucket');
      expect(refilled.allowed).toBe(true);
    });

    it('respects burst allowance', async () => {
      const redis = makeMockRedis();
      const backend = new RedisBackend(redis);
      // rate=2, burst=5 — should allow 5 before denying
      let allowed = 0;
      for (let i = 0; i < 7; i++) {
        const r = await backend.check('u4', 2, 60000, 5, 'token-bucket');
        if (r.allowed) allowed++;
      }
      expect(allowed).toBe(5);
    });
  });

  describe('Sliding Window', () => {
    it('allows requests within window', async () => {
      const redis = makeMockRedis();
      const backend = new RedisBackend(redis);
      const r = await backend.check('sw1', 5, 60000, 5, 'sliding-window');
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(4);
    });

    it('denies when window is full', async () => {
      const redis = makeMockRedis();
      const backend = new RedisBackend(redis);
      for (let i = 0; i < 3; i++) await backend.check('sw2', 3, 60000, 3, 'sliding-window');
      const denied = await backend.check('sw2', 3, 60000, 3, 'sliding-window');
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfter).toBeGreaterThan(0);
    });
  });

  describe('Reset', () => {
    it('calls redis.del with correct keys', async () => {
      const redis = makeMockRedis();
      const backend = new RedisBackend(redis);
      await backend.reset('user-abc');
      expect(redis.del).toHaveBeenCalledWith('user-abc', 'user-abc:seq');
    });
  });

  describe('Fail open', () => {
    it('returns allowed=true when Redis errors', async () => {
      const brokenRedis = {
        time: jest.fn().mockRejectedValue(new Error('Connection refused')),
      };
      const backend = new RedisBackend(brokenRedis);
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const r = await backend.check('u5', 10, 60000);
      spy.mockRestore();
      expect(r.allowed).toBe(true);
    });
  });

  describe('getStatus', () => {
    it('returns null for unknown key', async () => {
      const redis = makeMockRedis();
      const backend = new RedisBackend(redis);
      const status = await backend.getStatus('nonexistent');
      expect(status).toBeNull();
    });
  });
});
