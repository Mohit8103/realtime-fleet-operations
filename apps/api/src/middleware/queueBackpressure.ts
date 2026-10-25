import type { Request, Response, NextFunction } from 'express';
import { config } from '@fleet/config';
import { getTelemetryQueue } from '../queue/telemetryQueue.js';

export async function checkQueueBackpressure(req: Request, res: Response, next: NextFunction) {
  try {
    const queue = getTelemetryQueue();
    const waiting = await queue.getWaitingCount();
    const delayed = await queue.getDelayedCount();
    const depth = waiting + delayed;

    const maxLimit =
      process.env.NODE_ENV !== 'production' && req.headers['x-max-queue-depth']
        ? Number(req.headers['x-max-queue-depth'])
        : config.maxQueueDepth;

    if (depth >= maxLimit) {
      res.setHeader('Retry-After', '2');
      return res.status(429).json({
        error: 'Too Many Requests: Ingestion queue is full',
        code: 'queue_full',
        status: 'rejected',
        queueDepth: depth,
        limit: maxLimit,
        retryAfter: 2
      });
    }

    next();
  } catch (err: any) {
    req.log?.warn({ err: err.message }, 'Failed to check queue depth backpressure, failing open');
    next();
  }
}
