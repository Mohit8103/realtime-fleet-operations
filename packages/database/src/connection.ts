import mongoose from 'mongoose';
import dns from 'node:dns';
import { config } from '@fleet/config';
import { createLogger } from '@fleet/logger';
import { Device, type DeviceStatus } from './models/device.js';
import { Event } from './models/event.js';
import { Rule } from './models/rule.js';
import { Incident } from './models/incident.js';
import { RuleEvaluation } from './models/ruleEvaluation.js';
import { RejectedEvent } from './models/rejectedEvent.js';
import { Notification } from './models/notification.js';
import { Operator } from './models/operator.js';

// Ensure SRV DNS lookups for MongoDB Atlas succeed across environments
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {
  // ignore
}

const logger = createLogger({ service: 'database' });

let isConnected = false;

export async function connectMongo(): Promise<typeof mongoose> {
  if (isConnected) return mongoose;

  try {
    const maskedUri = config.mongo.url.replace(/\/\/[^:]+:[^@]+@/, '//***:***@');
    logger.info({ uri: maskedUri }, 'Connecting to MongoDB...');

    await mongoose.connect(config.mongo.url, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });

    isConnected = true;
    logger.info('✅ MongoDB connected successfully');

    // Ensure all unique indexes are initialized at startup
    await Promise.allSettled([
      Event.init(),
      Device.init(),
      Rule.init(),
      Incident.init(),
      RuleEvaluation.init(),
      RejectedEvent.init(),
      Notification.init(),
      Operator.init()
    ]);

    // Ensure 24-hour TTL index for storage hygiene on rule_evaluations
    try {
      const evalIndexes = await RuleEvaluation.collection.indexes();
      const existingTtl = evalIndexes.find((i) => i.name === 'evaluatedAt_1');
      if (existingTtl && !existingTtl.expireAfterSeconds) {
        await RuleEvaluation.collection.dropIndex('evaluatedAt_1');
      }
      await RuleEvaluation.collection.createIndex(
        { evaluatedAt: 1 },
        { expireAfterSeconds: 86400 }
      );
    } catch (idxErr: any) {
      logger.warn({ err: idxErr.message }, 'TTL index init note');
    }

    logger.info('✅ MongoDB collections & indexes initialized (events.eventId unique, rule_evaluations 24h TTL)');

    return mongoose;
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to connect to MongoDB');
    throw err;
  }
}

export async function disconnectMongo(): Promise<void> {
  if (!isConnected) return;
  await mongoose.disconnect();
  isConnected = false;
  logger.info('MongoDB disconnected');
}

/**
 * Compute device operational status dynamically from lastSeenAt
 */
export function calculateDeviceStatus(
  lastSeenAt?: Date | null,
  staleThresholdSeconds = config.fleet.staleDeviceThresholdSeconds,
  offlineThresholdSeconds = config.fleet.staleDeviceThresholdSeconds * 3
): DeviceStatus {
  if (!lastSeenAt) return 'registered';

  const diffSeconds = (Date.now() - new Date(lastSeenAt).getTime()) / 1000;

  if (diffSeconds > offlineThresholdSeconds) {
    return 'offline';
  }
  if (diffSeconds > staleThresholdSeconds) {
    return 'stale';
  }
  return 'online';
}

export { mongoose };
