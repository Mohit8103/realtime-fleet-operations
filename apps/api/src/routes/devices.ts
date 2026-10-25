import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { createRedisClient } from '@fleet/config';
import { deviceRegistrationSchema } from '../schemas/eventSchema.js';
import { Device, Event, calculateDeviceStatus } from '@fleet/database';
import { dashboardAuth } from '../middleware/dashboardAuth.js';

export const devicesRouter = Router();
const redis = createRedisClient();

export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
}

// POST /v1/devices - Register or rotate device API key
devicesRouter.post('/', async (req: Request, res: Response) => {
  const parseResult = deviceRegistrationSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid device registration data',
      details: parseResult.error.errors
    });
  }

  const { deviceId, name, location } = parseResult.data;

  try {
    // Generate secure plaintext API key for client
    const apiKey = 'fleet_' + crypto.randomBytes(24).toString('hex');
    const apiKeyHash = hashApiKey(apiKey);

    let device = await Device.findOne({ deviceId });

    if (device) {
      // Rotate API key and update hash in MongoDB
      device.name = name || device.name;
      device.location = location || device.location;
      device.apiKeyHash = apiKeyHash;
      await device.save();

      // Cache by hash in Redis (DO NOT use plaintext key in Redis key names)
      await redis.set(`device_key:${apiKeyHash}`, device.deviceId, 'EX', 86400);

      return res.status(200).json({
        status: 'registered',
        deviceId: device.deviceId,
        name: device.name,
        location: device.location,
        apiKey,
        createdAt: device.createdAt
      });
    }

    device = await Device.create({
      deviceId,
      name: name || deviceId,
      location: location || 'default',
      apiKeyHash,
      status: 'registered'
    });

    // Cache by hash in Redis
    await redis.set(`device_key:${apiKeyHash}`, device.deviceId, 'EX', 86400);

    return res.status(201).json({
      status: 'created',
      deviceId: device.deviceId,
      name: device.name,
      location: device.location,
      apiKey,
      createdAt: device.createdAt
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to register device');
    return res.status(500).json({
      error: 'Failed to register device',
      message: err.message
    });
  }
});

// GET /v1/devices - List devices with computed status, location, lastSeenAt, lastSeq, event counts
devicesRouter.get('/', dashboardAuth, async (req: Request, res: Response) => {
  try {
    const mongoFilter: Record<string, unknown> = {};

    if (req.query.location) {
      mongoFilter.location = String(req.query.location);
    }
    if (req.query.search) {
      const searchRegex = new RegExp(String(req.query.search), 'i');
      mongoFilter.$or = [{ deviceId: searchRegex }, { name: searchRegex }];
    }

    const [devices, eventCounts] = await Promise.all([
      Device.find(mongoFilter).sort({ createdAt: -1 }).lean(),
      Event.aggregate([
        { $group: { _id: '$deviceId', count: { $sum: 1 } } }
      ])
    ]);

    const countMap = new Map<string, number>();
    for (const ec of eventCounts) {
      countMap.set(ec._id, ec.count);
    }

    // Compute status dynamically from lastSeenAt and thresholds
    let formatted = devices.map((dev) => {
      const computedStatus = calculateDeviceStatus(dev.lastSeenAt);
      return {
        deviceId: dev.deviceId,
        name: dev.name,
        location: dev.location,
        status: computedStatus,
        lastSeenAt: dev.lastSeenAt || null,
        lastSeq: dev.lastSeq || 0,
        eventCount: countMap.get(dev.deviceId) || 0,
        createdAt: dev.createdAt,
        updatedAt: dev.updatedAt
      };
    });

    // Optional status filter on computed status
    if (req.query.status) {
      const statusFilter = String(req.query.status).toLowerCase();
      formatted = formatted.filter((d) => d.status.toLowerCase() === statusFilter);
    }

    return res.status(200).json({
      count: formatted.length,
      devices: formatted
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to list devices');
    return res.status(500).json({
      error: 'Failed to list devices',
      message: err.message
    });
  }
});

// GET /v1/devices/:id/events - Recent events for a device (paginated)
devicesRouter.get('/:id/events', dashboardAuth, async (req: Request, res: Response) => {
  const deviceId = req.params.id;
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 100);
  const page = parseInt(req.query.page as string, 10);
  const offset = req.query.offset !== undefined
    ? parseInt(req.query.offset as string, 10) || 0
    : page ? Math.max((page - 1) * limit, 0) : 0;

  try {
    const [events, total] = await Promise.all([
      Event.find({ deviceId })
        .sort({ timestamp: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Event.countDocuments({ deviceId })
    ]);

    return res.status(200).json({
      deviceId,
      count: events.length,
      total,
      limit,
      offset,
      events
    });
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Failed to fetch device events');
    return res.status(500).json({
      error: 'Failed to fetch device events',
      message: err.message
    });
  }
});
