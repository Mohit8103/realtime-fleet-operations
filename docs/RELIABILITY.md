# Reliability and Failure Handling

This document describes what the platform does when things go wrong, where each behavior is implemented, and how it was checked. It also says what is not guaranteed. Where a behavior is verified only by simulation or by hand, that is stated.

## 1. Guarantees

### 1.1 Delivery: at-least-once plus idempotent processing

- **Device to platform: at-least-once.** A device keeps an event buffered until the API explicitly acknowledges it (`accepted` or `duplicate`). Anything not acknowledged is sent again, so an event can arrive more than once but is not silently lost.
- **Idempotent ingestion.** Every event carries a device-generated `eventId`. The API inserts the event into MongoDB first, and a unique index on `eventId` rejects a second insert. A duplicate returns HTTP 200 with `status: "duplicate"` and causes no new job, rule evaluation, incident or notification. MongoDB is the source of truth; a Redis cache is only a fast path and is written after a successful insert.
- **Platform to operators: at-least-once.** Notifications go through an outbox and are retried until they succeed or are marked `dead`. Each delivery carries an `Idempotency-Key` header (the notification id) so a receiver can discard repeats.
- **Net effect:** duplicates and retries are absorbed, so the visible results (events stored, incidents opened, notifications recorded) are the same as exactly-once. The platform does not claim exactly-once delivery on the wire.

### 1.2 Ordering

- Each event is stored with the device's `timestamp` and monotonic `seq`, and with the server's `receivedAt`. Arrival order is never used to decide what the latest reading is.
- **Out-of-order and late events are accepted**, not rejected, and are evaluated by threshold and type rules.
- **`lastSeenAt` is the server receive time of the latest live (non-replayed) event.** Events marked `replayed: true`, or with a timestamp older than five minutes, are evaluated by the rules (the resulting incident is flagged `fromReplay`) but never advance `lastSeenAt` and never resolve a stale incident.
- **Processing order is not strict.** Jobs for one device can be processed concurrently by more than one worker, so rule evaluation for a single device is not guaranteed to follow `seq` order. The incident logic is written so that this does not produce duplicate incidents.

---

## 2. Failure scenarios

