import { Queue } from 'bullmq';
import { createRedisClient, config } from '@fleet/config';
import { Event } from '@fleet/database';
import { createLogger } from '@fleet/logger';

const logger = createLogger({ service: 'sweeper' });

export function setupEventSweeper() {
  const redis = createRedisClient();
  const queue = new Queue('telemetry-queue', {
    connection: redis,
    defaultJobOptions: {
      removeOnComplete: config.redisMemory.bullMqJobOptions.removeOnComplete,
      removeOnFail: config.redisMemory.bullMqJobOptions.removeOnFail
    }
  });

  // 1. Startup sweep
  executeSweep(queue).catch((err) => {
    logger.warn({ err: err.message }, 'Initial startup sweep failed');
  });

  // 2. Periodic sweep every 60 seconds
  const interval = setInterval(() => {
    executeSweep(queue).catch((err) => {
      logger.warn({ err: err.message }, 'Periodic sweep failed');
    });
  }, 60000);

  return {
    queue,
    close: async () => {
      clearInterval(interval);
      await queue.close();
    }
  };
}

export async function executeSweep(queue: Queue): Promise<number> {
  const timeoutThreshold = new Date(Date.now() - 60000); // 60s stuck in processing

  const pendingOrStuck = await Event.find({
    $or: [
      { processingStatus: 'pending' },
      { processingStatus: 'processing', updatedAt: { $lt: timeoutThreshold } }
    ]
  }).limit(100);

  if (!pendingOrStuck.length) return 0;

  logger.info({ count: pendingOrStuck.length }, '🧹 Sweeper running for pending / stuck events');

  let reEnqueued = 0;

  for (const event of pendingOrStuck) {
    try {
      // jobId = eventId ensures BullMQ can NEVER double-enqueue an event
      await queue.add('telemetry-event', event.toObject(), {
        jobId: event.eventId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 }
      });
      reEnqueued++;
    } catch (err: any) {
      // If job already exists with same jobId, BullMQ safely rejects
      logger.debug({ eventId: event.eventId, err: err.message }, 'Sweeper job already enqueued');
    }
  }

  logger.info({ reEnqueued, total: pendingOrStuck.length }, '🧹 Sweeper completed cycle');
  return reEnqueued;
}
