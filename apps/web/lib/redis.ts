/**
 * Redis singleton for Vercel serverless.
 *
 * `globalThis` pattern mirrors lib/db.ts (Prisma singleton). A module-level
 * `new IORedis()` call would open a new TCP connection on every cold start;
 * globalThis reuses the connection across warm invocations of the same
 * instance.
 *
 * Returns `null` when REDIS_URL is not set so callers can degrade gracefully
 * (e.g. the chat rate limiter falls back to allow-all rather than blocking
 * all chat on a missing env var).
 */

import IORedis from 'ioredis';

declare global {
  // eslint-disable-next-line no-var
  var _redis: IORedis | undefined;
}

export function getRedis(): IORedis | null {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  if (!global._redis) {
    global._redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: 1,     // fail fast — never block a request waiting for Redis
      enableReadyCheck: false,
      lazyConnect: false,
      retryStrategy: (times) => {
        // Exponential back-off, capped at 2 s. After 5 attempts give up
        // and return null from getRedis() callers' catch paths.
        if (times > 5) return null;
        return Math.min(times * 50, 2000);
      },
    });

    global._redis.on('error', (err: Error) => {
      // Log but don't crash — callers handle null gracefully.
      console.error('[Redis] Connection error:', err.message);
    });
  }

  return global._redis;
}
