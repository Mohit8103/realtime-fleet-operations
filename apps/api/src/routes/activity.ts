import { Router, type Request, type Response } from 'express';
import { createRedisClient, REALTIME_ACTIVITY_KEY } from '@fleet/config';
import { Incident, Notification } from '@fleet/database';
import { dashboardAuth } from '../middleware/dashboardAuth.js';

export const activityRouter = Router();
const redis = createRedisClient();

export interface ActivityItem {
  id?: number | string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// GET /v1/activity - Recent activity feed (bounded)
activityRouter.get('/', dashboardAuth, async (req: Request, res: Response) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 100);

  try {
    // 1. Fetch recent activity recorded in Redis bounded list
    const rawItems = await redis.lrange(REALTIME_ACTIVITY_KEY, 0, limit - 1);
    const redisActivity: ActivityItem[] = [];

    for (const itemStr of rawItems) {
      try {
        redisActivity.push(JSON.parse(itemStr));
      } catch {
        // ignore
      }
    }

    // 2. If Redis activity is sparse (e.g. startup/testing), augment from MongoDB incidents timeline & notification failures
    if (redisActivity.length < limit) {
      const needed = limit - redisActivity.length;
      const [recentIncidents, failedNotifs] = await Promise.all([
        Incident.find({})
          .sort({ updatedAt: -1 })
          .limit(needed)
          .lean(),
        Notification.find({ status: { $in: ['failed', 'dead'] } })
          .sort({ updatedAt: -1 })
          .limit(10)
          .lean()
      ]);

      const mongoActivity: ActivityItem[] = [];

      for (const inc of recentIncidents) {
        if (inc.timeline && inc.timeline.length) {
          for (const tl of inc.timeline.slice(-3)) {
            mongoActivity.push({
              type: `incident_${tl.action}`,
              timestamp: new Date(tl.timestamp || inc.updatedAt).toISOString(),
              data: {
                incidentId: inc.incidentId,
                ruleName: inc.ruleName,
                deviceId: inc.deviceId,
                severity: inc.severity,
                state: inc.state,
                action: tl.action,
                note: tl.note
              }
            });
          }
        }
      }

      for (const fn of failedNotifs) {
        mongoActivity.push({
          type: 'notification_failed',
          timestamp: new Date(fn.updatedAt || fn.createdAt).toISOString(),
          data: {
            notificationId: fn.notificationId,
            incidentId: fn.incidentId,
            operatorId: fn.operatorId,
            status: fn.status,
            error: fn.lastError,
            attempts: fn.attempts
          }
        });
      }

      // Merge and sort by timestamp descending
      const seen = new Set<string>();
      const combined: ActivityItem[] = [];

      for (const item of [...redisActivity, ...mongoActivity]) {
        const key = `${item.type}:${item.timestamp}:${JSON.stringify(item.data.incidentId || item.data.notificationId || item.id || '')}`;
        if (!seen.has(key)) {
          seen.add(key);
          combined.push(item);
        }
      }

      combined.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      const finalActivity = combined.slice(0, limit);
      return res.status(200).json({
        count: finalActivity.length,
        activity: finalActivity
      });
    }

    return res.status(200).json({
      count: redisActivity.length,
      activity: redisActivity
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to query activity');
    return res.status(500).json({
      error: 'Failed to query activity feed',
      message: err.message
    });
  }
});
