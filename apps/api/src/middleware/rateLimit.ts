import type { Request, Response, NextFunction } from 'express';
import { createRedisClient, type Redis } from '@fleet/config';

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

export function createRateLimiter(options: {
  max: number;
  windowSeconds: number;
  keyPrefix?: string;
}) {
  const { max, windowSeconds, keyPrefix = 'ratelimit' } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    const redis = getRedis();
    const identifier = req.device?.deviceId || req.ip || 'anonymous';
    const currentWindow = Math.floor(Date.now() / (windowSeconds * 1000));
    const rateKey = `${keyPrefix}:${identifier}:${currentWindow}`;

    try {
      const count = await redis.incr(rateKey);
      if (count === 1) {
        await redis.expire(rateKey, windowSeconds + 1);
      }

      if (count > max) {
        res.setHeader('Retry-After', '1');
        return res.status(429).json({
          error: 'Too Many Requests: Rate limit exceeded',
          code: 'rate_limited',
          status: 'rejected',
          limit: max,
          retryAfter: 1
        });
      }

      next();
    } catch (err: any) {
      req.log?.warn({ err: err.message }, 'Rate limiter redis error, failing open');
      next();
    }
  };
}
