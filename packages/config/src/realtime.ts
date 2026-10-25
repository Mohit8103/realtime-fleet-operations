import { createRedisClient, type Redis } from './redis.js';
import { config } from './index.js';

let sharedPublisherRedis: Redis | null = null;

function getPublisherRedis(): Redis {
  if (!sharedPublisherRedis) {
    sharedPublisherRedis = createRedisClient();
  }
  return sharedPublisherRedis;
}

export type RealtimeEventType =
  | 'event_ingested'
  | 'incident_created'
  | 'incident_updated'
  | 'device_status_changed'
  | 'resync_required'
  | string;

export interface RealtimeMessage {
  id: number;
  event: RealtimeEventType;
  data: any;
  timestamp: string;
}

export const REALTIME_STREAM_KEY = 'fleet:stream:events';
export const REALTIME_PUBSUB_CHANNEL = 'fleet:pubsub:sse';
export const REALTIME_SEQ_KEY = 'fleet:stream:id_seq';
export const REALTIME_ACTIVITY_KEY = 'fleet:activity:recent';

/**
 * Shared publisher helper:
 * 1. Monotonically increments numeric ID sequence
 * 2. Capped XADD to bounded Redis stream (MAXLEN ~ sseMaxLen, default 500)
 * 3. Redis Pub/Sub broadcast for multi-instance API fan-out
 * 4. Bounded recent activity recording
 */
export async function publishRealtimeEvent(params: {
  event: RealtimeEventType;
  data: any;
}): Promise<RealtimeMessage> {
  const redis = getPublisherRedis();
  const seq = await redis.incr(REALTIME_SEQ_KEY);
  const now = new Date().toISOString();
  const maxLen = config.redisMemory?.sseMaxLen || 500;

  const msg: RealtimeMessage = {
    id: seq,
    event: params.event,
    data: params.data,
    timestamp: now
  };

  const entryId = `${seq}-0`;
  const payloadJson = JSON.stringify(params.data);

  // 1. Capped XADD to Redis Stream
  await redis.xadd(
    REALTIME_STREAM_KEY,
    'MAXLEN',
    '~',
    maxLen,
    entryId,
    'id',
    String(seq),
    'event',
    params.event,
    'data',
    payloadJson,
    'timestamp',
    now
  );

  // 2. Publish to Redis Pub/Sub notification for every API instance
  await redis.publish(
    REALTIME_PUBSUB_CHANNEL,
    JSON.stringify(msg)
  );

  // 3. Record in bounded recent activity list if relevant activity event
  if (
    params.event === 'incident_created' ||
    params.event === 'incident_updated' ||
    params.event === 'device_status_changed'
  ) {
    try {
      await redis.lpush(
        REALTIME_ACTIVITY_KEY,
        JSON.stringify({
          id: seq,
          type: params.event,
          data: params.data,
          timestamp: now
        })
      );
      await redis.ltrim(REALTIME_ACTIVITY_KEY, 0, 99);
    } catch {
      // Non-fatal activity caching
    }
  }

  return msg;
}

/**
 * Record notification failure in recent activity feed
 */
export async function recordNotificationFailureActivity(params: {
  notificationId: string;
  incidentId: string;
  operatorId?: string | null;
  error?: string | null;
  attempts: number;
}): Promise<void> {
  const redis = getPublisherRedis();
  const seq = await redis.incr(REALTIME_SEQ_KEY);
  const now = new Date().toISOString();

  try {
    await redis.lpush(
      REALTIME_ACTIVITY_KEY,
      JSON.stringify({
        id: seq,
        type: 'notification_failed',
        data: params,
        timestamp: now
      })
    );
    await redis.ltrim(REALTIME_ACTIVITY_KEY, 0, 99);
  } catch {
    // Non-fatal
  }
}
