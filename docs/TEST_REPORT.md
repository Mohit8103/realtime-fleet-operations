# Automated Test Report & Failure Scenario Matrix

**Date**: 2026-10-25  
**Service**: Fleet Operations Platform  
**Target Environment**: Local Hybrid (Atlas MongoDB + Redis + Multi-Instance API + Background Worker)  
**Consolidated Runner**: `npm test` (`tsx scripts/run-all-tests.ts`)  
**Overall Status**: ✅ **ALL TEST SUITES PASSED (100%)**

---

## 1. Consolidated Test Suite Execution Summary

| Suite # | Suite Name | Scope & Coverage | Duration | Status |
|:-------:|:-----------|:-----------------|:--------:|:------:|
| **1** | **Unit Tests** | API & Worker `/healthz` liveness, `/readyz` dependency checks (Mongo, Redis, BullMQ Queue), correlation ID propagation | `5.46s` | ✅ PASSED (5 tests) |
| **2** | **Phase 1 Acceptance Suite** | Single/batch ingestion, MongoDB E11000 duplicate deduplication, schema validation & rejection storage, rate-limiting & backpressure | `23.92s` | ✅ PASSED (10 steps) |
| **3** | **Phase 2 Acceptance Suite** | Rules engine thresholds, explainability audit records, queue recovery sweeper, historical replayed telemetry isolation | `43.80s` | ✅ PASSED (8 steps) |
| **4** | **Phase 3 Acceptance Suite** | Concurrency deduplication (20 threads -> 1 incident), transactional outbox atomicity, crash recovery lease reclaim, dead-letter transitions | `102.80s` | ✅ PASSED (10 steps) |
| **5** | **Phase 4 Acceptance Suite** | Server-Sent Events (SSE), Last-Event-ID resumption, resync_required fallback, 500-burst zero-drop guarantee, multi-instance API fan-out | `82.47s` | ✅ PASSED (7 steps) |
| **Total** | **Consolidated Run (`npm test`)** | **Full end-to-end failure scenario test suite** | **258.45s** | **100% SUCCESS** |

> [!NOTE]
> **Regarding "Dead Notifications" in `/v1/stats`**:
> The 2 dead notifications displayed in `/v1/stats` (`notifications: { pending: 0, failed: 0, dead: 2, sent: 400 }`) are the expected result of **Phase 3 Test 9** (`test-phase3.mjs:615: Dead Letter Transition after MAX_NOTIFY_ATTEMPTS`). Test 9 deliberately exhausts 5 delivery attempts against a failing webhook to verify that unrecoverable notifications correctly transition to status `dead` instead of looping infinitely.

---

## 2. Failure Scenarios Verification Matrix

