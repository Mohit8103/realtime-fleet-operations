import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.API || 'http://localhost:3000';
const KEY_HEADER = 'x-api-key';

async function call(path, { method = 'POST', body, key, headers: extraHeaders } = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (key) headers[KEY_HEADER] = key;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json, headers: res.headers };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForEvaluations(eventId, key, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await call(`/v1/events/${eventId}/evaluations`, { method: 'GET', key });
    if (res.json?.evaluations?.length > 0) {
      return res.json.evaluations;
    }
    await sleep(400);
  }
  return [];
}

async function runPhase2Tests() {
  console.log('\n======================================================');
  console.log('🧪 Starting Phase 2 Engine & Worker Acceptance Tests');
  console.log('======================================================\n');

  // Initialize DB connection early
  const { Event, Incident, RuleEvaluation, Rule, Device, connectMongo } = await import('@fleet/database');
  const mongoose = (await import('mongoose')).default;
  await connectMongo();

  // Clean up any previously created test rules to keep tests fast and isolated
  await Rule.deleteMany({ name: 'High Heat Alert' });

  // 1. Register a test device
  const deviceId = 'phase2-dev-' + Date.now();
  const reg = await call('/v1/devices', {
    body: { deviceId, name: deviceId, location: 'datacenter-1' }
  });
  console.log('1. Device Registration:', reg.status, reg.json?.deviceId);
  const key = reg.json?.apiKey;
  if (!key) throw new Error('Failed to get API key');

  // 2. Create a threshold rule via REST /v1/rules
  const ruleRes = await call('/v1/rules', {
    body: {
      name: 'High Heat Alert',
      type: 'threshold',
      severity: 'high',
      enabled: true,
      cooldownSeconds: 0,
      notifyOperator: 'op-alpha',
      conditions: {
        metric: 'temperature',
        operator: '>',
        value: 70,
        deviceFilter: { type: 'all' }
      }
    }
  });
  console.log('2. Rule Created:', ruleRes.status, ruleRes.json?.rule?._id, ruleRes.json?.rule?.name);
  const ruleId = ruleRes.json?.rule?._id;
  if (!ruleId) throw new Error('Failed to create rule');

  // 3. Test Threshold Match (temperature = 75 > 70)
  const matchEventId = crypto.randomUUID();
  const matchEv = {
    eventId: matchEventId,
    deviceId,
    seq: 1,
    type: 'reading',
    timestamp: new Date().toISOString(),
    payload: { temperature: 75 }
  };
  const sendMatch = await call('/v1/events', { body: matchEv, key });
  console.log('3a. Ingest Matching Event (75 > 70):', sendMatch.status, sendMatch.json?.status);

  // Poll for explainability evaluations
  const evalsMatch = await waitForEvaluations(matchEventId, key);
  console.log('3b. Evaluation for matching event:');
  console.log(JSON.stringify(evalsMatch[0], null, 2));

  if (!evalsMatch[0]?.matched) {
    throw new Error('Expected rule evaluation to match!');
  }

  // 4. Test Threshold NO MATCH (temperature = 65 not > 70)
  const noMatchEventId = crypto.randomUUID();
  const noMatchEv = {
    eventId: noMatchEventId,
    deviceId,
    seq: 2,
    type: 'reading',
    timestamp: new Date().toISOString(),
    payload: { temperature: 65 }
  };
  const sendNoMatch = await call('/v1/events', { body: noMatchEv, key });
  console.log('4a. Ingest Non-Matching Event (65 not > 70):', sendNoMatch.status, sendNoMatch.json?.status);

  const evalsNoMatch = await waitForEvaluations(noMatchEventId, key);
  console.log('4b. Evaluation for non-matching event:');
  console.log(JSON.stringify(evalsNoMatch[0], null, 2));

  if (evalsNoMatch[0]?.matched !== false) {
    throw new Error('Expected rule evaluation to NOT match!');
  }

  // 5. Reprocessing Idempotency: reprocess event and verify no duplicate incident or evaluation
  const initialIncidents = await Incident.countDocuments({ eventId: matchEventId });
  const initialEvals = await RuleEvaluation.countDocuments({ eventId: matchEventId });

  // Re-enqueue the same job to BullMQ
  const { Queue } = await import('bullmq');
  const Redis = (await import('ioredis')).default;
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  const queue = new Queue('telemetry-queue', { connection: redis });

  await queue.add('telemetry-event', matchEv, { jobId: 'reprocess-test-' + Date.now() });
  await sleep(2000);

  const afterIncidents = await Incident.countDocuments({ eventId: matchEventId });
  const afterEvals = await RuleEvaluation.countDocuments({ eventId: matchEventId });

  console.log('5. Idempotent Reprocessing Check:');
  console.log(`   Incidents before: ${initialIncidents}, after: ${afterIncidents}`);
  console.log(`   Evaluations before: ${initialEvals}, after: ${afterEvals}`);
  if (initialIncidents !== afterIncidents || initialEvals !== afterEvals) {
    throw new Error('Reprocessing event created duplicate incidents or evaluations!');
  }

  // 6. Sweeper Test: insert an event directly as "pending", run sweep, verify it gets processed
  const pendingEventId = crypto.randomUUID();
  await Event.create({
    eventId: pendingEventId,
    deviceId,
    seq: 10,
    type: 'reading',
    timestamp: new Date(),
    receivedAt: new Date(),
    payload: { temperature: 80 },
    replayed: false,
    processingStatus: 'pending'
  });

  const { executeSweep } = await import('./apps/worker/dist/engine/sweeper.js');
  const sweepCount = await executeSweep(queue);
  console.log(`6a. Sweeper re-enqueued ${sweepCount} pending events`);

  // Wait for worker to transition swept event to completed
  let sweptEvent = null;
  const sweepStart = Date.now();
  while (Date.now() - sweepStart < 10000) {
    sweptEvent = await Event.findOne({ eventId: pendingEventId }).lean();
    if (sweptEvent?.processingStatus === 'completed') break;
    await sleep(400);
  }

  console.log(`6b. Swept event status after worker execution: ${sweptEvent?.processingStatus}`);
  if (sweptEvent?.processingStatus !== 'completed') {
    throw new Error(`Expected swept event to be completed, got: ${sweptEvent?.processingStatus}`);
  }

  // 7. Replayed Event Test: replayed event does NOT advance device lastSeenAt or resolve stale status
  // Resolve any existing open incidents so the replayed event can trigger a fresh incident
  await Incident.updateMany({ deviceId, state: 'open' }, { $set: { state: 'resolved' } });

  // Set device lastSeenAt to 1 hour ago and status to 'stale'
  const oneHourAgo = new Date(Date.now() - 3600000);
  await Device.updateOne(
    { deviceId },
    { $set: { lastSeenAt: oneHourAgo, status: 'stale', lastSeq: 50 } }
  );

  const replayEventId = crypto.randomUUID();
  const replayEv = {
    eventId: replayEventId,
    deviceId,
    seq: 5,
    type: 'reading',
    timestamp: new Date(Date.now() - 3600000).toISOString(),
    replayed: true,
    payload: { temperature: 85 } // exceeds threshold
  };

  await call('/v1/events', { body: replayEv, key });

  // Wait for incident to be created by worker
  let replayIncident = null;
  const replayStart = Date.now();
  while (Date.now() - replayStart < 10000) {
    replayIncident = await Incident.findOne({ eventId: replayEventId }).lean();
    if (replayIncident) break;
    await sleep(400);
  }

  console.log('7a. Replay incident fromReplay flag:', replayIncident?.fromReplay);
  if (!replayIncident?.fromReplay) {
    throw new Error('Expected incident from replayed event to have fromReplay: true');
  }

  // Check device lastSeenAt was NOT advanced and status was NOT set to online
  const deviceAfterReplay = await Device.findOne({ deviceId }).lean();
  const timeDiff = Math.abs(deviceAfterReplay.lastSeenAt.getTime() - oneHourAgo.getTime());
  console.log(`7b. Device lastSeenAt maintained historical time (diff: ${timeDiff}ms), status: ${deviceAfterReplay.status}`);
  if (timeDiff > 1000 || deviceAfterReplay.status === 'online') {
    throw new Error('Device lastSeenAt or status was inappropriately updated by replayed event!');
  }

  // 8. Admin failed events check: GET /v1/admin/failed-events
  const failedEventId = crypto.randomUUID();
  await Event.create({
    eventId: failedEventId,
    deviceId,
    seq: 999,
    type: 'reading',
    timestamp: new Date(),
    receivedAt: new Date(),
    payload: {},
    replayed: false,
    processingStatus: 'failed',
    error: 'Simulated connection failure during execution',
    attempts: 3,
    processedAt: new Date()
  });

  const failedRes = await call('/v1/admin/failed-events', { method: 'GET' });
  console.log('8. Admin failed events count:', failedRes.json?.count);
  const foundFailed = failedRes.json?.failedEvents?.some((e) => e.eventId === failedEventId);
  if (!foundFailed) {
    throw new Error('Expected failed event to be visible in /v1/admin/failed-events');
  }

  await queue.close();
  await redis.quit();
  await mongoose.disconnect();

  console.log('\n======================================================');
  console.log('🎉 ALL PHASE 2 TESTS PASSED WITH 100% SUCCESS!');
  console.log('======================================================\n');
  process.exit(0);
}

runPhase2Tests().catch((err) => {
  console.error('\n❌ Phase 2 Test Failure:', err);
  process.exit(1);
});