| Failure | What the system does | Where implemented | How verified |
| :--- | :--- | :--- | :--- |
| **Duplicate delivery** (retry, resend, replay) | The insert into `events` hits the unique index on `eventId`; the API catches the duplicate-key error and returns `duplicate`. No job is enqueued and nothing downstream runs again. | `apps/api/src/routes/events.ts`, `packages/database/src/models/event.ts` | Automated: acceptance suite sends the same event twice, and again after deleting the Redis cache key, to show MongoDB decides. |
| **Event accepted but processing fails** | The event is already stored with `processingStatus: "pending"` before the API replies. The job is retried with exponential backoff. After the final attempt the event is marked `failed` with the error, listed at `GET /v1/admin/failed-events`, and can be re-queued with `POST /v1/admin/failed-events/:id/retry`. A recovery sweep also re-enqueues events left `pending`, or stuck in `processing`, so a crash between storing and enqueuing does not lose work. If the enqueue itself fails, the API returns 503 and the event stays `pending` for the sweep. | `apps/worker/src/consumer/telemetryConsumer.ts`, recovery sweeper in `apps/worker/src/engine/`, `apps/api/src/routes/admin.ts` | Automated: Phase 2 suite (sweeper re-enqueues a pending event; failed events are listed). |
| **Worker or API restart** | **API:** an event is acknowledged only after it is stored in MongoDB and queued, so a restart cannot lose an acknowledged event; devices resend anything unacknowledged. SSE clients reconnect with `Last-Event-ID` and receive what they missed. **Worker:** BullMQ returns stalled jobs to the queue, the startup and periodic sweeps re-enqueue stored but unprocessed events, and processing is idempotent, so a repeated job creates no duplicate incident. A notification claimed by a worker that dies is reclaimed once its lease expires. | `telemetryConsumer.ts`, `notificationDispatcher.ts` (claim with lease), the SSE route in `apps/api` | Automated, simulated: the suite leaves an expired notification lease and an incident with no notification, then checks recovery. Manual, real: worker stopped, 20 events sent, worker restarted; all 20 processed, no duplicate evaluations. Manual: API restarted with the dashboard open, which reconnected. A killed (`kill -9`) process is not tested. |
| **Notification service unavailable** | Incident creation does not depend on notifications. The notification stays in the outbox and is retried with exponential backoff and jitter. After the maximum number of attempts (`MAX_NOTIFY_ATTEMPTS`) it becomes `dead` and stays visible at `GET /v1/notifications`. Two workers cannot send the same notification: delivery is claimed atomically with a lease. | `apps/worker/src/notifications/notificationDispatcher.ts` | Automated: Phase 3 suite switches the mock webhook to failing, checks the incident exists and the notification is retried, restores the webhook and checks for `sent`; another step runs a notification to the `dead` state. |
| **Device reconnects after minutes offline** | While silent, the device is detected as stale and one `Stale Device Alert` incident opens per device. On reconnect the device sends its buffer in order, in batches, with `replayed: true`. The platform stores and evaluates those events, keeps their original timestamps, and does not treat the device as healthy. The first fresh (non-replayed) event updates `lastSeenAt` and auto-resolves the stale incident with a timeline entry. | `apps/worker/src/consumer/telemetryConsumer.ts`, `apps/worker/src/engine/incidentManager.ts`, `apps/simulator/` | Automated: Phase 2 and 3 suites (replayed event does not resolve a stale incident; fresh event does). Manual: `npm run demo:offline`. |
| **Ingestion exceeds processing capacity** | Two protections. **Queue backpressure:** when the BullMQ backlog reaches `MAX_QUEUE_DEPTH` (default 5000) the API returns `429` with `code: "queue_full"` and a `Retry-After` header. **Per-device rate limiting:** a device that exceeds its request budget gets `429` with `code: "rate_limited"`; the batch endpoint has its own, larger budget so a reconnect burst is not throttled like normal traffic. Devices back off and retry, and buffered events are kept. Ingestion is separated from processing by the queue, so a spike fills the queue and does not slow the API. | `apps/api/src/middleware/queueBackpressure.ts`, `apps/api/src/middleware/rateLimit.ts` | Automated: acceptance suite floods 300 requests (only `202` and `429`, no 5xx) and checks the `queue_full` response with a lowered limit. Sustained load was not tested. |
| **MongoDB or Redis unavailable** | **At startup:** the API and the worker check both databases and exit with an error naming the failing service. **While running:** `GET /readyz` returns 503 naming the failing dependency, while `/healthz` stays a cheap liveness check. An event is acknowledged only after it is stored in MongoDB, so a request that fails because of an outage is not acknowledged and the device keeps it buffered. Behavior of individual features during a partial outage (for example the rate limiter or the realtime stream when Redis is down mid-run) has not been verified. | Startup check in `packages/config`, readiness endpoints in `apps/api` and `apps/worker` | Startup failure checked by hand with a wrong Redis password (exits within a second with a clear message). Readiness endpoints covered by unit tests. A database outage during a run is not covered by an automated test. |

### Duplicate incidents under concurrency

Incidents are deduplicated by `dedupeKey` (rule plus device). A partial unique index allows at most one incident per key while it is `open` or `acknowledged`, and creation uses an atomic upsert; a lost race retries as an update. Repeated matches increment `occurrenceCount`, and repeated stale checks increment `suppressedStaleChecksCount`. Verified by an automated test with 20 concurrent matches in one process, and by running two workers by hand. Concurrency across separate processes is covered by the index, but the automated test does not itself run several processes.

### Outbox atomicity

When an incident is created, the incident and its notification record are written in a single MongoDB transaction, and a unique index on `notifications.incidentId` prevents a second creation notification. As a safety net, a repair sweep (at startup and every minute) creates a missing notification for any open incident older than a short grace period. Verified automatically by simulating a crash between the two writes.

---

## 3. Storage and memory limits

The databases used for development are free tiers, so growth is bounded:

- `rule_evaluations` has a 24-hour TTL index.
- Completed BullMQ jobs are limited to the last 100 and failed jobs to the last 500.
- The realtime stream in Redis is trimmed to roughly 500 messages (`XADD MAXLEN ~`).
- Stale-device checks that find an incident already open do not write a new evaluation record; they increment a counter on the incident.

After the development and test runs, Redis used under 5 MB of its 30 MB limit. This has not been tested at larger volumes.

---

## 4. Not guaranteed

- Exactly-once delivery on the wire.
- Strict per-device processing order.
- Behavior across a MongoDB or Redis failover: both are single nodes.
- Protection from unauthenticated traffic. The rate limits apply per registered device, device registration is open, and the dashboard endpoints have no operator login. See [LIMITATIONS.md](LIMITATIONS.md).
