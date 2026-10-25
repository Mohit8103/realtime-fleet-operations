import { Queue } from 'bullmq';
import { config, createRedisClient } from '@fleet/config';
import { createLogger } from '@fleet/logger';

const logger = createLogger({ service: 'telemetry-queue' });

let queueInstance: Queue | null = null;

export function getTelemetryQueue(): Queue {
  if (queueInstance) return queueInstance;

  const redisConnection = createRedisClient();

  queueInstance = new Queue('telemetry-queue', {
    connection: redisConnection,
    defaultJobOptions: {
      removeOnComplete: config.redisMemory.bullMqJobOptions.removeOnComplete,
      removeOnFail: config.redisMemory.bullMqJobOptions.removeOnFail,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 1000
      }
    }
  });

  queueInstance.on('error', (err) => {
    logger.warn({ err: err.message }, 'BullMQ telemetry queue error');
  });

  return queueInstance;
}
