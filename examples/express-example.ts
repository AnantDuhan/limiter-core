/**
 * Express.js example with @limiter/core
 * 
 * Run with: npx ts-node examples/express-example.ts
 * Then visit: http://localhost:3000/api/data
 */

import express, { Request, Response } from 'express';
import { RateLimiter } from '../src/core/RateLimiter';

const app = express();
const port = 3000;

// Create rate limiter: 10 requests per minute per user
const limiter = new RateLimiter({
  strategy: 'token-bucket',
  rate: 10,
  window: '1 minute',
  burst: 15,           // Allow temporary spike to 15
  backend: 'memory',   // Use in-memory for development
});

/**
 * Middleware to apply rate limiting
 * Extracts user ID from query param or uses IP
 */
app.use(async (req: Request, res: Response, next) => {
  try {
    // Extract rate limit key (user ID, IP, API key, etc.)
    const key = req.query.user as string || req.ip || '0.0.0.0';

    // Check rate limit
    const result = await limiter.check(key);

    // Add rate limit info to response headers
    res.set({
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': result.resetAt.toISOString(),
    });

    // If rate limited, return 429
    if (!result.allowed) {
      res.set('Retry-After', (result.retryAfter || 60).toString());
      return res.status(429).json({
        error: 'Too many requests',
        retryAfter: result.retryAfter,
        resetAt: result.resetAt,
      });
    }

    // Store result for logging
    (req as any).rateLimit = result;
    next();
  } catch (err) {
    console.error('Rate limiter error:', err);
    // Fail open: allow request if limiter fails
    next();
  }
});

/**
 * Simple API endpoint
 * Try hitting it more than 10 times in 60 seconds
 */
app.get('/api/data', (req: Request, res: Response) => {
  const rateLimit = (req as any).rateLimit;
  
  res.json({
    data: 'Hello, world!',
    timestamp: new Date().toISOString(),
    rateLimit: {
      remaining: rateLimit?.remaining,
      resetAt: rateLimit?.resetAt,
    },
  });
});

/**
 * Admin endpoint to check status
 */
app.get('/api/status/:userId', async (req: Request, res: Response) => {
  try {
    const status = await limiter.getStatus(req.params.userId);
    
    if (!status) {
      return res.status(404).json({
        error: 'No rate limit data for this user',
      });
    }

    res.json(status);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get status' });
  }
});

/**
 * Admin endpoint to reset rate limit
 */
app.post('/api/reset/:userId', async (req: Request, res: Response) => {
  try {
    await limiter.reset(req.params.userId);
    res.json({ message: `Rate limit reset for ${req.params.userId}` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reset' });
  }
});

/**
 * Start server
 */
app.listen(port, () => {
  console.log(`
✓ Express server running at http://localhost:${port}

Test endpoints:
  GET  http://localhost:${port}/api/data?user=alice
  GET  http://localhost:${port}/api/data?user=bob
  GET  http://localhost:${port}/api/status/alice
  POST http://localhost:${port}/api/reset/alice

Rate limit: 10 requests per minute per user
Burst allowance: 15 requests

Try hammering the endpoint to see 429 responses!
  `);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down...');
  await limiter.close();
  process.exit(0);
});
