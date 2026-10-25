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

// Cleanup
await testQueue.drain();
await testQueue.resume();
await testQueue.close();
await redis.quit();
console.log('\n✅ All Phase 1 Acceptance Tests Completed Successfully!\n');
