import http from 'node:http';
import { config, getSharedRedisClient } from '@fleet/config';
import { mongoose } from '@fleet/database';
import { Queue } from 'bullmq';
import { type Logger } from '@fleet/logger';

export interface HealthServerInstance {
  server: http.Server;
  close: () => Promise<void>;
}

export function startHealthServer(logger: Logger, port: number = config.worker.healthPort): HealthServerInstance {
  const server = http.createServer(async (req, res) => {
    const url = req.url?.split('?')[0];

    if (url === '/healthz' || url === '/') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'worker',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          environment: config.env,
          concurrency: config.worker.concurrency
        })
      );
      return;
    }

    if (url === '/readyz') {
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

      // 3. Check Queue reachability with 2s timeout
      const queueStart = Date.now();
      let queueTimer: NodeJS.Timeout | null = null;
      let tempQueue: Queue | null = null;
      try {
        const queueTimeout = new Promise<never>((_, reject) => {
          queueTimer = setTimeout(() => reject(new Error(`Queue reachability timed out after ${timeoutMs}ms`)), timeoutMs);
          queueTimer.unref();
        });
        tempQueue = new Queue('telemetry-queue', { connection: getSharedRedisClient() });
        await Promise.race([tempQueue.getJobCounts('waiting', 'active'), queueTimeout]);
        dependencies.queue = { status: 'up', latencyMs: Date.now() - queueStart };
      } catch (err: any) {
        dependencies.queue = { status: 'down', latencyMs: Date.now() - queueStart, error: err.message };
        failing.push('queue');
      } finally {
        if (queueTimer) clearTimeout(queueTimer);
        if (tempQueue) {
          try {
            await tempQueue.close();
          } catch {
            // ignore
          }
        }
      }

      const isReady = failing.length === 0;
      const statusCode = isReady ? 200 : 503;

      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      });
      res.end(
        JSON.stringify({
          status: isReady ? 'ready' : 'not_ready',
          service: 'worker',
          timestamp: new Date().toISOString(),
          ...(failing.length > 0 ? { failing } : {}),
          dependencies
        })
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', path: req.url }));
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info(
      {
        port,
        healthCheck: `http://localhost:${port}/healthz`
      },
      '🩺 Worker health probe server listening'
    );
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  };
}
