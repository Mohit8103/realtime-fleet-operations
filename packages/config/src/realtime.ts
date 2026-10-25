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

const ATOMIC_PUBLISH_LUA = `
local seq = redis.call('INCR', KEYS[1])
local entryId = tostring(seq) .. '-0'
redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[1], entryId, 'id', tostring(seq), 'event', ARGV[2], 'data', ARGV[3], 'timestamp', ARGV[4])
local msg = cjson.encode({
  id = seq,
  event = ARGV[2],
  data = cjson.decode(ARGV[3]),
  timestamp = ARGV[4]
})
redis.call('PUBLISH', KEYS[3], msg)
return seq
`;

/**
 * Shared publisher helper:
 * 1. Monotonically increments numeric ID sequence and performs capped XADD and Pub/Sub atomically via Lua script
 * 2. Capped XADD to bounded Redis stream (MAXLEN ~ sseMaxLen, default 500)
 * 3. Redis Pub/Sub broadcast for multi-instance API fan-out
 * 4. Bounded recent activity recording
 */
export async function publishRealtimeEvent(params: {
  event: RealtimeEventType;
  data: any;
}): Promise<RealtimeMessage> {
  const redis = getPublisherRedis();
  const now = new Date().toISOString();
  const maxLen = config.redisMemory?.sseMaxLen || 500;
  const payloadJson = JSON.stringify(params.data || {});

  // Atomically INCR, capped XADD, and PUBLISH via Lua script to prevent out-of-order stream ID races
  const seq = (await redis.eval(
    ATOMIC_PUBLISH_LUA,
    3,
    REALTIME_SEQ_KEY,
    REALTIME_STREAM_KEY,
    REALTIME_PUBSUB_CHANNEL,
    maxLen,
    params.event,
    payloadJson,
    now
  )) as number;

  const msg: RealtimeMessage = {
    id: Number(seq),
    event: params.event,
    data: params.data,
    timestamp: now
  };

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
