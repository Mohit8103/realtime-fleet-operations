import { Router, type Request, type Response } from 'express';
import { createRedisClient } from '@fleet/config';
import { Device, Event, Incident, Notification, RejectedEvent, calculateDeviceStatus, computeDeviceFleetCounts } from '@fleet/database';
import { getTelemetryQueue } from '../queue/telemetryQueue.js';
import { sseManager } from '../realtime/sseManager.js';
import { dashboardAuth } from '../middleware/dashboardAuth.js';

export const statsRouter = Router();
const redis = createRedisClient();

// GET /v1/stats - System operational status & metrics
statsRouter.get('/', dashboardAuth, async (req: Request, res: Response) => {
  try {
    const queue = getTelemetryQueue();
    const oneMinuteAgo = new Date(Date.now() - 60000);

    const [
      eventsPerMinute,
      devices,
      incidentsAgg,
      queueDepth,
      failedJobs,
      redisDuplicates,
      redisRejected,
      notifAgg
    ] = await Promise.all([
      // 1. Events per minute
      Event.countDocuments({ receivedAt: { $gte: oneMinuteAgo } }),

      // 2. Devices by status (computed dynamically)
      Device.find({}, { lastSeenAt: 1 }).lean(),

      // 3. Open and acknowledged incidents by severity
      Incident.aggregate([
        { $match: { state: { $in: ['open', 'acknowledged'] } } },
        { $group: { _id: '$severity', count: { $sum: 1 } } }
      ]),

      // 4. Queue depth
      queue.count().catch(() => 0),

      // 5. Failed jobs
      queue.getFailedCount().catch(() => 0),

      // 6. Redis counters for duplicates
      redis.get('stats:duplicates_count'),

      // 7. Redis counters for rejected
      redis.get('stats:rejected_count'),

      // 8. Notifications counts by status
      Notification.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } }
      ])
    ]);

    // Compute devices by status using shared function
    const devicesByStatus = computeDeviceFleetCounts(devices);

    // Incidents by severity
    const incidentsBySeverity: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0
    };
    for (const inc of incidentsAgg) {
      if (inc._id && incidentsBySeverity[inc._id] !== undefined) {
        incidentsBySeverity[inc._id] = inc.count;
      }
    }

    // Notifications counts
    const notifications: Record<string, number> = {
      pending: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      dead: 0
    };
    for (const n of notifAgg) {
      if (n._id && notifications[n._id] !== undefined) {
        notifications[n._id] = n.count;
      }
    }

    // Duplicates and rejected counts (fallback to DB counts if redis is unset)
    const duplicatesCount = redisDuplicates !== null
      ? parseInt(redisDuplicates, 10) || 0
      : 0;

    let rejectedCount = redisRejected !== null
      ? parseInt(redisRejected, 10) || 0
      : await RejectedEvent.countDocuments();

    return res.status(200).json({
      eventsPerMinute,
      devicesByStatus,
      incidentsBySeverity,
      queueDepth,
      failedJobs,
      duplicatesCount,
      rejectedCount,
      notifications: {
        pending: notifications.pending,
        failed: notifications.failed,
        dead: notifications.dead,
        sent: notifications.sent
      },
      sseClients: sseManager.getConnectedClientCount()
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to compute stats');
    return res.status(500).json({
      error: 'Failed to compute stats',
      message: err.message
    });
  }
});
