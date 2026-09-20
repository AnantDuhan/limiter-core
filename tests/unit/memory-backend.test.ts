import { MemoryBackend } from '../../src/backends/MemoryBackend';

describe('MemoryBackend', () => {
  let backend: MemoryBackend;

  beforeEach(() => {
    backend = new MemoryBackend();
  });

  afterEach(async () => {
    await backend.close();
  });

  describe('Token Bucket Algorithm', () => {
    it('allows requests within rate limit', async () => {
      const result = await backend.check('user-1', 5, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
      expect(result.retryAfter).toBeUndefined();
    });

    it('denies requests beyond rate limit', async () => {
      await backend.check('user-2', 2, 60000, 2);
      await backend.check('user-2', 2, 60000, 2);
      const denied = await backend.check('user-2', 2, 60000, 2);
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
      expect(denied.retryAfter).toBeGreaterThan(0);
    });

    it('supports burst allowance', async () => {
      for (let i = 0; i < 10; i++) {
        const result = await backend.check('user-3', 5, 60000, 10);
        expect(result.allowed).toBe(true);
      }
      const denied = await backend.check('user-3', 5, 60000, 10);
      expect(denied.allowed).toBe(false);
    });

    it('refills tokens over time', async () => {
      // 10 req/second — drain all
      for (let i = 0; i < 10; i++) {
        await backend.check('user-4', 10, 1000, 10);
      }
      const denied = await backend.check('user-4', 10, 1000, 10);
      expect(denied.allowed).toBe(false);

      // Wait 300ms → ~3 tokens refilled
      await new Promise(r => setTimeout(r, 300));
      const refilled = await backend.check('user-4', 10, 1000, 10);
      expect(refilled.allowed).toBe(true);
    });
  });

  describe('Window (numeric ms)', () => {
    it('handles 1 second window', async () => {
      const result = await backend.check('w1', 1, 1000);
      const diff = Math.abs(result.resetAt.getTime() - (Date.now() + 1000));
      expect(diff).toBeLessThan(100);
    });

    it('handles 1 minute window', async () => {
      const result = await backend.check('w2', 1, 60000);
      const diff = Math.abs(result.resetAt.getTime() - (Date.now() + 60000));
      expect(diff).toBeLessThan(100);
    });

    it('handles 1 hour window', async () => {
      const result = await backend.check('w3', 1, 3600000);
      const diff = Math.abs(result.resetAt.getTime() - (Date.now() + 3600000));
      expect(diff).toBeLessThan(100);
    });
  });

  describe('Status and Reset', () => {
    it('returns status of existing bucket', async () => {
      await backend.check('user-5', 100, 60000);
      const status = await backend.getStatus('user-5');
      expect(status).not.toBeNull();
      expect(status?.remaining).toBe(99);
    });

    it('returns null for non-existent bucket', async () => {
      const status = await backend.getStatus('never-used');
      expect(status).toBeNull();
    });

    it('resets bucket', async () => {
      await backend.check('user-6', 5, 60000);
      await backend.reset('user-6');
      const status = await backend.getStatus('user-6');
      expect(status).toBeNull();
    });
  });

  describe('Multiple Keys', () => {
    it('isolates rate limits between keys', async () => {
      await backend.check('alice', 2, 60000, 2);
      await backend.check('alice', 2, 60000, 2);
      const aliceDenied = await backend.check('alice', 2, 60000, 2);
      expect(aliceDenied.allowed).toBe(false);

      const bobAllowed = await backend.check('bob', 2, 60000, 2);
      expect(bobAllowed.allowed).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('handles rate of 1', async () => {
      const first = await backend.check('edge-1', 1, 60000, 1);
      expect(first.allowed).toBe(true);
      const second = await backend.check('edge-1', 1, 60000, 1);
      expect(second.allowed).toBe(false);
    });

    it('handles very large rates', async () => {
      const result = await backend.check('edge-2', 1000000, 60000);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(999999);
    });

    it('calculates correct retryAfter', async () => {
      for (let i = 0; i < 10; i++) {
        await backend.check('retry-test', 10, 60000, 10);
      }
      const result = await backend.check('retry-test', 10, 60000, 10);
      expect(result.allowed).toBe(false);
      expect(result.retryAfter).toBeGreaterThan(0);
      expect(result.retryAfter).toBeLessThanOrEqual(60);
    });
  });

  describe('Memory Stats', () => {
    it('tracks active buckets', async () => {
      expect(backend.getStats().activeBuckets).toBe(0);
      await backend.check('user-a', 10, 60000);
      expect(backend.getStats().activeBuckets).toBe(1);
      await backend.check('user-b', 10, 60000);
      expect(backend.getStats().activeBuckets).toBe(2);
      await backend.reset('user-a');
      expect(backend.getStats().activeBuckets).toBe(1);
      await backend.close();
      expect(backend.getStats().activeBuckets).toBe(0);
    });
  });
});
