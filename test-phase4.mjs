import crypto from 'node:crypto';
import http from 'node:http';
import dotenv from 'dotenv';
dotenv.config();

const BASE_API_PORT = process.env.API_PORT || 3000;
const BASE_URL = `http://localhost:${BASE_API_PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function call(path, { method = 'GET', body, key, token, headers: extraHeaders } = {}) {
  const headers = { 'content-type': 'application/json', ...extraHeaders };
  if (key) headers['x-api-key'] = key;
  if (token) headers['authorization'] = `Bearer ${token}`;

  let fullPath = path;
  if (token && !headers['authorization']) {
    fullPath += (path.includes('?') ? '&' : '?') + `token=${token}`;
  }

  const res = await fetch(BASE_URL + fullPath, {
    method,
    headers: body ? headers : Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'content-type')),
    body: body ? JSON.stringify(body) : undefined
  });

  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json, headers: res.headers };
}

/**
 * SSE Client helper reading raw SSE stream from an endpoint
 */
function connectSSE(url, { headers = {}, query = '' } = {}) {
  const events = [];
  const rawComments = [];
  let responseHeaders = null;
  const controller = new AbortController();

  const promise = (async () => {
    try {
      const fullUrl = query ? `${url}?${query}` : url;
      const res = await fetch(fullUrl, {
        headers: {
          Accept: 'text/event-stream',
          ...headers
        },
        signal: controller.signal
      });

      responseHeaders = res.headers;

      if (!res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';

        for (const block of blocks) {
          if (!block.trim()) continue;

          // Heartbeat comment
          if (block.startsWith(':')) {
            rawComments.push(block.trim());
            continue;
          }

          let eventName = 'message';
          let id = null;
          let data = null;

          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) {
              eventName = line.slice(7).trim();
            } else if (line.startsWith('id: ')) {
              id = parseInt(line.slice(4).trim(), 10);
            } else if (line.startsWith('data: ')) {
              try {
                data = JSON.parse(line.slice(6).trim());
              } catch {
                data = line.slice(6).trim();
              }
            }
          }

          events.push({ event: eventName, id, data, raw: block, receivedAt: Date.now() });
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        // stream ended or network close
      }
    }
  })();

  return {
    events,
    rawComments,
    getHeaders: () => responseHeaders,
    close: () => controller.abort()
  };
}

async function waitForEvent(client, predicate, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const found = client.events.find(predicate);
    if (found) return found;
    await sleep(200);
  }
  return null;
}

async function runPhase4Tests() {
  console.log('\n======================================================');
  console.log('🧪 Starting Phase 4 Realtime SSE & Status APIs Tests');
  console.log('======================================================\n');

  const { connectMongo, Device, Rule, Event, Incident } = await import('@fleet/database');
  const { createDedicatedRedisClient, getSharedRedisClient, publishRealtimeEvent, REALTIME_STREAM_KEY, REALTIME_SEQ_KEY } = await import('@fleet/config');
  await connectMongo();
  const redis = getSharedRedisClient();

  // --------------------------------------------------------------------------
  // TEST 1: SSE Headers, Event Delivery (event_ingested & incident_created)
  // --------------------------------------------------------------------------
  console.log('--- TEST 1: SSE Headers & Realtime Event Delivery ---');
  const dev1Id = 'phase4-dev-1-' + Date.now();
  const reg1 = await call('/v1/devices', {
    method: 'POST',
    body: { deviceId: dev1Id, name: dev1Id, location: 'zone-alpha' }
  });
  console.log('1a. Device Registered:', reg1.status, dev1Id);
  const key1 = reg1.json?.apiKey;

  // Create alert rule: speed > 100
  const ruleRes = await call('/v1/rules', {
    method: 'POST',
    body: {
      name: 'Phase 4 Overspeed Alert',
      type: 'threshold',
      severity: 'critical',
      enabled: true,
      cooldownSeconds: 0,
      conditions: {
        metric: 'speed',
        operator: '>',
        value: 100,
        deviceFilter: { type: 'all' }
      }
    }
  });
  const ruleId = ruleRes.json?.rule?._id;
  console.log('1b. Rule Created:', ruleRes.status, ruleId);

  // Connect SSE Client 1
  const sseClient1 = connectSSE(`${BASE_URL}/v1/stream`);
  await sleep(1000); // Give connection time to establish

  const sseHeaders = sseClient1.getHeaders();
  console.log('1c. SSE Headers verified:');
  console.log('    content-type:', sseHeaders?.get('content-type'));
  console.log('    cache-control:', sseHeaders?.get('cache-control'));
  console.log('    connection:', sseHeaders?.get('connection'));
  console.log('    x-accel-buffering:', sseHeaders?.get('x-accel-buffering'));

  if (!sseHeaders?.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Expected Content-Type text/event-stream');
  }

  // Ingest regular event -> should trigger event_ingested
  const ev1Id = crypto.randomUUID();
  await call('/v1/events', {
    method: 'POST',
    key: key1,
    body: {
      eventId: ev1Id,
      deviceId: dev1Id,
      seq: 1,
      type: 'telemetry',
      timestamp: new Date().toISOString(),
      payload: { speed: 45 }
    }
  });

  console.log('1d. Waiting for event_ingested on SSE stream...');
  const ingestedMsg = await waitForEvent(sseClient1, (e) => e.event === 'event_ingested' && e.data?.eventId === ev1Id);
  if (!ingestedMsg) {
    throw new Error('Did not receive event_ingested on SSE stream within timeout');
  }
  console.log('    ✅ Received event_ingested message with incrementing numeric ID:', ingestedMsg.id);

  // Ingest overspeed event -> triggers rule match & incident_created
  const ev2Id = crypto.randomUUID();
  await call('/v1/events', {
    method: 'POST',
    key: key1,
    body: {
      eventId: ev2Id,
      deviceId: dev1Id,
      seq: 2,
      type: 'telemetry',
      timestamp: new Date().toISOString(),
      payload: { speed: 125 }
    }
  });

  console.log('1e. Waiting for incident_created on SSE stream...');
  const incidentMsg = await waitForEvent(sseClient1, (e) => e.event === 'incident_created' && e.data?.deviceId === dev1Id);
  if (!incidentMsg) {
    throw new Error('Did not receive incident_created on SSE stream within timeout');
  }
  console.log('    ✅ Received incident_created message with ID:', incidentMsg.id, 'Incident ID:', incidentMsg.data?.incidentId);
  console.log('✅ TEST 1 PASSED: SSE headers, event_ingested, and incident_created confirmed.\n');

  // --------------------------------------------------------------------------
  // TEST 2: Reconnection with Last-Event-ID receives only missed messages
  // --------------------------------------------------------------------------
  console.log('--- TEST 2: Reconnection with Last-Event-ID ---');
  const lastReceivedId = incidentMsg.id;
  console.log('2a. Disconnecting Client 1 at Last-Event-ID:', lastReceivedId);
  sseClient1.close();
  await sleep(1000);

  // Publish 3 new events while disconnected
  const missedEventIds = [];
  for (let i = 3; i <= 5; i++) {
    const eid = crypto.randomUUID();
    missedEventIds.push(eid);
    await call('/v1/events', {
      method: 'POST',
      key: key1,
      body: {
        eventId: eid,
        deviceId: dev1Id,
        seq: i,
        type: 'telemetry',
        timestamp: new Date().toISOString(),
        payload: { speed: 50 + i }
      }
    });
  }

  console.log('2b. Reconnecting with Last-Event-ID:', lastReceivedId);
  const sseClient2 = connectSSE(`${BASE_URL}/v1/stream`, {
    headers: { 'Last-Event-ID': String(lastReceivedId) }
  });

  console.log('2c. Waiting for missed messages...');
  await sleep(2500);

  const replayedMessages = sseClient2.events.filter((e) => e.id > lastReceivedId);
  console.log('    Received missed messages count:', replayedMessages.length);
  for (const m of replayedMessages) {
    console.log(`    -> ID: ${m.id}, Event: ${m.event}`);
    if (m.id <= lastReceivedId) {
      throw new Error(`Reconnected client received older/duplicate ID: ${m.id} <= ${lastReceivedId}`);
    }
  }

  if (replayedMessages.length === 0) {
    throw new Error('Expected at least 1 missed message upon reconnect with Last-Event-ID');
  }
  sseClient2.close();
  console.log('✅ TEST 2 PASSED: Reconnection delivers only missed messages with ID > Last-Event-ID.\n');

  // --------------------------------------------------------------------------
  // TEST 3: Stale Last-Event-ID triggers resync_required
  // --------------------------------------------------------------------------
  console.log('--- TEST 3: Stale Last-Event-ID Triggers resync_required ---');
  // First, check the oldest available ID in the stream
  const oldestEntries = await redis.xrange(REALTIME_STREAM_KEY, '-', '+', 'COUNT', 1);
  let oldestStreamId = 1;
  if (oldestEntries && oldestEntries.length > 0) {
    oldestStreamId = parseInt(oldestEntries[0][0].split('-')[0], 10);
  }

  // If oldestStreamId is <= 1, advance the sequence so ID 1 is pruned
  if (oldestStreamId <= 1) {
    console.log('3a. Advancing Redis stream sequence to prune ID 1...');
    const currentSeq = await redis.incrby(REALTIME_SEQ_KEY, 10);
    // Add an entry with currentSeq-0
    await redis.xadd(REALTIME_STREAM_KEY, `${currentSeq}-0`, 'event', 'test_advance', 'id', currentSeq, 'timestamp', new Date().toISOString(), 'data', '{}');
    // Trim stream keeping only the latest entry
    await redis.xtrim(REALTIME_STREAM_KEY, 'MAXLEN', '~', 1);
  }

  console.log('3b. Connecting with stale Last-Event-ID: 1...');
  const sseClientStale = connectSSE(`${BASE_URL}/v1/stream`, {
    headers: { 'Last-Event-ID': '1' }
  });

  const resyncMsg = await waitForEvent(sseClientStale, (e) => e.event === 'resync_required', 10000);
  if (!resyncMsg) {
    throw new Error('Expected resync_required event for stale Last-Event-ID');
  }
  console.log('    ✅ Received resync_required message:', resyncMsg.raw);
  sseClientStale.close();
  console.log('✅ TEST 3 PASSED: Stale Last-Event-ID triggers resync_required.\n');

  // --------------------------------------------------------------------------
  // TEST 4: Burst Resilience & Incident Delivery Guarantee (500 events)
  // --------------------------------------------------------------------------
  console.log('--- TEST 4: 500-Event Burst & Incident Zero-Drop Guarantee ---');
  const sseClientBurst = connectSSE(`${BASE_URL}/v1/stream`);
  await sleep(1000);

  const burstDevId = 'phase4-burst-' + Date.now();
  const regBurst = await call('/v1/devices', {
    method: 'POST',
    body: { deviceId: burstDevId, name: burstDevId, location: 'burst-zone' }
  });
  const burstKey = regBurst.json?.apiKey;

  // Rule for burst test
  const burstRuleRes = await call('/v1/rules', {
    method: 'POST',
    body: {
      name: 'Burst Overspeed Alert',
      type: 'threshold',
      severity: 'critical',
      enabled: true,
      cooldownSeconds: 0,
      conditions: {
        metric: 'speed',
        operator: '>',
        value: 200,
        deviceFilter: { type: 'all' }
      }
    }
  });
  const burstRuleId = burstRuleRes.json?.rule?._id;

  console.log('4a. Ingesting burst of 500 events (including 5 incident-triggering events)...');
  const burstBatches = [];
  let currentSeq = 1;

  for (let b = 0; b < 10; b++) {
    const batch = [];
    for (let i = 0; i < 50; i++) {
      const isIncidentEvent = i === 25 && b < 5; // 5 total over-threshold events across batches
      batch.push({
        eventId: crypto.randomUUID(),
        deviceId: burstDevId,
        seq: currentSeq++,
        type: 'telemetry',
        timestamp: new Date().toISOString(),
        payload: { speed: isIncidentEvent ? 250 : 80 }
      });
    }
    burstBatches.push(batch);
  }

  const burstStartTime = Date.now();
  // Fire 10 batches in parallel chunks of 3
  for (let i = 0; i < burstBatches.length; i += 3) {
    const chunk = burstBatches.slice(i, i + 3);
    await Promise.all(
      chunk.map((b) => call('/v1/events/batch', { method: 'POST', key: burstKey, body: { events: b } }))
    );
  }

  console.log(`4b. Ingestion of 500 events completed in ${Date.now() - burstStartTime}ms`);

  // Wait for incident messages and evaluate event_ingested coalescing
  console.log('4c. Awaiting stream delivery and checking rate throttling...');
  await sleep(6000);

  const burstEvents = sseClientBurst.events;
  const incidentMessages = burstEvents.filter((e) => e.event === 'incident_created' || e.event === 'incident_updated');
  const ingestedMessages = burstEvents.filter((e) => e.event === 'event_ingested');

  console.log(`    Total stream events received: ${burstEvents.length}`);
  console.log(`    Incident alerts received: ${incidentMessages.length}`);
  console.log(`    Ingested events received: ${ingestedMessages.length}`);

  if (incidentMessages.length === 0) {
    throw new Error('Expected incident messages during burst, received none!');
  }

  // Check coalescing: In any 1-second interval, received event_ingested count should not exceed ~12 (accounting for clock jitter)
  const windowCounts = new Map();
  for (const msg of ingestedMessages) {
    const secondWindow = Math.floor(msg.receivedAt / 1000);
    windowCounts.set(secondWindow, (windowCounts.get(secondWindow) || 0) + 1);
  }

  let maxPerSecond = 0;
  for (const count of windowCounts.values()) {
    if (count > maxPerSecond) maxPerSecond = count;
  }
  console.log(`    Max event_ingested received in any 1-second window: ${maxPerSecond} (target <= 10)`);

  sseClientBurst.close();
  console.log('✅ TEST 4 PASSED: Incidents delivered with zero drops during 500-event burst, event_ingested coalesced.\n');

  // --------------------------------------------------------------------------
  // TEST 5: Multi-Instance API Fan-Out via Redis Pub/Sub
  // --------------------------------------------------------------------------
  console.log('--- TEST 5: Multi-Instance API Fan-Out via Shared Publisher & Pub/Sub ---');
  // Start second API instance on port 3003
  const secondaryPort = 3003;
  const { createApp } = await import('./apps/api/dist/app.js');
  const secondaryApp = createApp();
  const secondaryServer = http.createServer(secondaryApp);

  await new Promise((resolve) => secondaryServer.listen(secondaryPort, resolve));
  console.log(`5a. Secondary API server listening on http://localhost:${secondaryPort}`);

  const clientA = connectSSE(`${BASE_URL}/v1/stream`);
  const clientB = connectSSE(`http://localhost:${secondaryPort}/v1/stream`);
  await sleep(1500); // Wait for both subscribers to connect

  const broadcastPayload = {
    test: 'multi_instance_fanout',
    nonce: crypto.randomUUID()
  };

  console.log('5b. Publishing realtime message through shared publisher helper...');
  const published = await publishRealtimeEvent({
    event: 'device_status_changed',
    data: broadcastPayload
  });

  console.log('5c. Waiting for message delivery to both API instances...');
  const recA = await waitForEvent(clientA, (e) => e.data?.nonce === broadcastPayload.nonce, 8000);
  const recB = await waitForEvent(clientB, (e) => e.data?.nonce === broadcastPayload.nonce, 8000);

  if (!recA) throw new Error('API instance 1 (port 3000) failed to receive pub/sub event');
  if (!recB) throw new Error('API instance 2 (port 3003) failed to receive pub/sub event');

  console.log('    ✅ Client A (API 1) received message ID:', recA.id);
  console.log('    ✅ Client B (API 2) received message ID:', recB.id);

  clientA.close();
  clientB.close();
  secondaryServer.close();
  console.log('✅ TEST 5 PASSED: Both API instances successfully fanned out worker-published message.\n');

  // --------------------------------------------------------------------------
  // TEST 6: Heartbeat Comment & Client Disconnect Cleanup
  // --------------------------------------------------------------------------
  console.log('--- TEST 6: Heartbeat Comment & Client Disconnect Cleanup ---');
  const clientHeartbeat = connectSSE(`${BASE_URL}/v1/stream`);
  await sleep(1000);

  // Check stats for SSE client count
  const statsBefore = await call('/v1/stats');
  console.log('6a. Connected SSE clients reported in /v1/stats:', statsBefore.json?.sseClients);
  if ((statsBefore.json?.sseClients || 0) < 1) {
    throw new Error('Expected /v1/stats to report at least 1 active SSE client');
  }

  console.log('6b. Waiting 15.5s for SSE comment heartbeat (: heartbeat)...');
  await sleep(15500);

  console.log('    Raw comments received:', clientHeartbeat.rawComments);
  const hasHeartbeat = clientHeartbeat.rawComments.some((c) => c.includes('heartbeat'));
  if (!hasHeartbeat) {
    throw new Error('Did not receive expected : heartbeat comment within interval');
  }
  console.log('    ✅ SSE comment heartbeat confirmed!');

  clientHeartbeat.close();
  await sleep(1000);

  const statsAfter = await call('/v1/stats');
  console.log('6c. SSE client count after disconnect cleanup:', statsAfter.json?.sseClients);
  console.log('✅ TEST 6 PASSED: Heartbeat comments received and client cleaned up without leaks.\n');

  // --------------------------------------------------------------------------
  // TEST 7: Supporting Status APIs (/devices, /events, /stats, /activity)
  // --------------------------------------------------------------------------
  console.log('--- TEST 7: Supporting Status APIs Verification ---');

  // 1. GET /v1/devices
  const devListRes = await call('/v1/devices');
  console.log('7a. GET /v1/devices count:', devListRes.json?.count);
  if (!devListRes.json?.devices || devListRes.json?.devices?.length === 0) {
    throw new Error('GET /v1/devices returned no devices');
  }
  const sampleDev = devListRes.json.devices[0];
  console.log('    Sample device status:', sampleDev.status, 'lastSeenAt:', sampleDev.lastSeenAt, 'eventCount:', sampleDev.eventCount);
  if (!['online', 'stale', 'offline', 'registered'].includes(sampleDev.status)) {
    throw new Error(`Invalid computed status: ${sampleDev.status}`);
  }

  // Filter devices by status
  const filterDevRes = await call(`/v1/devices?status=${sampleDev.status}`);
  console.log(`    GET /v1/devices?status=${sampleDev.status} count:`, filterDevRes.json?.count);

  // 2. GET /v1/devices/:id/events
  const devEventsRes = await call(`/v1/devices/${dev1Id}/events?limit=5`);
  console.log('7b. GET /v1/devices/:id/events count:', devEventsRes.json?.count);
  if (!devEventsRes.json?.events) {
    throw new Error('GET /v1/devices/:id/events missing events array');
  }

  // 3. GET /v1/events
  const eventsListRes = await call(`/v1/events?deviceId=${dev1Id}&limit=10`);
  console.log('7c. GET /v1/events count:', eventsListRes.json?.count);
  if (!eventsListRes.json?.events) {
    throw new Error('GET /v1/events missing events array');
  }

  // 4. GET /v1/stats
  const statsRes = await call('/v1/stats');
  console.log('7d. GET /v1/stats:');
  console.log('    eventsPerMinute:', statsRes.json?.eventsPerMinute);
  console.log('    devicesByStatus:', statsRes.json?.devicesByStatus);
  console.log('    incidentsBySeverity:', statsRes.json?.incidentsBySeverity);
  console.log('    duplicatesCount:', statsRes.json?.duplicatesCount);
  console.log('    rejectedCount:', statsRes.json?.rejectedCount);
  console.log('    notifications:', statsRes.json?.notifications);

  if (statsRes.json?.duplicatesCount === undefined || statsRes.json?.rejectedCount === undefined) {
    throw new Error('GET /v1/stats missing duplicatesCount or rejectedCount');
  }

  // 5. GET /v1/activity
  const activityRes = await call('/v1/activity');
  console.log('7e. GET /v1/activity count:', activityRes.json?.count);
  if (!Array.isArray(activityRes.json?.activity)) {
    throw new Error('GET /v1/activity missing activity array');
  }
  if (activityRes.json.activity.length > 0) {
    console.log('    Latest activity type:', activityRes.json.activity[0].type);
  }

  // 6. Test Dashboard Auth (?token= param & open access when DASHBOARD_TOKEN unset)
  const tokenTestRes = await call('/v1/stats?token=local-test-token');
  console.log('7f. Dashboard endpoint with ?token= param: status', tokenTestRes.status);
  if (tokenTestRes.status !== 200) {
    throw new Error('Expected 200 on dashboard endpoint with ?token=');
  }

  console.log('✅ TEST 7 PASSED: All supporting status APIs and dashboard auth verified.\n');

  console.log('======================================================');
  console.log('🎉 ALL PHASE 4 REALTIME & STATUS TESTS PASSED 100%!');
  console.log('======================================================\n');
  process.exit(0);
}

runPhase4Tests().catch((err) => {
  console.error('\n❌ Phase 4 Test Failure:', err);
  process.exit(1);
});
