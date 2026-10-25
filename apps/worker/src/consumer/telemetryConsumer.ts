import { Worker, type Job } from 'bullmq';
import { createRedisClient, config } from '@fleet/config';
import { Event, Device } from '@fleet/database';
import { createLogger } from '@fleet/logger';
import { processEventRules } from '../engine/rulesEngine.js';
import { autoResolveStaleIncidents } from '../engine/incidentManager.js';

const logger = createLogger({ service: 'telemetry-consumer' });

export function setupTelemetryConsumer() {
  const redis = createRedisClient();

  const worker = new Worker(
    'telemetry-queue',
    async (job: Job) => {
      const data = job.data;
      const eventId = data.eventId;

      logger.info({ eventId, seq: data.seq, deviceId: data.deviceId }, 'Processing telemetry event');

      // 1. Idempotency Check: Fetch current state from MongoDB
      const eventDoc = await Event.findOne({ eventId });
      if (!eventDoc) {
        logger.warn({ eventId }, 'Event document not found in MongoDB');
        return;
      }

      // If already processed, skip to guarantee zero duplicate side effects
      if (eventDoc.processingStatus === 'completed') {
        logger.info({ eventId }, 'Event already completed. Skipping idempotent reprocessing.');
        return;
      }

      // Claim job by updating status to processing
      eventDoc.processingStatus = 'processing';
      eventDoc.updatedAt = new Date();
      await eventDoc.save();

      // 2. Fetch or create device document
      let deviceDoc = await Device.findOne({ deviceId: data.deviceId });
      if (!deviceDoc) {
        deviceDoc = await Device.create({
          deviceId: data.deviceId,
          name: data.deviceId,
          location: 'default',
          apiKeyHash: 'unknown',
          status: 'online',
          lastSeenAt: new Date(data.receivedAt || Date.now()),
          lastSeq: data.seq || 0
        });
      }

      const isReplay =
        Boolean(data.replayed) ||
        (new Date(data.receivedAt).getTime() - new Date(data.timestamp).getTime() > 300000);

      // 3. Sensible order device tracking:
      // Replayed/late events must NOT mark device healthy or resolve stale state.
      // For non-replayed events, use device timestamp/seq for latest reading logic (never arrival order).
      if (!isReplay) {
        const currentLastSeq = deviceDoc.lastSeq || 0;
        const currentLastSeen = deviceDoc.lastSeenAt ? new Date(deviceDoc.lastSeenAt).getTime() : 0;
        const eventTimestamp = new Date(data.timestamp).getTime();

        if (data.seq >= currentLastSeq || eventTimestamp >= currentLastSeen) {
          deviceDoc.lastSeenAt = new Date(data.timestamp);
          deviceDoc.lastSeq = Math.max(currentLastSeq, data.seq);
          deviceDoc.status = 'online';
          await deviceDoc.save();
        }

        // Auto-resolve open stale incidents on fresh non-replayed events
        await autoResolveStaleIncidents(deviceDoc, eventDoc);
      }

      // 4. Rules Evaluation & Incident Generation
      await processEventRules(eventDoc, deviceDoc);

      // 5. Mark event completed
      eventDoc.processingStatus = 'completed';
      eventDoc.processedAt = new Date();
      eventDoc.error = null;
      await eventDoc.save();

      logger.info({ eventId, deviceId: data.deviceId }, '✅ Telemetry event processed successfully');
    },
    {
      connection: redis,
      concurrency: config.worker.concurrency,
      stalledInterval: 30000
    }
  );

  // Failure and retry handling
  worker.on('failed', async (job: Job | undefined, err: Error) => {
    if (!job) return;
    const eventId = job.data?.eventId;
    logger.error({ eventId, err: err.message, attemptsMade: job.attemptsMade }, 'Telemetry job failed');

    try {
      const eventDoc = await Event.findOne({ eventId });
      if (eventDoc) {
        eventDoc.attempts = job.attemptsMade;
        eventDoc.error = err.message;

        // If all attempts exhausted, mark permanently failed
        const maxAttempts = job.opts.attempts || 3;
        if (job.attemptsMade >= maxAttempts) {
          eventDoc.processingStatus = 'failed';
          eventDoc.processedAt = new Date();
          logger.fatal({ eventId, attemptsMade: job.attemptsMade }, 'Event permanently marked as failed');
        }

        await eventDoc.save();
      }
    } catch (saveErr: any) {
      logger.error({ eventId, err: saveErr.message }, 'Failed to record job failure in MongoDB');
    }
  });

  worker.on('error', (err) => {
    logger.warn({ err: err.message }, 'BullMQ worker error');
  });

  return worker;
}
