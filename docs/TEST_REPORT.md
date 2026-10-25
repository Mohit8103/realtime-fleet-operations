# Test Report and Failure Scenario Matrix

**Date:** 2026-10-25
**Service:** Fleet Operations Platform
**Environment:** local stack (MongoDB Atlas, Redis Cloud, API and worker running on one machine, two API instances for the fan-out test)
**Runner:** `npm test` (`tsx scripts/run-all-tests.ts`)
**Result of the last full run:** all five suites passed

The automated tests run against the live local stack, not mocks, so they exercise the real database, queue and stream. They also write test data into that database (see "What these tests do not cover").

---

## 1. Suite summary

| # | Suite | Scope | Duration | Result |
|:-:|:------|:------|:--------:|:------:|
| 1 | Unit tests | API and worker `/healthz`, `/readyz` dependency checks, correlation ID propagation | 5.46s | Passed (5 tests) |
| 2 | Phase 1 acceptance | Single and batch ingestion, duplicate handling, validation and rejection storage, rate limiting, queue backpressure | 23.92s | Passed (10 steps) |
| 3 | Phase 2 acceptance | Rules engine, evaluation records, retry and failed state, recovery sweeper, replayed-event handling | 43.80s | Passed (8 steps) |
| 4 | Phase 3 acceptance | Incident dedupe under concurrency, state transitions, outbox, notification retry, lease reclaim, dead-letter state | 102.80s | Passed (10 steps) |
| 5 | Phase 4 acceptance | SSE delivery, `Last-Event-ID` resume, `resync_required`, burst delivery, two-instance fan-out | 82.47s | Passed (7 steps) |
| | **Total** | | **258.45s** | **All passed** |

**About "dead" notifications in `/v1/stats`:** one Phase 3 test deliberately keeps the mock webhook failing until the maximum number of attempts is reached, to prove that an undeliverable notification ends in the `dead` state instead of retrying forever. A small number of dead notifications after a test run is therefore expected. `npm run reset-data` clears them.

---

## 2. Automated scenario matrix

| Scenario | What it proves | How it is tested | Result |
|:---------|:---------------|:-----------------|:------:|
| **Duplicate event ignored** | Sending the same `eventId` again returns `duplicate` and creates no second record, alert or job. MongoDB, not the Redis cache, is the source of truth. | Phase 1 acceptance sends one event twice. A second step deletes the Redis cache key and sends it again; the unique index on `events.eventId` still reports a duplicate. Phase 2 re-processes an already processed event and checks that incident and evaluation counts do not change. | Passed |
| **Malformed event rejected and stored** | Invalid JSON, missing fields, wrong types and bad timestamps get a clear `400` and are stored in `rejected_events` with the raw payload and reason. | Phase 1 acceptance sends missing-field, wrong-type and broken-JSON requests, plus an invalid item inside a batch, then reads the stored rejections back through the admin endpoint. | Passed |
| **Out-of-order event accepted** | An event with an older timestamp and lower sequence number is accepted, not rejected. | Phase 1 acceptance sends a mixed batch containing such an event; the per-event result is `accepted`. (`lastSeenAt` is the server receive time. Ordering-sensitive logic uses the device timestamp and `seq`, never arrival order.) | Passed |
| **Concurrent matches create one incident** | Twenty simultaneous matches for the same rule and device produce one incident and increment its occurrence count. | Phase 3 acceptance makes 20 concurrent `recordIncidentMatch` calls in one process and checks for exactly one incident with `occurrenceCount` 20 and one outbox notification. The guarantee comes from a unique index on `dedupeKey` with a partial filter on `state` in `open` and `acknowledged`, combined with an atomic upsert. It is not tested across two separate worker processes. | Passed |
| **Processing fails, then retry or failed state** | A job that keeps failing is retried with backoff, then marked failed and exposed to operators, who can re-queue it. | Phase 2 acceptance checks the failed-event listing and the retry path. | Passed |
| **Accepted but never processed (sweeper)** | An event stored as `pending` (for example after a crash or a failed enqueue) is re-enqueued and completed. | Phase 2 acceptance inserts a pending event, runs the sweeper and checks that it completes. | Passed |
| **Worker crash: lease reclaim and outbox repair (simulated)** | A notification claimed by a worker that then dies is reclaimed after its lease expires and sent once. An incident without a notification record gets exactly one created by the repair sweep. | Phase 3 acceptance simulates the crash by leaving an expired lease and by creating an incident with no notification, then runs the dispatcher and the repair sweep. No process is actually killed in the automated suite (see section 3 for the manual check). | Passed |
| **Notifier down, then recovered** | Incident creation is unaffected by a failing notification service; delivery is retried with backoff and succeeds once the service returns. | Phase 3 acceptance switches the mock webhook to failing through the admin endpoint, creates an incident, checks that the notification stays pending or failed with retries scheduled, then restores the webhook and checks for `sent`. | Passed |
| **Replay does not resolve a stale incident** | Replayed events are evaluated by the rules (the resulting incident is flagged `fromReplay`) but never mark a device healthy or resolve a stale incident. | Phase 2 and Phase 3 acceptance send a replayed event to a stale device and check that `lastSeenAt` is unchanged and the stale incident stays open. | Passed |
| **Fresh event auto-resolves a stale incident** | A live (non-replayed) event from a stale device updates `lastSeenAt` and resolves the open stale incident with a timeline entry. | Phase 3 acceptance sends a fresh event and checks the incident is `resolved` by `system:auto-resolve`. | Passed |
| **Invalid state transitions** | Acknowledging a resolved incident, or resolving it twice, returns `409`. | Phase 3 acceptance walks the full state machine. | Passed |
| **Queue full returns 429** | When queue depth reaches the configured limit, ingestion returns `429` with `code: "queue_full"` and a `Retry-After` header. | Phase 1 acceptance lowers the effective limit for the test and sends an event. | Passed |
| **SSE resume with Last-Event-ID** | A reconnecting client receives only the messages it missed, in order. If its id is older than the retained log, it receives `resync_required`. | Phase 4 acceptance disconnects a client, publishes messages, reconnects with the last id it saw, and then reconnects with a very old id. | Passed |
| **Incident messages survive a burst** | Telemetry messages are throttled per client, but incident messages are never dropped. | Phase 4 acceptance sends a 500-event burst and checks that every incident message arrives. | Passed |
| **Two API instances both deliver** | A message published by the worker reaches clients connected to either API instance. | Phase 4 acceptance runs a second API instance on another port. | Passed |

