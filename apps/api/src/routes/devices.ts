import { Router, type Request, type Response } from 'express';
import crypto from 'node:crypto';
import { createRedisClient } from '@fleet/config';
import { deviceRegistrationSchema } from '../schemas/eventSchema.js';
import { Device } from '@fleet/database';

export const devicesRouter = Router();
const redis = createRedisClient();

export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
}

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
