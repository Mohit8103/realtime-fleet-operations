# Architecture Decision Records (ADRs)

This document records the architectural decisions, trade-offs, and design rationale for the Real-Time Operations Platform.

---

## ADR-001: Monorepo Architecture with npm Workspaces

### Context
The platform consists of an API gateway, a background worker, a web dashboard, a CLI simulator, and shared libraries (config, logging). We needed a repository structure that avoids duplicated code while keeping development simple and reproducible.

### Decision
Adopt an **npm Workspaces monorepo** (`apps/*`, `packages/*`) using native Node.js tooling.

### Consequences & Trade-offs
- **Pros**:
  - Zero external monorepo dependencies (like Nx or Turborepo) needed for initial setup, keeping build pipelines lean and reliable.
  - Shared `@fleet/config` and `@fleet/logger` packages are consumed as standard local workspace dependencies.
  - Single `npm install` bootstraps the entire dependency tree.
- **Cons**:
  - Docker builds require setting the build context to the root so workspaces can resolve correctly. Addressed by standardizing `context: .` in `docker-compose.yml`.

---

## ADR-002: Asynchronous Event Ingestion via Redis + BullMQ

### Context
Telemetry events arrive at high frequencies from thousands of edge devices. Direct synchronous writes to MongoDB during peak load would lead to database lock contention, increased HTTP latency, and potential dropped packets.

### Decision
Decouple HTTP ingestion from business logic using **BullMQ on Redis**.

### Consequences & Trade-offs
- **Pros**:
  - **Fast Ingestion**: The API gateway validates payloads and pushes jobs to Redis in sub-millisecond time, returning `202 Accepted` immediately.
  - **Backpressure Protection**: Workers consume jobs at a controlled concurrency (`WORKER_CONCURRENCY`), preventing MongoDB overload.
  - **Fault Resilience**: Failed jobs are retained in Redis and automatically retried using exponential backoff policies.
- **Cons**:
  - Introduces Redis as a critical dependency. Mitigated by container health checks and persistent Redis volumes.

---

## ADR-003: Real-Time Transport: Server-Sent Events (SSE) vs WebSockets

### Context
The React operations dashboard requires instant updates when device statuses change or incidents occur. We evaluated WebSockets vs Server-Sent Events (SSE).

### Decision
Use **Server-Sent Events (SSE)** for the real-time event pipeline (`/api/v1/events/stream`).

### Consequences & Trade-offs
- **Pros**:
  - **Simplicity**: SSE operates over standard HTTP/1.1 and HTTP/2 without requiring custom upgrade handshakes or dual-protocol load balancer configurations.
  - **Built-in Reconnection**: Browser `EventSource` handles connection drops, exponential reconnection, and `Last-Event-ID` tracking natively.
  - **Unidirectional Fit**: Fleet monitoring is primarily server-to-client telemetry streaming. Control actions (e.g. resolving incidents) use standard REST POST/PATCH endpoints.
- **Cons**:
  - Unidirectional only (client cannot send arbitrary messages over the same stream). This is an explicit feature, not a drawback, as it cleanly separates read streams from command mutations.

---

## ADR-004: Dual Data Store Strategy (MongoDB + Redis)

### Context
The platform needs both high-throughput ephemeral caching/queueing and rich document querying for device states and historical incidents.

### Decision
Pair **Redis 7.2** for ephemeral queues, pub/sub, and heartbeats with **MongoDB 7.0** for durable device state and incident storage.

### Consequences & Trade-offs
- **Pros**:
  - Redis provides sub-millisecond BullMQ operations and fast TTL-based stale heartbeat tracking.
  - MongoDB provides flexible document models for heterogeneous device telemetry, indexing on `deviceId` and `timestamp`, and historical queries.
- **Cons**:
  - Two database engines to maintain. Justified because their access patterns and operational requirements are orthogonal.

---

## ADR-005: Unified Pino Structured JSON Logging & Distributed Tracing

### Context
Debugging fleet operations requires tracing telemetry packets from ingestion through queueing, rule execution, and UI broadcast. Plain text logs (`console.log`) lack machine parseability and trace correlation.

