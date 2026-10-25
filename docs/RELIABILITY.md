# Reliability & Fault-Tolerance Architecture

## 1. Core Reliability Principles & Delivery Guarantees

The Fleet Operations Platform guarantees **predictable resilience, data preservation, and operational continuity** under hardware crashes, network partitions, and downstream outages.

### 1.1 Delivery Guarantee: At-Least-Once Delivery + Idempotent Processing
- **Edge-to-Server**: Devices buffer telemetry locally and retry upon failure until the server explicitly acknowledges acceptance (`status: "accepted"` or `"duplicate"`). This guarantees **at-least-once delivery**.
- **Idempotency Gate**: The server guarantees that duplicated network transmissions produce **zero duplicate side effects**. The first write establishes durable state in MongoDB; subsequent duplicate submissions return HTTP 200 `status: "duplicate"` without re-triggering queues, rule evaluations, or notifications.
- **Server-to-Outbox**: The Transactional Outbox pattern guarantees **at-least-once notification dispatch** to operator webhooks. Webhooks receive an `Idempotency-Key: <notificationId>` header to deduplicate deliveries on the receiver side.

### 1.2 Ordering Approach: Device-Side Monotonic Sequence & Timestamps
- In distributed IoT systems, packet arrival order at the server is non-deterministic due to network jitter, packet retransmissions, and multi-threaded API workers.
- **Ordering Source**: The platform relies on the edge device's internal monotonic sequence counter (`seq`) and UTC generation timestamp (`timestamp`), **never** arrival order (`receivedAt`).
- **Device State Updates**: The worker updates device records using atomic `$max: { lastSeq }` operations and compares `eventTimestamp >= currentLastSeen` before advancing liveness, ensuring late-arriving packets do not overwrite newer state.

---

## 2. Failure Scenarios & Recovery Matrix