---

## 3. Manual verifications

These were run by hand against the live stack, not by the automated suite.

| Scenario | What was done | What was observed |
|:---------|:--------------|:------------------|
| **Worker stopped, events sent, worker restarted** | Stopped the worker, sent 20 over-threshold events, started the worker again. | While the worker was down all 20 events stayed `pending` in MongoDB. After restart all 20 were processed. A grouped query on `rule_evaluations` by event and rule found no duplicates. |
| **Stale detection** | Sent one event from a device and stopped. | A stale incident was created after the 30-second threshold, with a reason stating how long the device had been silent. |
| **Two workers, one stale scanner** | Ran two worker processes and let a device go stale. | A single stale incident per device and rule. The incident's suppressed-check counter increased instead of new incidents being created. |
| **Device offline, buffered replay** (`npm run demo:offline`) | Devices stopped sending for 90 seconds, buffered events locally, then replayed them. | Roughly 290 events were buffered across the devices and drained to zero in batches of 50. Replayed events kept their original timestamps and did not update `lastSeenAt`. Stale incidents opened during the outage (one open incident per device and rule) and were auto-resolved on the first fresh event. |
| **API restart with SSE resume** | Stopped and restarted the API with the dashboard open. | The dashboard showed the reconnecting banner with its last data still visible, then returned to connected. |

---

## 4. What these tests do not cover

- Processes are never killed with `kill -9`; crash recovery is verified by simulating its effects (expired leases, missing records) and by stopping the worker cleanly in the manual check.
- MongoDB and Redis are single nodes, so failover is not tested.
- The suites run against the live local stack and write into its database. Run `npm run reset-data` afterwards (this deletes all data in the configured database; use a throwaway one).
- There is no load testing beyond the 500-event burst and the flood in the acceptance suite, so throughput limits are unknown.
- Device clock skew is not tested.
- The automated suites do not drive the browser; the dashboard behavior (live updates, banner, acknowledge and resolve) was checked by hand.

---

## 5. Operational probes and admin visibility

**Health probes**

- `GET /healthz` is a cheap liveness check on the API (port 3000) and the worker (port 3001).
- `GET /readyz` checks dependencies with a 2-second timeout each: MongoDB and Redis for the API; MongoDB, Redis and the BullMQ queue for the worker. It returns `200` with per-dependency latency, or `503` naming the failing dependency.

**Investigation endpoints**

- `GET /v1/events/:id/evaluations` explains why an event did or did not create an incident.
- `GET /v1/admin/failed-events` lists events that exhausted their retries; `POST /v1/admin/failed-events/:id/retry` re-queues one.
- `GET /v1/admin/rejected-events` lists rejected payloads with the reason.
- `GET /v1/stats` and `GET /v1/activity` give counters and a recent activity feed.

**Structured logs** carry `eventId`, `deviceId` and `incidentId` where known at each stage: ingestion, duplicate, rejection, processing, rule match, incident created or updated, and notification dispatched, sent, failed or dead.

---

## 6. Running the tests

The API, the worker and both databases must be running first (`npm run dev`).

```bash
npm test
```

Individual suites:

```bash
npm run test:unit          # health and readiness unit tests
npm run test:acceptance    # ingestion, dedupe, rejection, backpressure
npm run test:phase2        # rules engine, evaluations, sweeper, replay
npm run test:phase3        # incidents, outbox, dispatcher
npm run test:phase4        # SSE, Last-Event-ID, multi-instance fan-out
```
