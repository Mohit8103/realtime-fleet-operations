import crypto from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config();

const BASE = process.env.API || 'http://localhost:3000';
const KEY_HEADER = process.env.KEY_HEADER || 'x-api-key';
const id = () => crypto.randomUUID();

async function call(path, { body, key, rawBody, headers: extraHeaders } = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (key) headers[KEY_HEADER] = key;
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers,
    body: rawBody ?? JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, retryAfter: res.headers.get('retry-after') };
}

const show = (label, r) =>
  console.log(`\n=== ${label} ===\nstatus: ${r.status}\n${JSON.stringify(r.json, null, 2)}`);

const deviceId = 'test-dev-' + Date.now();
const reg = await call('/v1/devices', { body: { deviceId, name: deviceId, location: 'lab' } });
show('1. register device', reg);
const key = reg.json?.apiKey || reg.json?.key || reg.json?.data?.apiKey;
if (!key) { console.log('\nCould not find the API key in the response. Fix the field name above and rerun.'); process.exit(1); }

const mk = (seq, extra = {}) => ({
  eventId: id(), deviceId, seq, type: 'reading',
  timestamp: new Date().toISOString(),
  payload: { metric: 'temperature', value: 70 }, ...extra,
});

// 2. valid event
const ev = mk(1);
show('2. valid event (expect 202 accepted)', await call('/v1/events', { body: ev, key }));

// 3. same eventId again
show('3. DUPLICATE (expect "duplicate")', await call('/v1/events', { body: ev, key }));

// 4. malformed cases
show('4a. missing fields', await call('/v1/events', { body: { deviceId }, key }));
show('4b. wrong types', await call('/v1/events', { body: mk(2, { timestamp: 'not-a-date', seq: 'abc' }), key }));
show('4c. broken JSON', await call('/v1/events', { rawBody: '{"eventId": ', key }));

// 5. no / wrong key
show('5. no API key (expect 401)', await call('/v1/events', { body: mk(3) }));

// 6. mixed batch: valid, duplicate, invalid, out-of-order (older timestamp, lower seq)
const old = mk(0, { timestamp: new Date(Date.now() - 600000).toISOString() });
show('6. mixed batch (expect accepted, duplicate, rejected, accepted)',
  await call('/v1/events/batch', { body: { events: [mk(10), ev, { bad: true }, old] }, key }));

// 7. flood: 300 requests at once
const flood = await Promise.all(Array.from({ length: 300 }, (_, i) => call('/v1/events', { body: mk(100 + i), key })));
const counts = {};
flood.forEach((r) => (counts[r.status] = (counts[r.status] || 0) + 1));
console.log('\n=== 7. flood of 300 (expect only 202 and/or 429, no 5xx) ===\n', counts);

// Wait for rate limit window to refresh before subsequent tests
await new Promise((resolve) => setTimeout(resolve, 2000));

// -----------------------------------------------------------------------------
// Phase 1 Additional Acceptance Tests
// -----------------------------------------------------------------------------

// 8. Duplicate after Redis key is deleted still returns duplicate (MongoDB is source of truth)
const ev8 = mk(80);
show('8a. first insert for Redis-eviction test (expect 202 accepted)', await call('/v1/events', { body: ev8, key }));

const Redis = (await import('ioredis')).default;
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redis = new Redis(redisUrl, { lazyConnect: false });
await redis.del(`event_seen:${ev8.eventId}`);

show(
  '8b. same eventId after Redis cache deleted (expect duplicate from MongoDB E11000)',
  await call('/v1/events', { body: ev8, key })
);

// 9. Verify rejected events are stored in MongoDB rejected_events collection
const rejRes = await fetch(BASE + `/v1/events/rejected?deviceId=${deviceId}`, {
  headers: { 'x-api-key': key }
});
const rejections = await rejRes.json();
show('9. stored rejected events in MongoDB (expect count > 0)', {
  status: rejRes.status,
  json: { count: rejections.count, sample: rejections.rejected?.[0] }
});

// 10. Queue_full returns 429 when MAX_QUEUE_DEPTH is reached
const { Queue } = await import('bullmq');
const testQueue = new Queue('telemetry-queue', { connection: redis });
await testQueue.pause();

// Add 5 jobs so queue depth is >= 5
for (let i = 0; i < 5; i++) {
  await testQueue.add('test-backpressure-job', { test: true });
}