| Failure Scenario | System Behavior & Mitigation | Where Implemented | How Tested |
| :--- | :--- | :--- | :--- |
| **1. Duplicate Delivery**<br/>*(Cellular retry, client re-send, or network replay)* | The API attempts insertion into the MongoDB `events` collection. The unique index on `eventId` immediately rejects the second write with error `E11000`. The API catches this and returns HTTP 200 with `status: "duplicate"`. No duplicate job is enqueued; no duplicate incident is created. | `apps/api/src/routes/events.ts` (lines 95–173)<br/>`packages/database/src/models/event.ts` | **`test-acceptance.mjs`** (Test 3 & Test 8b). Verified both with Redis cache active and after Redis key eviction (`DEL`). |
| **2. Accepted But Processing Fails**<br/>*(Worker throws unhandled error, database times out during rule evaluation)* | The event is already durably persisted in MongoDB with `processingStatus: "pending"`. BullMQ automatically retries the job up to 3 times with exponential backoff. If all attempts are exhausted, the worker sets `processingStatus: "failed"`, logs the error stack, and an admin can inspect via `/v1/admin/failed-events` and re-enqueue via `POST /v1/admin/failed-events/:id/retry`. The background sweeper also re-enqueues orphaned pending events. | `apps/worker/src/consumer/telemetryConsumer.ts`<br/>`apps/worker/src/engine/sweeper.ts`<br/>`apps/api/src/routes/admin.ts` | **`test-phase2.mjs`** (Test 6: Sweeper re-enqueues orphaned pending events; Test 8: Admin failed events inspection). |
| **3. Worker or API Restart**<br/>*(Pod eviction, OOM kill, unhandled crash, deployment rollout)* | - **API Restart**: Ingested events are already written to MongoDB and BullMQ before HTTP 202 is returned. Reconnecting devices retry unacknowledged packets.<br/>- **Worker Crash**: If a worker dies while holding a notification lease, its `lockedUntil` timestamp expires. The next available worker or recurring tick claims the expired lease (`lockedUntil < now`) and finishes delivery. Active queue jobs in BullMQ return to the queue via stalled-job detection (`stalledInterval: 30000`). | `apps/worker/src/notifications/notificationDispatcher.ts` (`claimNextNotification`)<br/>`apps/worker/src/consumer/telemetryConsumer.ts` | **`test-phase3.mjs`** (Test 8b: Expired lease reclaimed after crash; Test 10: Outbox repair sweeper heals orphaned records). |
| **4. Notification Service Down**<br/>*(Downstream webhook endpoint returns 500, 502, 504, or times out)* | The incident is created safely in MongoDB. The notification attempt fails, increments `notification.attempts`, and schedules the next attempt using exponential backoff with jitter (`1000 * 2^attempts + jitter`, capped at 60s). When the webhook recovers, pending notifications are delivered. If `MAX_NOTIFY_ATTEMPTS` (5) is reached, it transitions to `status: "dead"` without crashing workers. | `apps/worker/src/notifications/notificationDispatcher.ts` (`processNotification`) | **`test-phase3.mjs`** (Test 7: Mock webhook forced to 500 then restored; Test 9: Dead-letter transition after 5 attempts). |
| **5. Device Reconnecting After Minutes Offline**<br/>*(Tunnel, power outage, cell blind spot)* | Device buffers readings in memory and persists to `.simulator-buffer.json`. Meanwhile, the server flags the device as `stale` and creates a `Manual Stale` incident. Upon reconnect, the device sends buffered data in batches of 50 via `/v1/events/batch` with `replayed: true`. The server evaluates rules on historical data but **does not** advance `lastSeenAt`. Once the buffer is cleared and fresh events arrive, the device becomes `online` and stale incidents auto-resolve. | `apps/worker/src/consumer/telemetryConsumer.ts`<br/>`apps/worker/src/engine/incidentManager.ts`<br/>`apps/simulator/src/index.ts` | **`npm run demo:offline`**<br/>**`test-phase2.mjs`** (Test 7)<br/>**`test-phase3.mjs`** (Test 6: Replay vs Fresh auto-resolve). |
| **6. Ingestion Exceeding Processing Capacity**<br/>*(Traffic spike, reconnect storms, DDOS flood)* | Two-tier backpressure protection:<br/>1. **Queue Depth Backpressure**: When BullMQ waiting jobs exceed `MAX_QUEUE_DEPTH` (5000), the API rejects new requests with HTTP `429 Too Many Requests`, response code `"queue_full"`, and a `Retry-After: 2` header.<br/>2. **Per-Device Rate Limiting**: Devices exceeding 100 requests / 5 seconds receive HTTP 429 `"rate_limited"`.<br/>3. **Batch Rate Limiter**: `/v1/events/batch` has an independent, higher rate limit to absorb burst reconnects without dropping packets. | `apps/api/src/middleware/queueBackpressure.ts`<br/>`apps/api/src/middleware/rateLimit.ts` | **`test-acceptance.mjs`** (Test 7: 300 flood requests; Test 10: Queue depth >= 5 returns 429 `queue_full`). |

---

## 3. Storage Hygiene & Memory Management

To prevent unbounded resource consumption on cloud and free tiers:
1. **Rule Evaluation TTL**: Every evaluation recorded in `rule_evaluations` carries an automatic 24-hour expiration managed by MongoDB's native TTL index (`{ expireAfterSeconds: 86400 }`).
2. **Redis BullMQ Job Capping**: Completed jobs are limited to 100 and failed jobs to 500 (`removeOnComplete: 100`, `removeOnFail: 500`).
3. **Redis Stream Capping**: Realtime SSE messages in Redis streams are capped using approximate length trimming (`XADD MAXLEN ~ 500`), ensuring Redis memory usage remains bounded under 30 MB even during million-event simulations.
4. **Stale Evaluation Tick Suppression**: The stale detector runs every 5 seconds. To avoid writing millions of redundant evaluations, it records an evaluation once upon incident creation and then increments `occurrenceCount` and suppresses repeated evaluations until status changes.