### Decision
Implement a shared `@fleet/logger` module utilizing **Pino** and Node.js **`AsyncLocalStorage`**.

### Consequences & Trade-offs
- **Pros**:
  - High performance: Pino is known for extremely low overhead in Node.js event loops.
  - Distributed Correlation: Each incoming request carries or generates an `x-correlation-id` header.
  - `AsyncLocalStorage` makes the correlation ID accessible across asynchronous execution stacks without polluting function signatures.
  - Standard JSON output in production enables automated ingestion into systems like Datadog, ELK, or CloudWatch.
- **Cons**:
  - In local development, JSON logs can be hard to read without pretty-printing; addressed by integrating `pino-pretty` for non-production environments.

---

## ADR-006: Health Check & Container Lifecycle Strategy

### Context
Docker Compose and orchestrators (Kubernetes/ECS) require robust readiness and liveness checks to ensure dependent services only start when dependencies are healthy.

### Decision
Equip all services with standardized `/healthz` endpoints and configure `service_healthy` dependencies in `docker-compose.yml`.

### Consequences & Trade-offs
- **Pros**:
  - API, Worker, and Web services all expose `/healthz` returning standard JSON metadata (status, uptime, timestamp).
  - Background worker hosts a lightweight HTTP probe server so container orchestrators can check worker liveness without executing heavy CLI commands inside the container.
  - Docker Compose starts services in strict topological order (`mongo`/`redis` healthy -> `api`/`worker` healthy -> `web` healthy).

---

## ADR-007: Centralized `@fleet/database` Package for Shared Data Models & Indexes

### Context
Both `apps/api` (HTTP ingestion, device registration, explainability REST queries) and `apps/worker` (BullMQ telemetry consumers, rules engine, sweeper, stale device detector) interact with MongoDB collections (`devices`, `events`, `rejected_events`, `rules`, `incidents`, `rule_evaluations`). Maintaining duplicate Mongoose models and schema definitions across separate applications led to duplicate index creation warnings, inconsistent TypeScript type definitions, and synchronization bugs across workspaces.

### Decision
Extract all Mongoose schemas, TypeScript interfaces, unique index initialization, and connection lifecycle management into a dedicated workspace package: `@fleet/database`.

Both `apps/api` and `apps/worker` consume `@fleet/database` as an internal workspace dependency (`packages/database`).

### Consequences & Trade-offs
- **Pros**:
  - **Single Source of Truth**: All schema changes, validations, and index definitions (such as the unique index on `events.eventId`) are defined in one place and instantly available to all services.
  - **Eliminates Connection & Index Duplication**: Startup routines initialize indexes deterministically once.
  - **Shared Domain Utilities**: Helper functions like `calculateDeviceStatus()` and common type definitions (`DeviceStatus`, `RuleSeverity`, `ThresholdConditions`) are shared without code duplication.
- **Cons & Trade-offs**:
  - Tighter schema coupling between the API service and the worker service. While microservice purists sometimes advocate for independent data access layers per service, in this real-time fleet operations platform, both services operate on the same MongoDB database and rely on shared transactional guarantees (e.g. `events` collection being the source of truth for deduplication and idempotency). A shared typed package provides compile-time type safety and guarantees schema parity across consumers.

---

## ADR-008: Incident Deduplication with Partial Unique Indexes & Transactional Outbox Notifications

### Context
In high-throughput IoT fleet operations, hundreds of over-threshold telemetry events can be received simultaneously across distributed worker instances. Previous check-then-insert incident suppression suffered from race conditions under concurrency, creating duplicate open incidents for the same device and rule. Furthermore, dispatching notifications synchronously during incident creation couples business logic to external webhook availability and causes duplicated or lost alerts during worker crashes.