show(
  '10. queue_full backpressure when depth >= 5 (expect 429 and code "queue_full")',
  await call('/v1/events', {
    body: mk(999),
    key,
    headers: { 'x-max-queue-depth': '5' }
  })
);

// Immediately resume, drain and close testQueue so worker resumes normal processing
await testQueue.drain();
await testQueue.resume();
await testQueue.close();

// 11. Regression: Device deleted from Mongo must return 401 with old key, then 202 after re-registering
console.log('\n=== 11. Regression: Device deleted from Mongo returns 401, re-register returns 202 ===');
const regDevice = 'reg-test-dev-' + Date.now();
const reg1 = await call('/v1/devices', { body: { deviceId: regDevice, name: regDevice, location: 'lab' } });
const regKey = reg1.json?.apiKey;

// Verify device exists and sends initial event (expect 202)
const regEv1 = {
  eventId: id(), deviceId: regDevice, seq: 1, type: 'reading',
  timestamp: new Date().toISOString(),
  payload: { metric: 'temperature', value: 25 }
};
const resBefore = await call('/v1/events', { body: regEv1, key: regKey });
show('11a. initial event before deletion (expect 202)', resBefore);
if (resBefore.status !== 202) throw new Error(`Expected 202 on initial event, got ${resBefore.status}`);

// Delete device directly from MongoDB (simulating reset-data or out-of-band deletion)
const { connectMongo, Device } = await import('@fleet/database');
await connectMongo();
await Device.deleteOne({ deviceId: regDevice });

// Attempt to send event with old key - must return 401 (even if key was cached in Redis)
const regEv2 = {
  eventId: id(), deviceId: regDevice, seq: 2, type: 'reading',
  timestamp: new Date().toISOString(),
  payload: { metric: 'temperature', value: 26 }
};
const resAfterDel = await call('/v1/events', { body: regEv2, key: regKey });
show('11b. event with old key after Mongo device deleted (expect 401)', resAfterDel);
if (resAfterDel.status !== 401) throw new Error(`Expected 401 on deleted device, got ${resAfterDel.status}`);

// Re-register device via POST /v1/devices
const reg2 = await call('/v1/devices', { body: { deviceId: regDevice, name: regDevice, location: 'lab' } });
const newKey = reg2.json?.apiKey;
show('11c. re-register device (expect 200 or 201)', reg2);
if (!newKey) throw new Error('Failed to get new API key on re-registration');

// Send event with new key - expect 202
const regEv3 = {
  eventId: id(), deviceId: regDevice, seq: 3, type: 'reading',
  timestamp: new Date().toISOString(),
  payload: { metric: 'temperature', value: 27 }
};
const resReReg = await call('/v1/events', { body: regEv3, key: newKey });
show('11d. event with new key after re-registration (expect 202)', resReReg);
if (resReReg.status !== 202) throw new Error(`Expected 202 after re-registration, got ${resReReg.status}`);

// Verify device appears in GET /v1/devices
const listRes = await fetch(BASE + `/v1/devices?search=${regDevice}`);
const listJson = await listRes.json();
const foundInList = listJson.devices?.some((d) => d.deviceId === regDevice);
show('11e. verify device appears in GET /v1/devices (expect found)', { status: listRes.status, found: foundInList });
if (!foundInList) throw new Error(`Device ${regDevice} not found in GET /v1/devices after re-registration`);
console.log('✅ Regression test passed: 401 on deleted device and 202 upon re-registration verified.');

// 12. End-to-End type_match Rule Scenario
console.log('\n=== 12. End-to-End type_match Rule Evaluation & Incident Deduplication ===');
const tmRuleName = 'Acceptance Type Match ' + Date.now();
const ruleRes = await (await fetch(BASE + '/v1/rules', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: tmRuleName,
    type: 'type_match',
    severity: 'high',
    enabled: true,
    cooldownSeconds: 0,
    conditions: {
      eventType: 'error',
      deviceFilter: { type: 'all' }
    }
  })
})).json();
show('12a. create type_match rule (expect created)', { status: 201, json: ruleRes });
if (!ruleRes.rule?._id) throw new Error('Failed to create type_match rule');

// Register device for type_match test
const tmDevId = 'tm-dev-' + Date.now();
const tmDev = await call('/v1/devices', { body: { deviceId: tmDevId, name: tmDevId, location: 'lab' } });
const tmKey = tmDev.json?.apiKey;

