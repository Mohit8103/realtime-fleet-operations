import { Router, type Request, type Response } from 'express';
import { Event } from '@fleet/database';

export const adminRouter = Router();

// GET /v1/admin/failed-events - List all permanently failed events with errors
adminRouter.get('/failed-events', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const failedEvents = await Event.find({ processingStatus: 'failed' })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      count: failedEvents.length,
      failedEvents
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to query failed events');
    return res.status(500).json({ error: 'Failed to query failed events', message: err.message });
  }
});