### Decision
1. **Partial Unique Index Deduplication**:
   - Enforce at most ONE non-resolved incident per `dedupeKey` (`${ruleId}:${deviceId}`) using a MongoDB partial unique index:
     `{ dedupeKey: 1 }, { unique: true, partialFilterExpression: { state: { $in: ['open', 'acknowledged'] } } }`
   - Replaced check-then-insert with an atomic `findOneAndUpdate` upsert. Repeated event matches increment `occurrenceCount`, update `lastEventId`, and append references to `triggeringEvents` (capped at 20).
   - Concurrent `E11000` races are caught and retried immediately against the newly inserted document.
2. **Strict Incident State Machine**:
   - Only allow valid forward transitions: `open -> acknowledged`, `open -> resolved`, `acknowledged -> resolved`. Any other transition (or mutating a resolved incident) strictly returns `409 Conflict`.
   - Stale incidents auto-resolve only when fresh, non-replayed events arrive from the device, with an explanatory audit timeline entry. Replayed events never auto-resolve stale incidents.
3. **Transactional Outbox for Notifications**:
   - Persist a `notifications` outbox record atomically upon incident creation with status `pending`. Notification failures never block or roll back incident creation.
   - Dedicated worker dispatcher polls pending outbox records, claiming them atomically with a lease timeout (`status: 'sending'`, `lockedUntil`) to ensure concurrent workers never dispatch the same notification twice, and automatically reclaims expired leases after worker crashes.
   - Idempotent delivery to webhooks with `Idempotency-Key` headers, exponential backoff with jitter, and dead-lettering (`status: 'dead'`) after `MAX_NOTIFY_ATTEMPTS`.
4. **Storage Hygiene**:
   - Applied a 24-hour TTL index on `rule_evaluations` (`expireAfterSeconds: 86400`) to respect database storage limits.
   - Suppressed periodic stale detector evaluations when an incident is already open, incrementing `suppressedStaleChecksCount` on the incident document instead of writing redundant evaluation records.

### Consequences & Trade-offs
- **Pros**:
  - Absolute concurrency safety: Partial unique index guarantee holds across multiple distributed worker processes.
  - Zero duplicate notification dispatches with atomic lease claiming.
  - Resilience against third-party webhook outages via transactional outbox retry loops.
  - Controlled storage footprint on MongoDB Atlas free tier.
- **Cons**:
  - Partial indexes require MongoDB query patterns to explicitly match the filter expression (`state in ['open', 'acknowledged']`) to leverage the unique constraint.

---

## ADR-009: Realtime Server-Sent Events (SSE), Redis Stream Bounded Backlog, Multi-Instance Fan-Out, and Dashboard Status APIs

### Context
Operational monitoring of large device fleets requires real-time push updates for incoming telemetry, incident creation/lifecycle changes, and device health transitions. WebSockets introduce bidirectional complexity and stateful connection overhead; Server-Sent Events (SSE) offer a lightweight, standard HTTP push protocol supported natively by browsers. However, production fleet monitoring faces several constraints:
1. Native browser `EventSource` cannot send custom headers such as `x-api-key`.
2. Temporary client disconnections must recover missed messages without data loss.
3. Redis memory is tightly bounded (30 MB limit on free-tier Redis), necessitating strict log capping.
4. Telemetry bursts (e.g., 500 events/second) can saturate browser clients if high-frequency ingest events are not rate-limited, but critical incident and device status alerts must NEVER be dropped.
5. Multiple API instances must fan out messages published by background workers to all connected clients.

### Decision
1. **Server-Sent Events (`GET /v1/stream`)**:
   - Pushes four core real-time event types: `event_ingested`, `incident_created`, `incident_updated`, and `device_status_changed`.
   - Each message carries a monotonically incrementing numeric ID (`id: <number>`).
   - Supports the standard `Last-Event-ID` request header for seamless reconnection.
   - Sets standard SSE headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, and `X-Accel-Buffering: no` (disabling proxy buffering).
   - Emits an SSE comment heartbeat every 15 seconds (`: heartbeat\n\n`) to prevent intermediate proxy timeouts.
   - Cleans up client listeners on socket disconnect to guarantee zero memory or subscriber leaks.

