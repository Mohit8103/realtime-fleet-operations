import { config, verifyRedisConnection } from '@fleet/config';
import { createLogger, runWithCorrelationId } from '@fleet/logger';
import { connectMongo, disconnectMongo } from '@fleet/database';
import crypto from 'node:crypto';
import { startHealthServer } from './healthServer.js';
import { setupTelemetryConsumer } from './consumer/telemetryConsumer.js';
import { setupStaleDeviceDetector } from './engine/staleDetector.js';
import { setupEventSweeper } from './engine/sweeper.js';
import { setupNotificationDispatcher } from './notifications/notificationDispatcher.js';
import { setupOutboxRepairSweeper } from './engine/incidentManager.js';

export const logger = createLogger({ service: 'worker' });

async function bootstrap() {
  const initTraceId = crypto.randomUUID();

  await runWithCorrelationId(initTraceId, async () => {
    logger.info(
      {
        env: config.env,
        concurrency: config.worker.concurrency,
        redis: config.redis.url
          ? { url: config.redis.url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@') }
          : { host: config.redis.host, port: config.redis.port },
        mongo: {
          url: config.mongo.url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@'),
          database: config.mongo.database
        }
      },
      '⚙️ Initializing Fleet Operations Background Worker...'
    );

    // 1. Fail-fast Redis verification
    try {
      logger.info('Checking Redis connectivity...');
      await verifyRedisConnection(undefined, 4000);
      logger.info('✅ Redis connection verified successfully');
    } catch (err: any) {
      logger.fatal({ err: err.message }, '❌ Redis connection failed during Worker startup');
      process.exit(1);
    }

    // 2. Connect to MongoDB Atlas
    try {
      await connectMongo();
      logger.info('✅ MongoDB connection verified successfully');
    } catch (err: any) {
      logger.fatal({ err: err.message }, '❌ MongoDB connection failed during Worker startup');
      process.exit(1);
    }

    // 3. Start health probe HTTP server
    const healthInstance = startHealthServer(logger, config.worker.healthPort);

    // 4. Initialize BullMQ Telemetry Queue Consumer
    const consumerWorker = setupTelemetryConsumer();
    logger.info('⚙️ BullMQ telemetry consumer initialized and listening');

    // 5. Initialize Stale Device Repeatable Job (runs every 5s)
    const staleDetector = setupStaleDeviceDetector();
    logger.info('⏰ Stale device scanner repeatable job active (interval: 5s)');

    // 6. Initialize Event Sweeper (startup + periodic 60s)
    const sweeper = setupEventSweeper();
    logger.info('🧹 Event recovery sweeper initialized (startup + 60s periodic)');

    // 7. Initialize Notification Outbox Dispatcher (polling every 2s)
    const dispatcher = setupNotificationDispatcher(2000);
    logger.info('📢 Notification outbox dispatcher initialized (poll interval: 2s)');

    // 8. Initialize Outbox Repair Sweeper (startup + 60s periodic)
    const outboxSweeper = setupOutboxRepairSweeper(60000);
    logger.info('🔧 Outbox repair sweeper initialized (startup + 60s periodic)');

    let isShuttingDown = false;

    async function gracefulShutdown(signal: string) {
      if (isShuttingDown) return;
      isShuttingDown = true;

      logger.info({ signal }, 'Worker received shutdown signal. Terminating gracefully...');

      try {
        outboxSweeper.stop();
        logger.info('Outbox repair sweeper stopped.');

        dispatcher.stop();
        logger.info('Notification dispatcher stopped.');

        await healthInstance.close();
        logger.info('Health server stopped.');

        await consumerWorker.close();
        logger.info('Telemetry consumer closed.');

        await staleDetector.worker.close();
        await staleDetector.queue.close();
        logger.info('Stale detector stopped.');

        await sweeper.close();
        logger.info('Sweeper closed.');

        await disconnectMongo();
        logger.info('MongoDB disconnected.');

        logger.info('Worker shutdown completed cleanly.');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during worker graceful shutdown');
        process.exit(1);
      }
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  });
}

bootstrap().catch((err) => {
  logger.fatal({ err: err.message }, 'Worker fatal bootstrap error');
  process.exit(1);
});
