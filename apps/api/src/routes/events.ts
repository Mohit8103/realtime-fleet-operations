import { Router, type Request, type Response, type NextFunction } from 'express';
import { createRedisClient, publishRealtimeEvent } from '@fleet/config';
import { requireApiKey } from '../middleware/auth.js';
import { dashboardAuth } from '../middleware/dashboardAuth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { checkQueueBackpressure } from '../middleware/queueBackpressure.js';
import { telemetryEventSchema, batchEventsSchema } from '../schemas/eventSchema.js';
import { getTelemetryQueue } from '../queue/telemetryQueue.js';
import { Event, Device, RejectedEvent, RuleEvaluation } from '@fleet/database';

export const eventsRouter = Router();
const redis = createRedisClient();

// GET /v1/events - Recent events (paginated, filter by type and device)
eventsRouter.get('/', dashboardAuth, async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 100);
  const page = parseInt(req.query.page as string, 10);
  const offset = req.query.offset !== undefined
    ? parseInt(req.query.offset as string, 10) || 0
    : page ? Math.max((page - 1) * limit, 0) : 0;

  try {
    const filter: Record<string, unknown> = {};

    if (req.query.type) {
      filter.type = String(req.query.type);
    }
    const deviceId = req.query.deviceId || req.query.device;
    if (deviceId) {
      filter.deviceId = String(deviceId);
    }

    const [events, total] = await Promise.all([
      Event.find(filter)
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Event.countDocuments(filter)
    ]);

    return res.status(200).json({
      count: events.length,
      total,
      limit,
      offset,
      events
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to list events');
    return res.status(500).json({
      error: 'Failed to list events',
      message: err.message
    });
  }
});

// Single event ingestion: POST /v1/events
// Uses per-device rate limiting and queue backpressure
eventsRouter.post(
  '/',
  requireApiKey,
  createRateLimiter({ max: 100, windowSeconds: 5, keyPrefix: 'ratelimit:single' }),
  checkQueueBackpressure,
  async (req: Request, res: Response) => {
    const parseResult = telemetryEventSchema.safeParse(req.body);

    if (!parseResult.success) {
      // Increment Redis rejected counter
      redis.incr('stats:rejected_count').catch(() => {});

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

      req.log?.warn(
        {
          eventId: req.body?.eventId || null,
          deviceId: req.body?.deviceId || req.device?.deviceId || null,
          reason: `Validation failed: ${parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`
        },
        'Event rejected: validation failed'
      );

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

      req.log?.info(
        { eventId: event.eventId, deviceId: event.deviceId },
        'Event ingested'
      );

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

      // 4. Publish event_ingested to realtime SSE stream
      publishRealtimeEvent({
        event: 'event_ingested',
        data: eventDoc.toObject()
      }).catch((streamErr: any) => {
        req.log?.warn({ err: streamErr.message }, 'Failed to publish event_ingested stream');
      });

      // 5. Enqueue to BullMQ after insert
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
        redis.incr('stats:duplicates_count').catch(() => {});

        req.log?.info(
          { eventId: event.eventId, deviceId: event.deviceId },
          'Duplicate event ignored'
        );

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
  requireApiKey,
  createRateLimiter({ max: 200, windowSeconds: 5, keyPrefix: 'ratelimit:batch' }),
  checkQueueBackpressure,
  async (req: Request, res: Response) => {
    const batchParse = batchEventsSchema.safeParse(req.body);

    if (!batchParse.success) {
      redis.incr('stats:rejected_count').catch(() => {});

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
    const results: Array<Record<string, unknown>> = new Array(rawEvents.length);

    let acceptedCount = 0;
    let duplicateCount = 0;
    let rejectedCount = 0;
    let maxBatchSeq = 0;
    let hasFreshAccepted = false;

    // Process in parallel chunks of 10 for high throughput without exhausting connections
    const BATCH_CHUNK_SIZE = 10;
    for (let i = 0; i < rawEvents.length; i += BATCH_CHUNK_SIZE) {
      const chunk = rawEvents.slice(i, i + BATCH_CHUNK_SIZE);
      await Promise.all(
        chunk.map(async (rawItem, chunkIdx) => {
          const globalIdx = i + chunkIdx;
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

            req.log?.warn(
              {
                eventId: (rawItem as any)?.eventId || null,
                deviceId: (rawItem as any)?.deviceId || req.device?.deviceId || null,
                reason
              },
              'Batch event rejected: validation failed'
            );

            results[globalIdx] = {
              status: 'rejected',
              error: 'Validation failed',
              details: parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`)
            };
            return;
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

            req.log?.info(
              { eventId: event.eventId, deviceId: event.deviceId },
              'Event ingested (batch)'
            );

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

            // Publish event_ingested to realtime SSE stream
            publishRealtimeEvent({
              event: 'event_ingested',
              data: eventDoc.toObject()
            }).catch(() => {});

            if (!isBatchItemReplay && event.seq > maxBatchSeq) {
              maxBatchSeq = event.seq;
              hasFreshAccepted = true;
            }

            acceptedCount++;
            results[globalIdx] = {
              status: 'accepted',
              eventId: event.eventId
            };
          } catch (insertErr: any) {
            if (insertErr.code === 11000 || String(insertErr.message).includes('E11000')) {
              duplicateCount++;
              req.log?.info(
                { eventId: event.eventId, deviceId: event.deviceId },
                'Duplicate event ignored (batch)'
              );
              results[globalIdx] = {
                status: 'duplicate',
                eventId: event.eventId,
                message: 'Duplicate event, already received'
              };
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

              req.log?.warn(
                { eventId: event.eventId, deviceId: event.deviceId, reason: insertErr.message },
                'Batch event rejected: insert error'
              );

              results[globalIdx] = {
                status: 'rejected',
                eventId: event.eventId,
                error: 'Database insert failed'
              };
            }
          }
        })
      );
    }

    // Increment Redis counters for stats reporting
    if (duplicateCount > 0) {
      redis.incrby('stats:duplicates_count', duplicateCount).catch(() => {});
    }
    if (rejectedCount > 0) {
      redis.incrby('stats:rejected_count', rejectedCount).catch(() => {});
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
eventsRouter.get('/rejected', async (req: Request, res: Response, next: NextFunction) => {
  // Allow authentication via x-api-key or dashboard token
  if (req.headers['x-api-key'] || req.headers['X-API-KEY']) {
    return requireApiKey(req, res, () => handleGetRejected(req, res));
  }
  return dashboardAuth(req, res, () => handleGetRejected(req, res));
});

async function handleGetRejected(req: Request, res: Response) {
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
}

// GET /v1/events/:id/evaluations - Explainability records for an event
eventsRouter.get('/:id/evaluations', dashboardAuth, async (req: Request, res: Response) => {
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
