import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { createRedisClient, type Redis } from '@fleet/config';
import { Device } from '@fleet/database';

let redisClient: Redis | null = null;

function getRedis(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

declare global {
  namespace Express {
    interface Request {
      device?: {
        deviceId: string;
        apiKeyHash: string;
      };
    }
  }
}

export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey.trim()).digest('hex');
}

export async function requireApiKey(req: Request, res: Response, next: NextFunction) {
  const headerKey = req.headers['x-api-key'] || req.headers['X-API-KEY'];
  const apiKey = typeof headerKey === 'string' ? headerKey.trim() : undefined;

  if (!apiKey) {
    return res.status(401).json({
      error: 'Unauthorized: Missing x-api-key header'
    });
  }

  const redis = getRedis();
  const apiKeyHash = hashApiKey(apiKey);

  try {
    // Check Redis cache using SHA-256 hash (do NOT use plaintext key in Redis key names)
    let deviceId = await redis.get(`device_key:${apiKeyHash}`);

    if (deviceId) {
      // Must verify device document still exists in MongoDB
      const exists = await Device.exists({ deviceId, apiKeyHash });
      if (!exists) {
        req.log?.warn(
          { deviceId, apiKeyHash },
          'Cached device key points to missing Mongo device document; invalidating cache'
        );
        await redis.del(`device_key:${apiKeyHash}`);
        return res.status(401).json({
          error: 'Unauthorized: Device not found in database, please re-register'
        });
      }
    } else {
      // Fallback to MongoDB lookup by hash
      const device = await Device.findOne({ apiKeyHash }).lean();
      if (!device) {
        return res.status(401).json({
          error: 'Unauthorized: Invalid API key'
        });
      }

      deviceId = device.deviceId;
      await redis.set(`device_key:${apiKeyHash}`, deviceId, 'EX', 86400);
    }

    req.device = {
      deviceId,
      apiKeyHash
    };

    // If deviceId is provided in body, verify it matches the authenticated key
    if (req.body && req.body.deviceId && req.body.deviceId !== deviceId) {
      return res.status(403).json({
        error: 'Forbidden: deviceId in payload does not match API key owner'
      });
    }

    next();
  } catch (err: any) {
    req.log?.error({ err: err.message }, 'Authentication error');
    return res.status(500).json({ error: 'Internal authentication error' });
  }
}
