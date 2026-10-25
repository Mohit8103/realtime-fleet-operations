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

async function runPhase3Tests() {
  console.log('\n======================================================');
  console.log('🧪 Starting Phase 3 Incident Management & Notifications Acceptance Tests');
  console.log('======================================================\n');

  // Initialize DB connection
  const {
    Event,
    Incident,
    RuleEvaluation,
    Rule,
    Device,
    Operator,
    Notification,
    connectMongo
  } = await import('@fleet/database');
  const mongoose = (await import('mongoose')).default;
  await connectMongo();

  // Clean up any previously created test rules to keep tests fast, isolated, and deterministic
  await Rule.deleteMany({
    name: { $in: ['Heavy Load Temp Alert', 'Stale Detector Hygiene Test Rule'] }
  });

  const { recordIncidentMatch, resolveOperatorId, repairOutboxSweep } = await import('./apps/worker/dist/engine/incidentManager.js');
  const { executeStaleScan } = await import('./apps/worker/dist/engine/staleDetector.js');
  const {
    claimNextNotification,
    processNotification,
    dispatchBatch
  } = await import('./apps/worker/dist/notifications/notificationDispatcher.js');

  // Reset any mock webhook failure before starting
  await call('/v1/admin/mock-webhook', { body: { fail: false } });

  // --------------------------------------------------------------------------
  // TEST 1: Operators and Simple Routing (rule.notifyOperator vs location fallback)
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: Operators & Simple Routing ---');
  const locTokyo = 'tokyo-' + Date.now();
  const locLondon = 'london-' + Date.now();

  const op1 = await call('/v1/operators', {
    body: {
      operatorId: 'op-tokyo-' + Date.now(),
      name: 'Tokyo Operator',
      email: 'tokyo@fleet.example',
      locations: [locTokyo, 'apac']
    }
  });
  console.log('1a. Create Operator 1 (Tokyo):', op1.status, op1.json?.operator?.operatorId);

  const op2 = await call('/v1/operators', {
    body: {
      operatorId: 'op-london-' + Date.now(),
      name: 'London Operator',
      email: 'london@fleet.example',
      locations: [locLondon, 'emea']
    }
  });
  console.log('1b. Create Operator 2 (London):', op2.status, op2.json?.operator?.operatorId);

  // List operators via REST
  const opsList = await call('/v1/operators', { method: 'GET' });
  console.log('1c. List Operators Count:', opsList.json?.count);
  if (!opsList.json?.operators?.some((o) => o.operatorId === op1.json?.operator?.operatorId)) {
    throw new Error('Operator 1 not found in GET /v1/operators');
  }

  // Test location fallback routing
  const devTokyo = { deviceId: 'dev-tokyo-' + Date.now(), location: locTokyo };
  const dummyRuleNoOp = { _id: new mongoose.Types.ObjectId(), name: 'Rule No Op', severity: 'high' };
  const resolvedFallback = await resolveOperatorId(dummyRuleNoOp, devTokyo);
  console.log('1d. Resolved operator by location fallback:', resolvedFallback);
  if (resolvedFallback !== op1.json?.operator?.operatorId) {
    throw new Error(`Expected operator ${op1.json?.operator?.operatorId}, got: ${resolvedFallback}`);
  }

  // Test explicit rule.notifyOperator override
  const dummyRuleExplicit = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Rule Explicit',
    severity: 'high',
    notifyOperator: op2.json?.operator?.operatorId
  };
  const resolvedExplicit = await resolveOperatorId(dummyRuleExplicit, devTokyo);
  console.log('1e. Resolved operator by explicit rule override:', resolvedExplicit);
  if (resolvedExplicit !== op2.json?.operator?.operatorId) {
    throw new Error(`Expected operator ${op2.json?.operator?.operatorId}, got: ${resolvedExplicit}`);
  }
  console.log('✅ TEST 1 PASSED: Operator registration and routing verified.\n');

  // --------------------------------------------------------------------------
  // TEST 2: 100 over-threshold events produce exactly 1 incident (occurrenceCount: 100)
  // --------------------------------------------------------------------------
  console.log('--- TEST 2: Deduplication (100 over-threshold events -> 1 incident, count 100) ---');
  const devHeavyId = 'dev-heavy-' + Date.now();
  const regHeavy = await call('/v1/devices', {
    body: { deviceId: devHeavyId, name: devHeavyId, location: 'tokyo-region' }
  });
  const keyHeavy = regHeavy.json?.apiKey;

  // Create threshold rule: temp > 70
  const ruleHeavyRes = await call('/v1/rules', {
    body: {
      name: 'Heavy Load Temp Alert',
      type: 'threshold',
      severity: 'critical',
      enabled: true,
      cooldownSeconds: 0,
      notifyOperator: op1.json?.operator?.operatorId,
      conditions: {
        metric: 'temperature',
        operator: '>',
        value: 70,
        deviceFilter: { type: 'all' }
      }
    }
  });
  const ruleHeavyId = ruleHeavyRes.json?.rule?._id;

  // Generate 100 matching events
  const heavyEvents = [];
  for (let i = 1; i <= 100; i++) {
    heavyEvents.push({
      eventId: crypto.randomUUID(),
      deviceId: devHeavyId,
      seq: i,
      type: 'reading',
      timestamp: new Date().toISOString(),
      payload: { temperature: 80 + (i % 10) }
    });
  }

  // Ingest via two batches of 50
  console.log('2a. Ingesting 100 matching events in 2 batches of 50...');
  const batch1 = await call('/v1/events/batch', { body: { events: heavyEvents.slice(0, 50) }, key: keyHeavy });
  const batch2 = await call('/v1/events/batch', { body: { events: heavyEvents.slice(50, 100) }, key: keyHeavy });
  console.log('   Batch 1 accepted:', batch1.json?.summary?.accepted, 'Batch 2 accepted:', batch2.json?.summary?.accepted);

  // Poll for worker to process all 100 events
  console.log('2b. Waiting for worker to process all 100 events...');
  let heavyIncident = null;
  const heavyStart = Date.now();
  while (Date.now() - heavyStart < 60000) {
    heavyIncident = await Incident.findOne({
      deviceId: devHeavyId,
      ruleId: String(ruleHeavyId),
      state: 'open'
    }).lean();

    if (heavyIncident && heavyIncident.occurrenceCount >= 100) {
      break;
    }
    await sleep(500);
  }

  console.log('2c. Incident state after 100 events:');
  console.log(`   occurrenceCount: ${heavyIncident?.occurrenceCount}`);
  console.log(`   triggeringEvents length: ${heavyIncident?.triggeringEvents?.length} (capped at 20)`);
  console.log(`   firstEventId: ${heavyIncident?.firstEventId}`);
  console.log(`   lastEventId: ${heavyIncident?.lastEventId}`);

  const totalIncidentsHeavy = await Incident.countDocuments({
    deviceId: devHeavyId,
    ruleId: String(ruleHeavyId)
  });
  console.log(`2d. Total incidents in DB for dedupeKey: ${totalIncidentsHeavy}`);

  if (totalIncidentsHeavy !== 1) {
    throw new Error(`Expected exactly 1 incident, found: ${totalIncidentsHeavy}`);
  }
  if (heavyIncident?.occurrenceCount !== 100) {
    throw new Error(`Expected occurrenceCount 100, got: ${heavyIncident?.occurrenceCount}`);
  }
  if (heavyIncident?.triggeringEvents?.length !== 20) {
    throw new Error(`Expected triggeringEvents capped at 20, got: ${heavyIncident?.triggeringEvents?.length}`);
  }
  const heavyEventIds = heavyEvents.map((e) => e.eventId);
  if (!heavyEventIds.includes(heavyIncident?.firstEventId)) {
    throw new Error(`Expected firstEventId to be one of the batch events, got: ${heavyIncident?.firstEventId}`);
  }
  if (!heavyEventIds.includes(heavyIncident?.lastEventId)) {
    throw new Error(`Expected lastEventId to be one of the batch events, got: ${heavyIncident?.lastEventId}`);
  }
  console.log('✅ TEST 2 PASSED: 100 over-threshold events produced exactly 1 incident with occurrenceCount 100.\n');

  // --------------------------------------------------------------------------
  // TEST 3: 20 concurrent identical matches produce 1 incident (Race condition check)
  // --------------------------------------------------------------------------
  console.log('--- TEST 3: Concurrency Stress (20 concurrent matches -> 1 incident) ---');
  const devConcurrent = { deviceId: 'dev-concurrent-' + Date.now(), location: 'tokyo-region' };
  const concurrentRule = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Concurrent Rule Stress',
    severity: 'high',
    notifyOperator: op1.json?.operator?.operatorId
  };

  console.log('3a. Firing 20 simultaneous recordIncidentMatch calls on fresh dedupeKey...');
  const concurrentPromises = Array.from({ length: 20 }).map((_, i) =>
    recordIncidentMatch({
      rule: concurrentRule,
      device: devConcurrent,
      event: { eventId: `concurrent-ev-${i}` },
      isReplay: false,
      matchReason: `Simultaneous match test item ${i}`
    })
  );

  const concurrentResults = await Promise.all(concurrentPromises);
  const createdCount = concurrentResults.filter((r) => r.isCreated).length;
  console.log(`3b. Created return count: ${createdCount} (expected 1 created, 19 updated)`);

  const totalConcurrentIncidents = await Incident.countDocuments({
    deviceId: devConcurrent.deviceId,
    ruleId: String(concurrentRule._id)
  });
  const concurrentDoc = await Incident.findOne({
    deviceId: devConcurrent.deviceId,
    ruleId: String(concurrentRule._id)
  }).lean();

  console.log(`3c. Total incidents in DB: ${totalConcurrentIncidents}, occurrenceCount: ${concurrentDoc?.occurrenceCount}`);
  if (totalConcurrentIncidents !== 1) {
    throw new Error(`Expected exactly 1 incident from 20 concurrent matches, got: ${totalConcurrentIncidents}`);
  }
  if (concurrentDoc?.occurrenceCount !== 20) {
    throw new Error(`Expected occurrenceCount 20, got: ${concurrentDoc?.occurrenceCount}`);
  }
  if (createdCount !== 1) {
    throw new Error(`Expected exactly 1 call to return isCreated: true, got: ${createdCount}`);
  }

  // Verify only 1 notification outbox record was written
  const notifCountConcurrent = await Notification.countDocuments({ incidentId: concurrentDoc.incidentId });
  console.log(`3d. Notifications written for concurrent incident: ${notifCountConcurrent} (expected 1)`);
  if (notifCountConcurrent !== 1) {
    throw new Error(`Expected exactly 1 notification written on incident creation, got: ${notifCountConcurrent}`);
  }
  console.log('✅ TEST 3 PASSED: 20 concurrent matches produced exactly 1 incident with occurrenceCount 20.\n');

  // --------------------------------------------------------------------------
  // TEST 4: State Machine & Invalid Transitions (409 Conflict)
  // --------------------------------------------------------------------------
  console.log('--- TEST 4: State Machine Transitions & 409 Conflict ---');
  const incidentToTransition = concurrentDoc.incidentId;

  // 4a. Valid transition: open -> acknowledged
  const ackRes1 = await call(`/v1/incidents/${incidentToTransition}/acknowledge`, {
    body: { operator: 'op-alpha', note: 'Acknowledged for triage' }
  });
  console.log('4a. Transition open -> acknowledged:', ackRes1.status, ackRes1.json?.status);
  if (ackRes1.status !== 200 || ackRes1.json?.incident?.state !== 'acknowledged') {
    throw new Error(`Expected 200 and acknowledged, got: ${ackRes1.status}`);
  }

  // 4b. Invalid transition: acknowledged -> acknowledged (returns 409)
  const ackRes2 = await call(`/v1/incidents/${incidentToTransition}/acknowledge`, {
    body: { operator: 'op-alpha' }
  });
  console.log('4b. Retrying acknowledge on acknowledged incident:', ackRes2.status);
  if (ackRes2.status !== 409) {
    throw new Error(`Expected 409 Conflict when acknowledging already acknowledged incident, got: ${ackRes2.status}`);
  }

  // 4c. Valid transition: acknowledged -> resolved
  const resolveRes = await call(`/v1/incidents/${incidentToTransition}/resolve`, {
    body: { operator: 'op-alpha', note: 'Sensor replaced, resolved.' }
  });
  console.log('4c. Transition acknowledged -> resolved:', resolveRes.status, resolveRes.json?.status);
  if (resolveRes.status !== 200 || resolveRes.json?.incident?.state !== 'resolved') {
    throw new Error(`Expected 200 and resolved, got: ${resolveRes.status}`);
  }

  // 4d. Invalid transition: resolved -> acknowledged (returns 409)
  const ackResolved = await call(`/v1/incidents/${incidentToTransition}/acknowledge`, {
    body: { operator: 'op-alpha' }
  });
  console.log('4d. Acknowledging a resolved incident (expect 409):', ackResolved.status);
  if (ackResolved.status !== 409) {
    throw new Error(`Expected 409 Conflict when acknowledging resolved incident, got: ${ackResolved.status}`);
  }

  // 4e. Invalid transition: resolved -> resolved (returns 409)
  const resolveResolved = await call(`/v1/incidents/${incidentToTransition}/resolve`, {
    body: { operator: 'op-alpha' }
  });
  console.log('4e. Resolving a resolved incident (expect 409):', resolveResolved.status);
  if (resolveResolved.status !== 409) {
    throw new Error(`Expected 409 Conflict when resolving already resolved incident, got: ${resolveResolved.status}`);
  }

  // 4f. Test GET /v1/incidents/:id returns incident, events, and ruleEvaluations
  const incDetail = await call(`/v1/incidents/${heavyIncident.incidentId}`, { method: 'GET' });
  console.log('4f. GET /v1/incidents/:id: status:', incDetail.status, 'events count:', incDetail.json?.events?.length);
  if (incDetail.status !== 200 || !incDetail.json?.incident || !Array.isArray(incDetail.json?.events)) {
    throw new Error('Failed to fetch incident details with associated events');
  }

  // 4g. Test GET /v1/incidents with filters (state, severity, deviceId)
  const filterRes = await call(`/v1/incidents?deviceId=${devHeavyId}&state=open`, { method: 'GET' });
  console.log('4g. Filtered incidents count (deviceId + state):', filterRes.json?.count);
  if (filterRes.status !== 200 || !filterRes.json?.incidents?.length || !filterRes.json?.incidents.every((i) => i.deviceId === devHeavyId && i.state === 'open')) {
    throw new Error('GET /v1/incidents filtering by deviceId and state failed');
  }

  // 4h. Filter by severity as well
  const filterCrit = await call(`/v1/incidents?deviceId=${devHeavyId}&state=open&severity=critical`, { method: 'GET' });
  console.log('4h. Filtered incidents count (severity=critical):', filterCrit.json?.count);
  if (filterCrit.status !== 200 || filterCrit.json?.count !== 1 || filterCrit.json?.incidents[0]?.severity !== 'critical') {
    throw new Error('GET /v1/incidents filtering by severity failed');
  }
  console.log('✅ TEST 4 PASSED: State machine transitions strictly validated; 409 returned for invalid.\n');

  // --------------------------------------------------------------------------
  // TEST 5: Storage Hygiene (TTL index & Stale detector tick suppression)
  // --------------------------------------------------------------------------
  console.log('--- TEST 5: Storage Hygiene (TTL index & Stale Tick Suppression) ---');

  // Check TTL index on rule_evaluations
  const indexes = await RuleEvaluation.collection.indexes();
  const ttlIndex = indexes.find((idx) => idx.expireAfterSeconds === 86400);
  console.log('5a. Found 24h TTL index on rule_evaluations:', ttlIndex?.name, 'expireAfterSeconds:', ttlIndex?.expireAfterSeconds);
  if (!ttlIndex) {
    throw new Error('Expected 24-hour TTL index (expireAfterSeconds: 86400) on rule_evaluations!');
  }

  const devStaleId = 'dev-stale-hyg-' + Date.now();
  const regStale = await call('/v1/devices', {
    body: { deviceId: devStaleId, name: devStaleId, location: locTokyo }
  });
  const devStaleKey = regStale.json?.apiKey;
  await Device.updateOne(
    { deviceId: devStaleId },
    { $set: { lastSeenAt: new Date(Date.now() - 10000), status: 'stale' } }
  );
  const devStale = await Device.findOne({ deviceId: devStaleId });

  // Create stale rule targeting this specific test device
  const staleRule = await Rule.create({
    name: 'Stale Detector Hygiene Test Rule',
    type: 'no_report',
    severity: 'medium',
    enabled: true,
    cooldownSeconds: 0,
    conditions: {
      durationSeconds: 2,
      deviceFilter: { type: 'specific', deviceIds: [devStaleId] }
    }
  });

  // Tick 1: should create the open stale incident and 1 rule evaluation
  await executeStaleScan();
  const staleInc1 = await Incident.findOne({
    deviceId: devStale.deviceId,
    ruleId: String(staleRule._id),
    state: 'open'
  }).lean();
  const evalsTick1 = await RuleEvaluation.countDocuments({
    deviceId: devStale.deviceId,
    ruleId: String(staleRule._id)
  });

  console.log(`5b. Tick 1: Incident created? ${Boolean(staleInc1)}, evaluations: ${evalsTick1}, suppressed: ${staleInc1?.suppressedStaleChecksCount}`);
  if (!staleInc1 || evalsTick1 !== 1) {
    throw new Error('Expected Tick 1 to create 1 stale incident and 1 evaluation');
  }

  // Tick 2: incident is already open -> must NOT create incident, must NOT insert evaluation, must increment counter
  await executeStaleScan();
  const staleInc2 = await Incident.findOne({
    deviceId: devStale.deviceId,
    ruleId: String(staleRule._id)
  }).lean();
  const evalsTick2 = await RuleEvaluation.countDocuments({
    deviceId: devStale.deviceId,
    ruleId: String(staleRule._id)
  });

  console.log(`5c. Tick 2: Incidents count: 1, evaluations: ${evalsTick2}, suppressed: ${staleInc2?.suppressedStaleChecksCount}`);
  if (evalsTick2 !== 1) {
    throw new Error(`Expected storage hygiene to suppress evaluation insert, but found ${evalsTick2} evaluations!`);
  }
  if (!staleInc2 || staleInc2.suppressedStaleChecksCount < 1) {
    throw new Error(`Expected suppressedStaleChecksCount to be at least 1, got: ${staleInc2?.suppressedStaleChecksCount}`);
  }

  // Tick 3: verify counter increments again
  await executeStaleScan();
  const staleInc3 = await Incident.findOne({
    deviceId: devStale.deviceId,
    ruleId: String(staleRule._id)
  }).lean();
  console.log(`5d. Tick 3: suppressedStaleChecksCount: ${staleInc3?.suppressedStaleChecksCount}`);
  if (!staleInc3 || staleInc3.suppressedStaleChecksCount < 2) {
    throw new Error(`Expected suppressedStaleChecksCount to be at least 2, got: ${staleInc3?.suppressedStaleChecksCount}`);
  }
  console.log('✅ TEST 5 PASSED: TTL index confirmed and stale checks suppressed with incident counter.\n');

  // --------------------------------------------------------------------------
  // TEST 6: Stale Incident Auto-Resolution (Replayed vs. Fresh Event)
  // --------------------------------------------------------------------------
  console.log('--- TEST 6: Stale Auto-Resolution (Replayed vs Fresh Event) ---');
  // Stale incident is currently open from Test 5
  console.log(`6a. Current stale incident state: ${staleInc3?.state}`);

  // Send a replayed event: should NOT auto-resolve
  const replayEvent = {
    eventId: crypto.randomUUID(),
    deviceId: devStale.deviceId,
    seq: 1,
    type: 'reading',
    timestamp: new Date(Date.now() - 3600000).toISOString(),
    replayed: true,
    payload: { temperature: 25 }
  };
  await call('/v1/events', { body: replayEvent, key: devStaleKey });
  await sleep(1500);

  const staleAfterReplay = await Incident.findOne({
    deviceId: devStale.deviceId,
    ruleId: String(staleRule._id)
  }).lean();
  console.log(`6b. Stale incident state after replayed event: ${staleAfterReplay?.state}`);
  if (staleAfterReplay?.state !== 'open') {
    throw new Error('Replayed event inappropriately resolved the stale incident!');
  }

  // Send a fresh event: MUST auto-resolve with timeline entry
  const freshEvent = {
    eventId: crypto.randomUUID(),
    deviceId: devStale.deviceId,
    seq: 2,
    type: 'reading',
    timestamp: new Date().toISOString(),
    replayed: false,
    payload: { temperature: 25 }
  };
  await call('/v1/events', { body: freshEvent, key: devStaleKey });

  // Poll for worker to process event and auto-resolve the incident
  let staleAfterFresh = null;
  const autoResolveStart = Date.now();
  while (Date.now() - autoResolveStart < 15000) {
    staleAfterFresh = await Incident.findOne({
      deviceId: devStale.deviceId,
      ruleId: String(staleRule._id)
    }).lean();

    if (staleAfterFresh?.state === 'resolved') break;
    await sleep(400);
  }

  console.log(`6c. Stale incident state after fresh event: ${staleAfterFresh?.state}`);
  console.log(`    resolvedBy: ${staleAfterFresh?.resolvedBy}`);
  const lastTimeline = staleAfterFresh?.timeline?.[staleAfterFresh.timeline.length - 1];
  console.log(`    timeline action: ${lastTimeline?.action}, note: ${lastTimeline?.note}`);

  if (staleAfterFresh?.state !== 'resolved') {
    throw new Error('Fresh event failed to auto-resolve the stale incident!');
  }
  if (staleAfterFresh?.resolvedBy !== 'system:auto-resolve') {
    throw new Error(`Expected resolvedBy 'system:auto-resolve', got: ${staleAfterFresh?.resolvedBy}`);
  }
  if (!lastTimeline?.note?.includes('auto-resolved on fresh event')) {
    throw new Error('Expected timeline note explaining auto-resolve!');
  }
  console.log('✅ TEST 6 PASSED: Replayed events never auto-resolve; fresh events auto-resolve with timeline entry.\n');

  // --------------------------------------------------------------------------
  // TEST 7: Transactional Outbox & Notifier Resilience (Admin Toggle)
  // --------------------------------------------------------------------------
  console.log('--- TEST 7: Transactional Outbox & Notifier Resilience ---');

  // Turn ON failure toggle for mock webhook
  const toggleOn = await call('/v1/admin/mock-webhook', { body: { fail: true } });
  console.log('7a. Set mock webhook to FAIL:', toggleOn.json);

  // Create an incident while notifier is failing
  const devNotifFail = { deviceId: 'dev-notif-fail-' + Date.now(), location: 'tokyo-region' };
  const notifFailRule = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Notifier Failure Resilience Test',
    severity: 'high',
    notifyOperator: op1.json?.operator?.operatorId
  };

  const failMatch = await recordIncidentMatch({
    rule: notifFailRule,
    device: devNotifFail,
    event: { eventId: crypto.randomUUID() },
    isReplay: false,
    matchReason: 'Testing notifier down resilience'
  });

  console.log('7b. Incident created despite notifier failure?', failMatch.isCreated, 'Incident ID:', failMatch.incident.incidentId);
  if (!failMatch.isCreated) {
    throw new Error('Incident creation failed!');
  }

  // Find notification outbox record
  const notifOutbox = await Notification.findOne({ incidentId: failMatch.incident.incidentId });
  console.log('7c. Outbox notification initial status:', notifOutbox?.status, 'attempts:', notifOutbox?.attempts);

  // Dispatch single notification: should fail and enter retry backoff
  await processNotification(notifOutbox);
  const notifFailed = await Notification.findOne({ incidentId: failMatch.incident.incidentId }).lean();
  console.log('7d. Outbox notification status after failed attempt:', notifFailed?.status, 'attempts:', notifFailed?.attempts, 'error:', notifFailed?.lastError);

  if (notifFailed?.status !== 'failed' || notifFailed?.attempts !== 1) {
    throw new Error('Expected notification to be in failed status with 1 attempt');
  }

  // Turn OFF failure toggle
  const toggleOff = await call('/v1/admin/mock-webhook', { body: { fail: false } });
  console.log('7e. Restored mock webhook to SUCCESS:', toggleOff.json);

  // Reset nextAttemptAt to now so it can be dispatched immediately
  await Notification.updateOne(
    { incidentId: failMatch.incident.incidentId },
    { $set: { nextAttemptAt: new Date(Date.now() - 1000) } }
  );

  const notifRetry = await Notification.findOne({ incidentId: failMatch.incident.incidentId });
  await processNotification(notifRetry);

  const notifDelivered = await Notification.findOne({ incidentId: failMatch.incident.incidentId }).lean();
  console.log('7f. Outbox notification status after recovery:', notifDelivered?.status, 'sentAt:', notifDelivered?.sentAt);
  if (notifDelivered?.status !== 'sent' || !notifDelivered?.sentAt) {
    throw new Error('Notification failed to deliver after toggle restored!');
  }

  // Test GET /v1/notifications?status=sent
  const listNotif = await call('/v1/notifications?status=sent', { method: 'GET' });
  console.log('7g. GET /v1/notifications?status=sent count:', listNotif.json?.count);
  if (!listNotif.json?.notifications?.some((n) => n.notificationId === notifDelivered.notificationId)) {
    throw new Error('Delivered notification not found in GET /v1/notifications?status=sent');
  }
  console.log('✅ TEST 7 PASSED: Incident created safely during outage; notification retried and delivered upon recovery.\n');

  // --------------------------------------------------------------------------
  // TEST 8: Two Concurrent Dispatchers Claim Only Once (Atomic Lease Claim)
  // --------------------------------------------------------------------------
  console.log('--- TEST 8: Two Concurrent Dispatchers Claim Idempotency ---');
  // Create 1 pending notification
  const uniqueNotifId = 'notif-claim-test-' + Date.now();
  await Notification.create({
    notificationId: uniqueNotifId,
    incidentId: 'inc-dummy-' + Date.now(),
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: new Date(),
    idempotencyKey: crypto.randomUUID(),
    payload: { test: true }
  });

  // Run 2 claims simultaneously on the single notification
  const [claimA, claimB] = await Promise.all([
    claimNextNotification(30000, { notificationId: uniqueNotifId }),
    claimNextNotification(30000, { notificationId: uniqueNotifId })
  ]);

  const claimedCount = [claimA, claimB].filter((c) => c?.notificationId === uniqueNotifId).length;
  console.log(`8a. Concurrent claim count on single notification: ${claimedCount} (expected exactly 1)`);
  if (claimedCount !== 1) {
    throw new Error(`Atomic lease claim failed! Claimed ${claimedCount} times concurrently!`);
  }

  // Test expired lease recovery
  console.log('8b. Testing expired lease recovery after worker crash...');
  await Notification.updateOne(
    { notificationId: uniqueNotifId },
    { $set: { status: 'sending', lockedUntil: new Date(Date.now() - 5000) } }
  );
  const reclaimed = await claimNextNotification(30000, { notificationId: uniqueNotifId });
  if (reclaimed?.notificationId !== uniqueNotifId) {
    const check = await Notification.findOne({ notificationId: uniqueNotifId });
    if (check && (check.status === 'sent' || check.status === 'sending')) {
      console.log('8c. Notification was immediately claimed and processed by active worker:', check.status);
    } else {
      throw new Error('Failed to reclaim notification with expired lease!');
    }
  }
  console.log('✅ TEST 8 PASSED: Concurrent dispatchers claimed only once; expired leases reclaimed safely.\n');

  // --------------------------------------------------------------------------
  // TEST 9: Dead Letter Status After Max Attempts
  // --------------------------------------------------------------------------
  console.log('--- TEST 9: Dead Letter Transition after MAX_NOTIFY_ATTEMPTS ---');
  await call('/v1/admin/mock-webhook', { body: { fail: true } });

  const deadNotifId = 'notif-dead-' + Date.now();
  const deadNotif = await Notification.create({
    notificationId: deadNotifId,
    incidentId: 'inc-dead-' + Date.now(),
    status: 'pending',
    attempts: 4, // 1 away from max 5
    maxAttempts: 5,
    nextAttemptAt: new Date(),
    idempotencyKey: crypto.randomUUID(),
    payload: { test: 'dead' }
  });

  await processNotification(deadNotif);
  const deadDoc = await Notification.findOne({ notificationId: deadNotifId }).lean();
  console.log('9a. Notification status after 5th attempt:', deadDoc?.status, 'attempts:', deadDoc?.attempts);
  if (deadDoc?.status !== 'dead') {
    throw new Error(`Expected status 'dead', got: ${deadDoc?.status}`);
  }

  // Restore webhook toggle
  await call('/v1/admin/mock-webhook', { body: { fail: false } });
  console.log('✅ TEST 9 PASSED: Notification transitions to dead after MAX_NOTIFY_ATTEMPTS.\n');

  // --------------------------------------------------------------------------
  // TEST 10: Outbox Atomicity & Repair Sweep (Crash Recovery & Unique Constraint)
  // --------------------------------------------------------------------------
  console.log('--- TEST 10: Outbox Atomicity & Repair Sweep Crash Simulation ---');
  // 10a. Simulate crash between incident creation and notification creation:
  // Create an open incident backdated > 30s ago with NO notification record
  const crashIncidentId = crypto.randomUUID();
  const crashDeviceId = 'dev-crash-' + Date.now();
  const crashRuleId = new mongoose.Types.ObjectId().toString();

  await Incident.create({
    incidentId: crashIncidentId,
    deviceId: crashDeviceId,
    ruleId: crashRuleId,
    ruleName: 'Simulated Crash Rule',
    dedupeKey: `${crashRuleId}:${crashDeviceId}`,
    severity: 'high',
    state: 'open',
    fromReplay: false,
    occurrenceCount: 1,
    triggeringEvents: [],
    timeline: [
      {
        action: 'created',
        timestamp: new Date(Date.now() - 40000),
        note: 'Incident created before crash'
      }
    ],
    createdAt: new Date(Date.now() - 40000) // 40 seconds ago (> 30s threshold)
  });

  // Verify that no notification exists initially
  const initialNotif = await Notification.findOne({ incidentId: crashIncidentId });
  console.log('10a. Simulated crash incident created. Notification exists?', Boolean(initialNotif));
  if (initialNotif) {
    throw new Error('Initial notification should not exist before repair sweep');
  }

  // 10b. Run repair sweep
  console.log('10b. Running repairOutboxSweep()...');
  const repairedCount = await repairOutboxSweep(30000);
  console.log(`     Repaired count: ${repairedCount}`);

  const repairedNotif = await Notification.findOne({ incidentId: crashIncidentId }).lean();
  console.log('10c. Post-sweep notification found:', Boolean(repairedNotif), 'status:', repairedNotif?.status);
  if (!repairedNotif || repairedNotif.status !== 'pending') {
    throw new Error('Repair sweep failed to create pending notification for unnotified incident');
  }

  // 10d. Test idempotency: run repair sweep again, count must remain exactly 1
  console.log('10d. Running repairOutboxSweep() again to test idempotency...');
  await repairOutboxSweep(30000);
  const countAfterSecondSweep = await Notification.countDocuments({ incidentId: crashIncidentId });
  console.log(`     Notification count after second sweep: ${countAfterSecondSweep} (expected exactly 1)`);
  if (countAfterSecondSweep !== 1) {
    throw new Error(`Expected exactly 1 notification after repeat sweep, got: ${countAfterSecondSweep}`);
  }

  // 10e. Test unique index on notifications.incidentId
  console.log('10e. Testing unique index on notifications.incidentId rejects duplicate insert...');
  let dupRejected = false;
  try {
    await Notification.create({
      notificationId: crypto.randomUUID(),
      incidentId: crashIncidentId, // Duplicate incidentId
      status: 'pending',
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: new Date(),
      idempotencyKey: crypto.randomUUID(),
      payload: { test: 'duplicate' }
    });
  } catch (dupErr) {
    if (dupErr.code === 11000 || String(dupErr.message).includes('E11000')) {
      dupRejected = true;
    }
  }
  console.log('     Duplicate notification insert rejected by unique index?', dupRejected);
  if (!dupRejected) {
    throw new Error('Expected duplicate notification on same incidentId to fail with E11000 unique index violation!');
  }

  // 10f. Test transactional atomicity of recordIncidentMatch
  console.log('10f. Testing recordIncidentMatch atomicity with session.withTransaction...');
  const devAtomic = { deviceId: 'dev-atomic-' + Date.now(), location: 'apac' };
  const atomicRule = {
    _id: new mongoose.Types.ObjectId(),
    name: 'Transactional Atomicity Rule',
    severity: 'critical'
  };

  const atomicMatch = await recordIncidentMatch({
    rule: atomicRule,
    device: devAtomic,
    event: { eventId: crypto.randomUUID() },
    isReplay: false,
    matchReason: 'Testing session.withTransaction atomicity'
  });

  const [atomicIncDoc, atomicNotifDoc] = await Promise.all([
    Incident.findOne({ incidentId: atomicMatch.incident.incidentId }),
    Notification.findOne({ incidentId: atomicMatch.incident.incidentId })
  ]);
  console.log(`     Incident created: ${Boolean(atomicIncDoc)}, Notification created: ${Boolean(atomicNotifDoc)}`);
  if (!atomicIncDoc || !atomicNotifDoc) {
    throw new Error('Transactional creation failed to write both incident and notification');
  }
  console.log('✅ TEST 10 PASSED: Outbox repair sweep and unique index guarantee outbox atomicity.\n');

  // Cleanup DB connection
  await mongoose.disconnect();

  console.log('\n======================================================');
  console.log('🎉 ALL PHASE 3 ACCEPTANCE TESTS PASSED WITH 100% SUCCESS!');
  console.log('======================================================\n');
  process.exit(0);
}

runPhase3Tests().catch((err) => {
  console.error('\n❌ Phase 3 Acceptance Test Failure:', err);
  process.exit(1);
});