| Scenario | What It Proves | How It Is Tested | Real Result |
|:---------|:---------------|:-----------------|:-----------:|
| **1. Duplicate Event Ignored** | Event deduplication idempotency. Sending an identical `eventId` multiple times produces HTTP 200 with `status: "duplicate"` and produces zero duplicate database side-effects or alerts. | `test-acceptance.mjs` (Step 3 & Step 8b). First tested via fast Redis cache, then cache key is deleted via `DEL` to prove MongoDB unique index (`events.eventId`) acts as durable source of truth. Reprocessing checked via `test-phase2.mjs` (Step 5). | ✅ **PASSED** (HTTP 200 `status: "duplicate"`, 0 extra records) |
| **2. Malformed Rejected & Stored** | Validation robustness and system explainability. Malformed JSON or payloads with missing required keys, invalid ISO-8601 dates, or negative/non-numeric sequences are rejected with HTTP 400 and persisted to the `rejected_events` collection. | `test-acceptance.mjs` (Steps 4a, 4b, 4c, 9). Queried via `/v1/admin/rejected-events` and `/v1/events/rejected` verifying error reason, device ID, and raw payload. | ✅ **PASSED** (HTTP 400, saved to `rejected_events`) |
| **3. Out-of-Order Accepted** | Network jitter & non-monotonic packet arrival resilience. Out-of-order events with lower sequence numbers or earlier timestamps are accepted into the pipeline without failure, while device `lastSeenAt` and `lastSeq` update according to event timestamp rather than arrival order. | `test-acceptance.mjs` (Step 6 mixed batch: `[mk(10), ev, { bad: true }, old]`). Out-of-order telemetry is ingested, queued, and processed. | ✅ **PASSED** (Batch processed with mixed statuses, historical timestamp preserved) |
| **4. Concurrent Matches Create One Incident** | Thread concurrency safety and race-condition prevention under high load. When 20 simultaneous rule evaluation matches fire for the same device and rule, exactly 1 incident is created and the remaining 19 atomically increment `occurrenceCount`. | `test-phase3.mjs` (Step 3). `Promise.all` executes 20 concurrent `recordIncidentMatch` calls. Guaranteed via MongoDB partial unique index on `{ dedupeKey: 1, state: { $in: ['open', 'acknowledged'] } }`. | ✅ **PASSED** (Exactly 1 incident created, `occurrenceCount: 20`, 1 outbox notification) |
| **5. Worker Crash Then Recovery Without Duplicates** | Background consumer crash recovery and lease safety. If a worker process abruptly dies while processing an outbox notification or telemetry event, the item's lease lock expires (`lockedUntil < now`) and is safely reclaimed by another worker without duplicate delivery. | `test-phase3.mjs` (Step 8b & Step 10). Simulates worker crash holding an active notification lease; second worker recovers the expired lease. Tested crash between incident creation and notification creation; `repairOutboxSweep` repairs the outbox idempotently. | ✅ **PASSED** (Expired lease reclaimed; exactly 1 notification sent; unique index prevents duplicates) |
| **6. Notifier Down Then Recovered** | Outbox resilience and automatic retry with exponential backoff & jitter when downstream notification sinks (webhooks) experience outages. | `test-phase3.mjs` (Step 7). Mock webhook forced to return HTTP 500 via `/v1/admin/mock-webhook`. Notification transitions to `failed` and calculates next retry with jitter. Once webhook is restored to 200, dispatcher recovers and delivers notification (`status: "sent"`). | ✅ **PASSED** (Incident created safely during outage; notification delivered upon webhook recovery) |
| **7. Replay Does Not Resolve Stale Incident** | Historical and replayed data isolation. Replayed events (with `replayed: true` or timestamp older than 5 minutes) evaluate alert rules but do NOT advance device `lastSeenAt` and do NOT resolve open stale incidents. | `test-phase2.mjs` (Step 7) and `test-phase3.mjs` (Step 6b). Stale device receives a replayed event with high temperature. Incident triggers with `fromReplay: true`, but device status remains `stale`. | ✅ **PASSED** (Device `lastSeenAt` unchanged; stale incident remains open) |
| **8. Fresh Event Auto-Resolves Stale Incident** | Self-healing operations platform. When a real, fresh telemetry event is received from a stale or offline device, the platform marks the device `online`, advances `lastSeenAt`, and auto-resolves any open stale incidents with an audit trail timeline entry. | `test-phase3.mjs` (Step 6c). Fresh event ingested; open stale incident transitions from `open` to `resolved` with `resolvedBy: "system:auto-resolve"`. | ✅ **PASSED** (Incident state: `resolved`, timeline contains `resolved` action) |
| **9. Queue Full Returns 429** | Ingestion backpressure and server memory protection against unbounded queue growth. When BullMQ queue depth exceeds `MAX_QUEUE_DEPTH`, incoming ingestion requests are rejected immediately with HTTP 429 and `code: "queue_full"`. | `test-acceptance.mjs` (Step 10). Telemetry queue artificially held at depth >= 5 with `x-max-queue-depth: 5`. Request receives HTTP 429 with `Retry-After: 2`. | ✅ **PASSED** (HTTP 429 `code: "queue_full"`, `status: "rejected"`) |
| **10. SSE Resume With Last-Event-ID** | Realtime stream durability across network disconnections. A reconnecting client sending `Last-Event-ID` receives all missed events from the Redis capped stream buffer. If the client's ID is older than the retained buffer, a `resync_required` message is emitted. | `test-phase4.mjs` (Steps 2 & 3). Client disconnects at ID 1892, reconnects with `Last-Event-ID: 1892`, and receives all 9 missed messages in order. Reconnecting with ID `1` receives `resync_required`. | ✅ **PASSED** (Missed messages received in order; `resync_required` emitted on buffer eviction) |

---

## 3. Operational Probes & Admin Visibility Verification

### 3.1 Health Probes (`/healthz` vs `/readyz`)
- **Liveness Probe (`GET /healthz`)**:
  - Cheap, non-blocking check for container runtime liveness.
  - Returns HTTP 200 with uptime, environment, and correlation ID.
- **Readiness Probe (`GET /readyz`)**:
  - Deep dependency reachability check with strict **2-second timeouts**.
  - **API**: Validates MongoDB Atlas connectivity and Redis ping.
  - **Worker**: Validates MongoDB Atlas, Redis ping, and BullMQ `telemetry-queue` reachability.
  - Returns HTTP 200 with per-dependency latency or HTTP 503 listing failing dependencies.

### 3.2 Admin Visibility Endpoints
- **`GET /v1/admin/failed-events`**:
  - Paginated list of permanently failed events that exhausted BullMQ retry attempts.
- **`POST /v1/admin/failed-events/:id/retry`**:
  - Atomically resets event status from `failed` to `pending`, resets attempts, clears errors, and re-enqueues into BullMQ.
- **`GET /v1/admin/rejected-events`**:
  - Paginated inspection of events rejected by schema validation or malformed JSON payloads.
- **`GET /v1/events/:id/evaluations`**:
  - Full rule evaluation audit trail explaining why an event did or did not trigger an incident.

### 3.3 Structured Observability Logging
Every pipeline stage produces structured JSON logs containing `eventId`, `deviceId`, and `incidentId` where known:
1. `Event ingested` (single & batch)
2. `Duplicate event ignored` (fast-path cache & MongoDB fallback)
3. `Event rejected: validation failed` (missing fields, wrong types, malformed JSON)
4. `Processing telemetry event` & `Telemetry event processed successfully`
5. `Rule matched by event`
6. `Incident created` & `Incident updated (occurrence)`
7. `Dispatching incident notification`, `Notification successfully delivered`, `Notification failed; scheduled for retry`, and `Notification marked DEAD`

---

## 4. Running the Tests

To run the complete consolidated test suite:
```bash
npm test
```

To run individual test suites:
```bash
npm run test:unit          # Vitest unit tests (health & readiness probes)
npm run test:acceptance    # Phase 1: Ingestion, deduplication, rejection, backpressure
npm run test:phase2        # Phase 2: Rules engine, evaluations, sweeper, replay
npm run test:phase3        # Phase 3: Incidents, deduplication, outbox atomicity, dispatcher
npm run test:phase4        # Phase 4: Realtime SSE, Last-Event-ID, multi-instance fan-out
```
