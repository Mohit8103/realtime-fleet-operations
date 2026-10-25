import { Router, type Request, type Response } from 'express';
import { config, getSharedRedisClient } from '@fleet/config';
import { mongoose } from '@fleet/database';

export const healthRouter = Router();

healthRouter.get('/healthz', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'api',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: config.env,
    correlationId: req.correlationId
  });
});

healthRouter.get('/readyz', async (req: Request, res: Response) => {
  const timeoutMs = 2000;
  const dependencies: Record<string, { status: 'up' | 'down'; latencyMs?: number; error?: string }> = {};
  const failing: string[] = [];

  // 1. Check MongoDB with 2s timeout
  const mongoStart = Date.now();
  let mongoTimer: NodeJS.Timeout | null = null;
  try {
    if (mongoose.connection.readyState !== 1) {
      throw new Error(`Mongoose not connected (readyState: ${mongoose.connection.readyState})`);
    }
    const mongoTimeout = new Promise<never>((_, reject) => {
      mongoTimer = setTimeout(() => reject(new Error(`MongoDB ping timed out after ${timeoutMs}ms`)), timeoutMs);
      mongoTimer.unref();
    });
    await Promise.race([mongoose.connection.db?.admin().ping(), mongoTimeout]);
    dependencies.mongo = { status: 'up', latencyMs: Date.now() - mongoStart };
  } catch (err: any) {
    dependencies.mongo = { status: 'down', latencyMs: Date.now() - mongoStart, error: err.message };
    failing.push('mongo');
  } finally {
    if (mongoTimer) clearTimeout(mongoTimer);
  }

  // 2. Check Redis with 2s timeout
  const redisStart = Date.now();
  let redisTimer: NodeJS.Timeout | null = null;
  try {
    const redis = getSharedRedisClient();
    const redisTimeout = new Promise<never>((_, reject) => {
      redisTimer = setTimeout(() => reject(new Error(`Redis ping timed out after ${timeoutMs}ms`)), timeoutMs);
      redisTimer.unref();
    });
    if (redis.status !== 'ready' && redis.status !== 'connecting') {
      await Promise.race([redis.connect(), redisTimeout]);
    }
    await Promise.race([redis.ping(), redisTimeout]);
    dependencies.redis = { status: 'up', latencyMs: Date.now() - redisStart };
  } catch (err: any) {
    dependencies.redis = { status: 'down', latencyMs: Date.now() - redisStart, error: err.message };
    failing.push('redis');
  } finally {
    if (redisTimer) clearTimeout(redisTimer);
  }

  const isReady = failing.length === 0;
  const statusCode = isReady ? 200 : 503;

  return res.status(statusCode).json({
    status: isReady ? 'ready' : 'not_ready',
    service: 'api',
    timestamp: new Date().toISOString(),
    correlationId: req.correlationId,
    ...(failing.length > 0 ? { failing } : {}),
    dependencies
  });
});

