import { Router, type Request, type Response } from 'express';
import { Event, RejectedEvent } from '@fleet/database';
import { getTelemetryQueue } from '../queue/telemetryQueue.js';

export const adminRouter = Router();

// GET /v1/admin/failed-events - List all permanently failed events with errors (paginated)
adminRouter.get('/failed-events', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const page = parseInt(req.query.page as string, 10);
    const offset = req.query.offset !== undefined
      ? parseInt(req.query.offset as string, 10) || 0
      : page ? Math.max((page - 1) * limit, 0) : 0;

    const filter: Record<string, unknown> = { processingStatus: 'failed' };
    if (req.query.deviceId) {
      filter.deviceId = String(req.query.deviceId);
    }

    const [failedEvents, total] = await Promise.all([
      Event.find(filter)
        .sort({ updatedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Event.countDocuments(filter)
    ]);

    return res.status(200).json({
      count: failedEvents.length,
      total,
      limit,
      offset,
      failedEvents
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to query failed events');
    return res.status(500).json({ error: 'Failed to query failed events', message: err.message });
  }
});

// POST /v1/admin/failed-events/:id/retry - Re-enqueue a failed event
adminRouter.post('/failed-events/:id/retry', async (req: Request, res: Response) => {
  const eventId = String(req.params.id);

  try {
    const isObjectId = Boolean(eventId.match(/^[0-9a-fA-F]{24}$/));
    const queryConditions: any[] = [{ eventId }];
    if (isObjectId) {
      queryConditions.push({ _id: eventId });
    }
    const eventDoc = await Event.findOne({ $or: queryConditions });

    if (!eventDoc) {
      return res.status(404).json({
        error: 'Event not found',
        eventId
      });
    }

    // Reset failure state to pending
    eventDoc.processingStatus = 'pending';
    eventDoc.attempts = 0;
    eventDoc.error = null;
    eventDoc.updatedAt = new Date();
    await eventDoc.save();

    // Re-enqueue into BullMQ queue
    const queue = getTelemetryQueue();
    await queue.add('telemetry-event', eventDoc.toObject(), {
      jobId: `${eventDoc.eventId}:retry:${Date.now()}`
    });

    req.log?.info(
      { eventId: eventDoc.eventId, deviceId: eventDoc.deviceId },
      '🔄 Failed event re-enqueued by admin'
    );

    return res.status(200).json({
      status: 're_enqueued',
      eventId: eventDoc.eventId,
      processingStatus: eventDoc.processingStatus
    });
  } catch (err: any) {
    req.log?.error({ err: err.message, eventId }, 'Failed to re-enqueue event');
    return res.status(500).json({
      error: 'Failed to re-enqueue event',
      message: err.message
    });
  }
});

// GET /v1/admin/rejected-events - List rejected events (paginated)
adminRouter.get('/rejected-events', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    const page = parseInt(req.query.page as string, 10);
    const offset = req.query.offset !== undefined
      ? parseInt(req.query.offset as string, 10) || 0
      : page ? Math.max((page - 1) * limit, 0) : 0;

    const filter: Record<string, unknown> = {};
    if (req.query.deviceId) {
      filter.deviceId = String(req.query.deviceId);
    }

    const [rejectedEvents, total] = await Promise.all([
      RejectedEvent.find(filter)
        .sort({ receivedAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      RejectedEvent.countDocuments(filter)
    ]);

    return res.status(200).json({
      count: rejectedEvents.length,
      total,
      limit,
      offset,
      rejectedEvents
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to query rejected events');
    return res.status(500).json({
      error: 'Failed to query rejected events',
      message: err.message
    });
  }
});

