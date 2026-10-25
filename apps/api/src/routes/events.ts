import { Router, type Request, type Response } from 'express';
import { createRedisClient } from '@fleet/config';
import { requireApiKey } from '../middleware/auth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { checkQueueBackpressure } from '../middleware/queueBackpressure.js';
import { telemetryEventSchema, batchEventsSchema } from '../schemas/eventSchema.js';
import { getTelemetryQueue } from '../queue/telemetryQueue.js';
import { Event, Device, RejectedEvent, RuleEvaluation } from '@fleet/database';

export const eventsRouter = Router();
const redis = createRedisClient();

// Authenticate all event routes
eventsRouter.use(requireApiKey);

// Single event ingestion: POST /v1/events
// Uses per-device rate limiting and queue backpressure
eventsRouter.post(
  '/',
  createRateLimiter({ max: 100, windowSeconds: 5, keyPrefix: 'ratelimit:single' }),
  checkQueueBackpressure,
  async (req: Request, res: Response) => {
    const parseResult = telemetryEventSchema.safeParse(req.body);

    if (!parseResult.success) {
      // Store rejected event in rejected_events collection
      try {
        await RejectedEvent.create({
          rawPayload: req.body,
          deviceId: req.body?.deviceId || req.device?.deviceId || null,
          reason: `Validation failed: ${parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
          receivedAt: new Date()
        });
      } catch (err: any) {
        req.log?.warn({ err: err.message }, 'Failed to persist rejected event');
      }

      return res.status(400).json({
        error: 'Validation failed',
        details: parseResult.error.errors
      });
    }

    const event = parseResult.data;
    const serverReceivedAt = new Date();

    try {
      // 1. Insert into MongoDB FIRST as source of truth for deduplication
      const eventDoc = await Event.create({
        eventId: event.eventId,
        deviceId: event.deviceId,
        seq: event.seq,
        type: event.type,
        timestamp: new Date(event.timestamp),
        receivedAt: serverReceivedAt,
        payload: event.payload,
        replayed: false,
        processingStatus: 'pending'
      });

      // 2. Fast-path cache in Redis only AFTER successful insert
      try {
        await redis.set(`event_seen:${event.eventId}`, '1', 'EX', 86400);
      } catch {
        // Cache failure non-fatal
      }

      // 3. Update device lastSeenAt and status on accepted event (non-replayed only)
      const isReplay =
        Boolean(event.replayed) ||
        (serverReceivedAt.getTime() - new Date(event.timestamp).getTime() > 300000);

      if (!isReplay) {
        try {
          await Device.updateOne(
            { deviceId: event.deviceId },
            {
              $set: {
                lastSeenAt: serverReceivedAt,
                status: 'online'
              },
              $max: { lastSeq: event.seq }
            }
          );
        } catch (err: any) {
          req.log?.warn({ err: err.message }, 'Failed to update device lastSeenAt');
        }
      }

      // 4. Enqueue to BullMQ after insert
      try {
        const queue = getTelemetryQueue();
        await queue.add('telemetry-event', eventDoc.toObject(), {
          jobId: event.eventId
        });
      } catch (queueErr: any) {
        req.log?.error({ err: queueErr.message }, 'BullMQ enqueue failed; event left as pending in MongoDB');
        return res.status(503).json({
          error: 'Service Unavailable: Failed to enqueue event',
          status: 'service_unavailable'
        });
      }

      return res.status(202).json({
        status: 'accepted',
        eventId: event.eventId,
        receivedAt: serverReceivedAt.toISOString()
      });
    } catch (err: any) {
      // Check for MongoDB duplicate-key error (E11000)
      if (err.code === 11000 || String(err.message).includes('E11000')) {
        return res.status(200).json({
          status: 'duplicate',
          eventId: event.eventId,
          message: 'Duplicate event, already received'
        });
      }

      req.log?.error({ err: err.message }, 'Unexpected error inserting event');
      return res.status(500).json({
        error: 'Internal ingestion error',
        message: err.message
      });
    }
  }
);

// Batch event ingestion: POST /v1/events/batch
// Has its own, higher limit counted per request for burst reconnects
eventsRouter.post(
  '/batch',
  createRateLimiter({ max: 200, windowSeconds: 5, keyPrefix: 'ratelimit:batch' }),
  checkQueueBackpressure,
  async (req: Request, res: Response) => {
    const batchParse = batchEventsSchema.safeParse(req.body);

    if (!batchParse.success) {
      try {
        await RejectedEvent.create({
          rawPayload: req.body,
          deviceId: req.device?.deviceId || null,
          reason: `Invalid batch format: ${batchParse.error.errors.map((e) => e.message).join(', ')}`,
          receivedAt: new Date()
        });
      } catch {
        // ignore
      }

      return res.status(400).json({
        error: 'Invalid batch format',
        details: batchParse.error.errors
      });
    }

    const rawEvents = batchParse.data.events;
    const queue = getTelemetryQueue();
    const results: Array<Record<string, unknown>> = [];

    let acceptedCount = 0;
    let duplicateCount = 0;
    let rejectedCount = 0;
    let maxBatchSeq = 0;
    let hasFreshAccepted = false;

    for (const rawItem of rawEvents) {
      const parseResult = telemetryEventSchema.safeParse(rawItem);

      if (!parseResult.success) {
        rejectedCount++;
        const reason = `Validation failed: ${parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`;

        try {
          await RejectedEvent.create({
            rawPayload: rawItem,
            deviceId: (rawItem as any)?.deviceId || req.device?.deviceId || null,
            reason,
            receivedAt: new Date()
          });
        } catch {
          // ignore persistence failure
        }

        results.push({
          status: 'rejected',
          error: 'Validation failed',
          details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`)
        });
        continue;
      }

      const event = parseResult.data;
      const serverReceivedAt = new Date();

      try {
        // Insert into MongoDB FIRST as source of truth for deduplication
        const isBatchItemReplay =
          Boolean(event.replayed) ||
          (serverReceivedAt.getTime() - new Date(event.timestamp).getTime() > 300000);

        const eventDoc = await Event.create({
          eventId: event.eventId,
          deviceId: event.deviceId,
          seq: event.seq,
          type: event.type,
          timestamp: new Date(event.timestamp),
          receivedAt: serverReceivedAt,
          payload: event.payload,
          replayed: Boolean(event.replayed),
          processingStatus: 'pending'
        });

        // Fast-path cache in Redis
        try {
          await redis.set(`event_seen:${event.eventId}`, '1', 'EX', 86400);
        } catch {
          // ignore
        }

        // Enqueue to BullMQ
        try {
          await queue.add('telemetry-event', eventDoc.toObject(), {
            jobId: event.eventId
          });
        } catch {
          // Leave pending in MongoDB for later sweep
        }

        if (!isBatchItemReplay && event.seq > maxBatchSeq) {
          maxBatchSeq = event.seq;
          hasFreshAccepted = true;
        }

        acceptedCount++;
        results.push({
          status: 'accepted',
          eventId: event.eventId
        });
      } catch (insertErr: any) {
        if (insertErr.code === 11000 || String(insertErr.message).includes('E11000')) {
          duplicateCount++;
          results.push({
            status: 'duplicate',
            eventId: event.eventId,
            message: 'Duplicate event, already received'
          });
        } else {
          rejectedCount++;
          try {
            await RejectedEvent.create({
              rawPayload: rawItem,
              deviceId: event.deviceId,
              reason: `Insert error: ${insertErr.message}`,
              receivedAt: new Date()
            });
          } catch {
            // ignore
          }

          results.push({
            status: 'rejected',
            eventId: event.eventId,
            error: 'Database insert failed'
          });
        }
      }
    }

    // Update device lastSeenAt and status only if fresh (non-replayed) events were accepted
    if (hasFreshAccepted && req.device?.deviceId) {
      try {
        await Device.updateOne(
          { deviceId: req.device.deviceId },
          {
            $set: {
              lastSeenAt: new Date(),
              status: 'online'
            },
            $max: { lastSeq: maxBatchSeq }
          }
        );
      } catch {
        // non-fatal
      }
    }

    return res.status(200).json({
      status: 'batch_processed',
      summary: {
        total: rawEvents.length,
        accepted: acceptedCount,
        duplicate: duplicateCount,
        rejected: rejectedCount
      },
      results
    });
  }
);

