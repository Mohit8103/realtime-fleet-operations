import {
  connectMongo,
  Event,
  Incident,
  Notification,
  RuleEvaluation,
  RejectedEvent,
  Device
} from '@fleet/database';
import { createRedisClient, REALTIME_STREAM_KEY, REALTIME_ACTIVITY_KEY, REALTIME_SEQ_KEY } from '@fleet/config';
import mongoose from 'mongoose';

async function cleanup() {
  console.log('🧹 Cleaning up database collections and test data...');
  await connectMongo();

  const collections = [
    { name: 'events', model: Event },
    { name: 'incidents', model: Incident },
    { name: 'notifications', model: Notification },
    { name: 'rule_evaluations', model: RuleEvaluation },
    { name: 'rejected_events', model: RejectedEvent },
    { name: 'devices', model: Device }
  ];

  for (const c of collections) {
    try {
      const count = await c.model.countDocuments();
      await c.model.deleteMany({});
      console.log(`✅ Cleared ${c.name} (${count} documents removed)`);
    } catch (err: any) {
      console.warn(`⚠️ Warning clearing ${c.name}:`, err.message);
    }
  }

  // Ensure unique partial index on incidents dedupeKey
  try {
    const db = mongoose.connection.db;
    if (db) {
      const incCol = db.collection('incidents');
      await incCol.createIndex(
        { dedupeKey: 1 },
        {
          unique: true,
          partialFilterExpression: { state: { $in: ['open', 'acknowledged'] } }
        }
      );
      console.log('✅ Verified unique partial index on incidents.dedupeKey');

      const notifCol = db.collection('notifications');
      await notifCol.createIndex(
        { incidentId: 1 },
        {
          unique: true,
          partialFilterExpression: { incidentId: { $type: 'string' } }
        }
      );
      console.log('✅ Verified unique index on notifications.incidentId');
    }
  } catch (err: any) {
    console.warn('⚠️ Warning verifying indexes:', err.message);
  }

  // Clear Redis activity feed & stream
  try {
    const redis = createRedisClient();
    await redis.del(
      REALTIME_STREAM_KEY,
      REALTIME_ACTIVITY_KEY,
      REALTIME_SEQ_KEY,
      'fleet:stats:duplicates',
      'fleet:stats:rejected'
    );
    for (const pattern of ['device_key:*', 'event_seen:*', 'ratelimit:*']) {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== '0');
    }
    console.log('✅ Cleared Redis stream, activity feed, and cached device_key:* entries');
    redis.disconnect();
  } catch (err: any) {
    console.warn('⚠️ Warning clearing Redis:', err.message);
  }

  console.log('✨ Cleanup complete!');
  process.exit(0);
}

cleanup().catch((err) => {
  console.error('❌ Cleanup failed:', err);
  process.exit(1);
});