2. **Bounded Redis Stream Log & Replay**:
   - Uses a Redis Stream (`fleet:stream:events`) capped via `XADD MAXLEN ~ 500` (configurable via `sseMaxLen` in `@fleet/config`).
   - Entries are indexed as `${seq}-0` where `seq` is generated atomically via `INCR fleet:stream:id_seq`.
   - On reconnect with `Last-Event-ID`, the server queries `XRANGE (${lastId}-0 +` to stream only missed messages.
   - If the requested `Last-Event-ID` is older than the oldest retained stream entry (log truncated), the server immediately emits a `resync_required` event payload, prompting the client to refetch full snapshot state.

3. **Shared Publisher Helper & Multi-Instance Fan-Out**:
   - Centralized `publishRealtimeEvent()` in `@fleet/config` used by both API routes and background workers:
     - Atomic `INCR` for sequential ID.
     - Capped `XADD` to `fleet:stream:events`.
     - Redis Pub/Sub broadcast on `fleet:pubsub:sse`.
     - Bounded recent activity push via `LPUSH` / `LTRIM 0 99` to `fleet:activity:recent`.
   - Every API instance subscribes to `fleet:pubsub:sse` on startup, broadcasting incoming pub/sub messages to its locally connected SSE clients. This decouples worker processing from specific API web nodes.

4. **Stream Throttling & Coalescing**:
   - High-rate `event_ingested` messages are coalesced to at most 10 per second per client using a 1-second sliding bucket window. Excess ingested messages in a window are dropped or replaced with latest state.
   - Critical messages (`incident_created`, `incident_updated`, `device_status_changed`, `resync_required`) are ALWAYS delivered immediately, bypassing rate limiters to guarantee zero dropped alerts under load.

5. **Dashboard Token Authentication & Status Endpoints**:
   - Because native `EventSource` cannot transmit custom headers, `/v1/stream` and dashboard read endpoints do not require `x-api-key`.
   - Implemented `dashboardAuth` middleware accepting an optional `DASHBOARD_TOKEN` environment variable passed via `?token=` query parameter or `Authorization: Bearer <token>` (off by default for seamless local development).
   - *Note on Production Deployments*: Production environments would integrate proper operator authentication (e.g., HTTP-only session cookies, OAuth2, or JWT tokens).
   - Supporting status endpoints:
     - `GET /v1/devices`: Lists devices with dynamically computed status (`online`, `stale`, `offline`), `location`, `lastSeenAt`, `lastSeq`, and event counts, with status filtering.
     - `GET /v1/devices/:id/events`: Paginated recent events for a specific device.
     - `GET /v1/events`: Paginated recent telemetry events, filterable by `type` and `deviceId`.
     - `GET /v1/stats`: Operational dashboard metrics (events per minute, devices by status, incidents by severity, BullMQ queue depth, failed jobs, Redis duplicate/rejection counters, outbox notifications, active SSE clients).
     - `GET /v1/activity`: Recent activity feed combining real-time memory buffer and database audit history.

6. **Connection Pool Hygiene**:
   - Implemented client connection pooling in `@fleet/config`: standard Redis operations (caching, deduplication, stats, publishing) share a single singleton Redis client per Node.js process (`getSharedRedisClient()`), while blocking consumers (BullMQ workers and SSE pub/sub subscribers) utilize dedicated clients (`createDedicatedRedisClient()`). This keeps total Redis connections safely within cloud provider limits (e.g. Upstash 20-connection cap).

### Consequences & Trade-offs
- **Pros**:
  - Full real-time dashboard responsiveness with zero WebSocket protocol overhead.
  - Fault-tolerant reconnects: network glitches seamlessly replay missed events from Redis Stream.
  - Safe memory bounds on free-tier Redis instances via `MAXLEN ~ 500`.
  - Zero dropped alerts for critical incidents during high-rate telemetry floods.
  - Multi-instance API readiness via Redis Pub/Sub broadcast.
- **Cons**:
  - SSE is unidirectional (server-to-client); dashboard actions (acknowledging, resolving incidents) still require standard HTTP REST POST requests.