// Query rejected events for verification: GET /v1/events/rejected
eventsRouter.get('/rejected', async (req: Request, res: Response) => {
  try {
    const filter: Record<string, unknown> = {};
    if (req.query.deviceId) {
      filter.deviceId = String(req.query.deviceId);
    } else if (req.device?.deviceId) {
      filter.$or = [{ deviceId: req.device.deviceId }, { deviceId: null }];
    }

    const rejected = await RejectedEvent.find(filter)
      .sort({ receivedAt: -1 })
      .limit(50)
      .lean();

    return res.status(200).json({
      count: rejected.length,
      rejected
    });
  } catch (err: any) {
    return res.status(500).json({
      error: 'Failed to query rejected events',
      message: err.message
    });
  }
});

// GET /v1/events/:id/evaluations - Explainability records for an event
eventsRouter.get('/:id/evaluations', async (req: Request, res: Response) => {
  try {
    const evaluations = await RuleEvaluation.find({ eventId: req.params.id })
      .sort({ evaluatedAt: 1 })
      .lean();

    return res.status(200).json({
      eventId: req.params.id,
      count: evaluations.length,
      evaluations
    });
  } catch (err: any) {
    return res.status(500).json({
      error: 'Failed to query rule evaluations',
      message: err.message
    });
  }
});