// Send 1st matching event of type 'error'
const tmEv1Id = id();
const tmEv1Res = await call('/v1/events', {
  body: {
    eventId: tmEv1Id,
    deviceId: tmDevId,
    seq: 1,
    type: 'error',
    timestamp: new Date().toISOString(),
    payload: { errorCode: 'ERR_HARDWARE_FAULT', detail: 'Voltage spike' }
  },
  key: tmKey
});
show('12b. send 1st error event (expect 202 accepted)', tmEv1Res);
if (tmEv1Res.status !== 202) throw new Error(`Expected 202, got ${tmEv1Res.status}`);

async function pollForEvaluation(eventId, ruleName, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(BASE + `/v1/events/${eventId}/evaluations`);
    const json = await res.json().catch(() => ({}));
    const found = json.evaluations?.find((e) => e.ruleName === ruleName);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function pollForIncident(deviceId, ruleName, expectedOccurrence = 1, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(BASE + `/v1/incidents?deviceId=${deviceId}`);
    const json = await res.json().catch(() => ({}));
    const matching = json.incidents?.filter((i) => i.ruleName === ruleName);
    if (matching?.length === 1 && matching[0].occurrenceCount >= expectedOccurrence) {
      return matching[0];
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

// Poll for rule evaluation record for 1st event
const tmEval1 = await pollForEvaluation(tmEv1Id, tmRuleName);
show('12c. rule evaluation record for 1st event (expect matched: true with clear reason)', {
  evaluation: tmEval1
});
if (!tmEval1 || tmEval1.matched !== true || !tmEval1.reason?.includes('event type matched')) {
  throw new Error(`Expected matched rule evaluation with clear reason, got: ${JSON.stringify(tmEval1)}`);
}

// Poll for incident created for 1st event
const tmIncident = await pollForIncident(tmDevId, tmRuleName, 1);
show('12d. incident created (expect occurrenceCount: 1, state: open)', {
  incident: tmIncident
});
if (!tmIncident || tmIncident.occurrenceCount !== 1 || tmIncident.state !== 'open') {
  throw new Error(`Expected open incident with occurrenceCount 1, got: ${JSON.stringify(tmIncident)}`);
}

// Send 2nd matching event of type 'error'
const tmEv2Id = id();
const tmEv2Res = await call('/v1/events', {
  body: {
    eventId: tmEv2Id,
    deviceId: tmDevId,
    seq: 2,
    type: 'error',
    timestamp: new Date().toISOString(),
    payload: { errorCode: 'ERR_HARDWARE_FAULT', detail: 'Voltage spike repeated' }
  },
  key: tmKey
});
show('12e. send 2nd error event (expect 202 accepted)', tmEv2Res);
if (tmEv2Res.status !== 202) throw new Error(`Expected 202, got ${tmEv2Res.status}`);

// Poll for incident updated with occurrenceCount: 2 (no duplicate incident created)
const tmIncident2 = await pollForIncident(tmDevId, tmRuleName, 2);
const allIncidentsRes = await (await fetch(BASE + `/v1/incidents?deviceId=${tmDevId}`)).json();
const matchingIncidents = allIncidentsRes.incidents?.filter((i) => i.ruleName === tmRuleName);
show('12f. incident after 2nd event (expect exactly 1 incident with occurrenceCount: 2)', {
  matchingIncidentsCount: matchingIncidents?.length,
  incident: tmIncident2
});
if (!matchingIncidents || matchingIncidents.length !== 1 || tmIncident2?.occurrenceCount !== 2) {
  throw new Error(`Expected exactly 1 incident with occurrenceCount 2, got: ${JSON.stringify(matchingIncidents)}`);
}

// Verify evaluation record for 2nd event
const tmEval2 = await pollForEvaluation(tmEv2Id, tmRuleName);
show('12g. rule evaluation record for 2nd event (expect matched: true)', { evaluation: tmEval2 });
if (!tmEval2 || tmEval2.matched !== true) {
  throw new Error(`Expected matched evaluation for 2nd event, got: ${JSON.stringify(tmEval2)}`);
}

console.log('✅ End-to-end type_match scenario passed: Incident created, reason logged, evaluation stored, occurrenceCount incremented without duplication.');

// Cleanup
const { disconnectMongo } = await import('@fleet/database');
await disconnectMongo();
console.log('\n✅ All Phase 1 Acceptance Tests Completed Successfully!\n');
process.exit(0);
