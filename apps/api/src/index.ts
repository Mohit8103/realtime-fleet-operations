import { createApp, logger } from './app.js';
import { config, verifyRedisConnection } from '@fleet/config';
import { connectMongo, disconnectMongo } from '@fleet/database';

async function bootstrap() {
  // Fail-fast Redis verification
  try {
    logger.info('Checking Redis connectivity...');
    await verifyRedisConnection(undefined, 4000);
    logger.info('✅ Redis connection verified successfully');
  } catch (err: any) {
    logger.fatal({ err: err.message }, '❌ Redis connection failed during API startup');
    process.exit(1);
  }

  // Connect to MongoDB Atlas
  try {
    await connectMongo();
  } catch (err: any) {
    logger.warn({ err: err.message }, '⚠️ MongoDB connection error; continuing with Redis cache fallback');
  }

  const app = createApp();

  const server = app.listen(config.api.port, config.api.host, () => {
    logger.info(
      {
        port: config.api.port,
        host: config.api.host,
        env: config.env,
        healthCheck: `http://${config.api.host}:${config.api.port}/healthz`
      },
      '🚀 API Service started successfully'
    );
  });

  async function gracefulShutdown(signal: string) {
    logger.info({ signal }, 'Received shutdown signal, terminating HTTP server gracefully...');
    server.close(async () => {
      try {
        await disconnectMongo();
      } catch {
        // ignore
      }
      logger.info('HTTP server closed. Exiting process.');
      process.exit(0);
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.fatal({ err: err.message }, 'Fatal error bootstrapping API service');
  process.exit(1);
});
