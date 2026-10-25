import {
  connectMongo,
  Event,
  Incident,
  Notification,
  RuleEvaluation,
  RejectedEvent,
  Device,
  Rule
} from '@fleet/database';
import {
  createRedisClient,
  REALTIME_STREAM_KEY,
  REALTIME_ACTIVITY_KEY,
  REALTIME_SEQ_KEY
} from '@fleet/config';
import mongoose from 'mongoose';
import { Queue } from 'bullmq';
import { seed } from './seed.js';

async function resetData() {
  console.log('🧹 [reset-data] Resetting all data, collections, and Redis queues...');
  await connectMongo();

  const collections = [
    { name: 'rules', model: Rule },
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

  // Ensure unique indexes
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

      const ruleCol = db.collection('rules');
      await ruleCol.createIndex({ name: 1 }, { unique: true });
      console.log('✅ Verified unique index on rules.name');
    }
  } catch (err: any) {
    console.warn('⚠️ Warning verifying indexes:', err.message);
  }

  // Clear Redis streams, counters, activity, and BullMQ queues
  const redis = createRedisClient();
  try {
    await redis.del(
      REALTIME_STREAM_KEY,
      REALTIME_ACTIVITY_KEY,
      REALTIME_SEQ_KEY,
      'fleet:stats:duplicates',
      'fleet:stats:rejected',
      'stats:duplicates_count',
      'stats:rejected_count'
    );
    console.log('✅ Cleared Redis stream, activity feed, and counters');

    // Obliterate BullMQ telemetry queue
    const queue = new Queue('telemetry-queue', { connection: redis });
    try {
      await queue.obliterate({ force: true });
      console.log('✅ Obliterated telemetry-queue');
    } catch {
      // non-fatal
    }

    const staleQueue = new Queue('stale-detection-queue', { connection: redis });
    try {
      await staleQueue.obliterate({ force: true });
      console.log('✅ Obliterated stale-detection-queue');
    } catch {
      // non-fatal
    }
  } catch (err: any) {
    console.warn('⚠️ Warning clearing Redis:', err.message);
  } finally {
    redis.disconnect();
  }

  // Run seed to populate the exact 2 rules and default operator
  await seed();

  console.log('✨ [reset-data] Reset and seed complete!');
  process.exit(0);
}

resetData().catch((err) => {
  console.error('❌ [reset-data] Failed:', err);
  process.exit(1);
});
