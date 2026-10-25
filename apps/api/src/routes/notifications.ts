import { Router, type Request, type Response } from 'express';
import { Notification } from '@fleet/database';

export const notificationsRouter = Router();

// GET /v1/notifications - List outbox notifications
notificationsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const filter: Record<string, unknown> = {};

    if (req.query.status) {
      filter.status = req.query.status;
    }
    if (req.query.incidentId) {
      filter.incidentId = req.query.incidentId;
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    return res.status(200).json({
      count: notifications.length,
      notifications
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to query notifications');
    return res.status(500).json({ error: 'Failed to query notifications', message: err.message });
  }
});
