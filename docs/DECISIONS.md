# Architecture Decision Records (ADRs)

This document records the critical architectural decisions, evaluated alternatives, design trade-offs, and technical rationale for the Real-Time Fleet Operations Platform.

---

## Index of Decisions

- **ADR-001**: Monorepo Architecture with npm Workspaces
- **ADR-002**: Ingestion Transport: HTTP REST vs MQTT vs WebSocket for Devices
- **ADR-003**: Real-Time Transport: Server-Sent Events (SSE) vs WebSockets for Dashboard
- **ADR-004**: Primary Database: MongoDB Atlas vs PostgreSQL
- **ADR-005**: Asynchronous Queue Broker: BullMQ on Redis vs Apache Kafka
- **ADR-006**: Notification Delivery: Transactional Outbox Pattern via MongoDB Transactions
- **ADR-007**: Incident Deduplication: Partial Unique Index on Active Incidents
- **ADR-008**: Deduplication Source of Truth: MongoDB Unique Index vs Redis Cache
- **ADR-009**: Device Liveness Isolation: Replayed Events Not Advancing `lastSeenAt`

---

## ADR-001: Monorepo Architecture with npm Workspaces

### Context
The platform consists of an API gateway, a background worker daemon, a React dashboard, a device simulator CLI, and shared libraries (`config`, `logger`, `database`). We required a project structure that minimizes code duplication, provides type safety across boundaries, and avoids unnecessary build tooling overhead.

### Decision
Adopt native **npm Workspaces** (`apps/*`, `packages/*`) using standard Node.js ECMAScript Modules (ESM).

### Alternatives Considered
1. **Turborepo / Nx**: Powerful caching and task pipelines, but introduces external orchestration dependencies, complex config files, and learning curves for reviewers.
2. **Multi-Repo**: Independent repositories for API, Worker, Web, and Shared libraries. Causes high versioning friction, multiple CI pipelines, and version drift during rapid feature iteration.

### Trade-offs & Rationale
- **Pros**:
  - Zero external monorepo dependencies; standard `npm install` bootstraps everything.
  - Native TypeScript project references provide end-to-end type safety between shared packages and consumers.
  - Simplified CI/CD: One commit encompasses full end-to-end feature changes across API, worker, and frontend.
- **Cons**:
  - Docker container builds require the build context set at repo root (`context: .`) so that workspace symlinks resolve properly. Solved cleanly in `docker-compose.yml`.

---

## ADR-002: Ingestion Transport: HTTP REST vs MQTT vs WebSocket for Devices

### Context
Edge IoT devices stream telemetry and periodic heartbeats. When network connectivity drops, devices buffer telemetry locally and burst-replay data upon reconnecting. We evaluated transport protocols for ingestion.

### Decision
Use **HTTP/1.1 REST** with single (`POST /v1/events`) and batch (`POST /v1/events/batch`) endpoints.

### Alternatives Considered
1. **MQTT (Message Queuing Telemetry Transport)**: Extremely lightweight binary header overhead (2 bytes), persistent TCP connection, built-in QoS levels.
2. **Raw WebSockets**: Persistent full-duplex TCP connection with low framing overhead.

### Trade-offs & Rationale
- **Why HTTP REST Won**:
  - **Firewall & Proxy Compatibility**: Works over standard HTTP ports (80/443) through corporate firewalls, cell modems, and edge proxies without custom TCP routing.
  - **Standard Stateless Backpressure**: Natively supports HTTP `429 Too Many Requests` with standard `Retry-After: <seconds>` headers, enabling client backoff without custom protocol handshakes.
  - **Horizontal Scalability**: Stateless HTTP requests distribute evenly across standard Layer 7 load balancers (ALB, NGINX) without sticky sessions or stateful connection pooling.
  - **Simple Batch Replay**: Buffered offline telemetry can be uploaded in clean 50-item batches via `/v1/events/batch`, reducing connection overhead.
- **Trade-off**:
  - Higher header overhead per packet compared to binary MQTT. For high-volume fleets, this is mitigated by batching replayed events and using keep-alive connections. For ultra-low bandwidth deployments (e.g. satellite/NB-IoT), an edge MQTT gateway terminating TLS and forwarding to the HTTP API is recommended (see [docs/DEPLOYMENT.md](DEPLOYMENT.md)).

---

## ADR-003: Real-Time Transport: Server-Sent Events (SSE) vs WebSockets for Dashboard

### Context
The operational mission control dashboard requires sub-second live streaming of incoming telemetry, device status transitions, and incident alerts.

### Decision
Use **Server-Sent Events (SSE)** via `GET /v1/stream`.

### Alternatives Considered
1. **WebSockets (`ws://` / `wss://`)**: Full-duplex bidirectional communication channel.
2. **HTTP Short / Long Polling**: Periodic REST requests every few seconds.

### Trade-offs & Rationale
- **Why SSE Won**:
  - **Unidirectional Fit**: Telemetry monitoring is intrinsically server-to-client streaming. User interactions (e.g. acknowledging or resolving incidents) use standard REST mutations (`POST /v1/incidents/:id/ack`), maintaining clean CQRS separation.
  - **Native Browser Resilience**: Browser `EventSource` automatically handles reconnection with exponential backoff and tracks the `Last-Event-ID` header, automatically requesting only missed events upon reconnect.
  - **Standard HTTP Transport**: Operates over HTTP/1.1 and HTTP/2 without WebSocket upgrade handshakes, protocol switching issues, or corporate proxy blocking.
  - **CORS & Proxy Simplicity**: Works seamlessly with standard reverse proxies (Vite proxy, NGINX) with `X-Accel-Buffering: no`.
- **Trade-off**:
  - Client cannot send messages over the stream. As noted, this is an intentional design benefit separating the write and read paths.

---

## ADR-004: Primary Database: MongoDB Atlas vs PostgreSQL

### Context
The platform requires durable storage for heterogeneous telemetry payloads, device registries, alert rules, incidents, explainability evaluation records, and outbox notifications.

### Decision
Use **MongoDB Atlas** (v7.0) with Mongoose.

### Alternatives Considered
1. **PostgreSQL with TimescaleDB / JSONB**: Relational SQL database with time-series extensions.
2. **Dedicated Time-Series DB (InfluxDB, Timescale) + Relational (Postgres)**: Two separate databases for metrics vs incidents.

### Trade-offs & Rationale
- **Why MongoDB Won**:
  - **Heterogeneous Telemetry**: Devices emit varying metrics (temperature, humidity, speed, battery, diagnostic codes). MongoDB's flexible BSON document model stores dynamic schemas without rigid schema migrations.
  - **Partial Unique Indexes**: MongoDB natively supports partial unique indexes (e.g. `{ dedupeKey: 1 }` with filter `{ state: { $in: ['open', 'acknowledged'] } }`), solving the incident deduplication race condition at the storage engine level.
  - **Embedded Incident Timelines**: Incident audit logs (triggering events, acknowledgment, resolution) are embedded directly within the incident document as capped arrays (`$slice: -20`), eliminating multi-table relational joins.
  - **TTL Indexes for Storage Hygiene**: High-frequency evaluation logs in `rule_evaluations` are automatically purged after 24 hours via MongoDB's native background TTL index (`{ expireAfterSeconds: 86400 }`).
- **Trade-off**:
  - Less optimal for complex relational joins across multiple entities. However, the operational domain is document-centric and read-optimized for individual devices and incidents.

---

## ADR-005: Asynchronous Queue Broker: BullMQ on Redis vs Apache Kafka

### Context
High-frequency telemetry ingestion must be decoupled from heavy rule evaluations, database writes, and notification dispatches to prevent database contention and guarantee low HTTP latency.

### Decision
Use **BullMQ on Redis** for internal message queueing.

### Alternatives Considered
1. **Apache Kafka**: High-throughput distributed partition log.
2. **RabbitMQ**: AMQP message broker with exchange routing.
3. **AWS SQS**: Managed cloud message queue.

### Trade-offs & Rationale
- **Why BullMQ on Redis Won**:
  - **Operational Simplicity**: Single Redis cluster serves as the message broker, pub/sub fanout engine, fast-path dedupe cache, and capped live stream buffer (`XADD MAXLEN ~ 500`). Zero JVM, Zookeeper, or KRaft operational overhead.
  - **Sub-Millisecond Ingestion**: Pushing a job to BullMQ takes under 1ms, allowing the API to return HTTP 202 immediately.
  - **Built-in Job Deduplication**: BullMQ supports explicit `jobId: eventId`, preventing duplicate queue jobs.
  - **Built-in Delayed / Repeatable Jobs**: Powers the 5-second recurring stale device scanner and exponential backoff retry policies natively.
- **Trade-off**:
  - Redis is memory-bound compared to Kafka's disk-based retention. We enforce strict retention limits (`removeOnComplete: 100`, `removeOnFail: 500`) and use Redis streams capped at 500 entries (`XADD MAXLEN ~ 500`), keeping memory footprint under 30 MB.

---

## ADR-006: Notification Delivery: Transactional Outbox Pattern via MongoDB Transactions

### Context
When a rule triggers an incident, a notification must be dispatched to an external operator webhook. If the worker crashes immediately after creating the incident but before sending the notification, the notification is permanently lost (dual-write problem).

### Decision
Implement the **Transactional Outbox Pattern** using MongoDB multi-document transactions (`session.withTransaction`).

### Alternatives Considered
1. **Direct Synchronous Webhook Call**: Worker sends HTTP request directly during rule evaluation.
   *Problem*: Webhook latency delays event processing; webhook failures cause rule evaluation failures; crashes lose notifications.
2. **Non-Transactional Two-Step Write**: Create incident in collection 1, then create notification in collection 2.
   *Problem*: A crash between step 1 and step 2 creates an orphaned incident with zero notification.

### Trade-offs & Rationale
- **How It Works**:
  1. `recordIncidentMatch()` opens a MongoDB session and executes `session.withTransaction()`.
  2. The `Incident` and the `Notification` outbox record are committed atomically: **both exist or neither does**.
  3. A background dispatcher polls pending outbox records and claims them using an atomic lease lock (`lockedUntil`).
  4. If a worker crashes during dispatch, the lease expires and a peer worker reclaims it.
  5. An **Outbox Repair Sweeper** periodically scans for open incidents lacking notification records and recreates them idempotently.
- **Trade-off**:
  - Multi-document transactions in MongoDB require a replica set (Atlas provides this by default). Adds minor transactional write overhead (~20ms), well worth the absolute delivery guarantee.

---

## ADR-007: Incident Deduplication: Partial Unique Index on Active Incidents

### Context
When a device exceeds an operational threshold 100 times in 10 seconds, or 20 concurrent threads process simultaneous events for the same device and rule, the system must produce **exactly one incident** with `occurrenceCount: 100`, rather than spamming 100 separate alerts.

### Decision
Enforce deduplication at the database level using a **MongoDB Partial Unique Index**:
```javascript
db.incidents.createIndex(
  { dedupeKey: 1 },
  { unique: true, partialFilterExpression: { state: { $in: ['open', 'acknowledged'] } } }
);
```

### Alternatives Considered
1. **Application-Level Check-Then-Act (`findOne`, then `create`)**:
   *Problem*: Race condition. Two concurrent threads find no existing incident and both insert, resulting in duplicate open incidents.
2. **Distributed Redis Mutex (`Redlock`)**:
   *Problem*: Adds network round trips, lock timeout tuning, and complexity during worker failover.

### Trade-offs & Rationale
- **How It Works**:
  - `dedupeKey` is composed of `${ruleId}:${deviceId}`.
  - While an incident is `open` or `acknowledged`, no second incident can be inserted with the same key.
  - The worker first attempts an atomic `findOneAndUpdate({ dedupeKey, state: { $in: ['open', 'acknowledged'] } }, { $inc: { occurrenceCount: 1 }, ... })`.
  - If no incident exists, it attempts creation within the transaction. If a concurrent race occurs, the unique index rejects the second insert with `E11000`, and the worker catches it and atomically increments the winner's occurrence count.
  - Once an incident transitions to `resolved`, it drops out of the partial index filter, allowing future threshold breaches to cleanly open a fresh incident.
- **Trade-off**:
  - Requires MongoDB partial index support. Fully supported in all modern MongoDB versions.

---

## ADR-008: Deduplication Source of Truth: MongoDB Unique Index vs Redis Cache

### Context
Duplicate telemetry packets occur frequently due to cellular retries, network retransmissions, or client reconnects. We needed a deduplication architecture that is both fast and 100% durable.

### Decision
Designate **MongoDB's unique index on `events.eventId` as the authoritative source of truth**, with Redis as a non-authoritative fast-path cache.

### Alternatives Considered
1. **Redis-Only Deduplication (`SET NX` or Redis Bloom Filter)**:
   *Problem*: If Redis restarts, experiences an outage, or evicts keys under memory pressure (`volatile-lru`), historical deduplication memory is lost, allowing duplicate packets to be accepted and re-executed.

### Trade-offs & Rationale
- **How It Works**:
  1. The API attempts `Event.create({ eventId, ... })` directly in MongoDB.
  2. If the event already exists, MongoDB immediately throws duplicate key error `E11000`.
  3. The API catches `E11000` and returns HTTP 200 `status: "duplicate"`.
  4. Redis caching (`event_seen:<eventId>`) occurs **only after** successful MongoDB persistence.
  5. Verified by acceptance test 8b: even when the Redis cache key is explicitly deleted via `DEL`, subsequent duplicate submissions still return `duplicate` via MongoDB.
- **Trade-off**:
  - MongoDB insert round-trip is required for the first write (~10-20ms). This ensures zero duplicate events ever enter the queue or rule engine under any failure scenario.

---

## ADR-009: Device Liveness Isolation: Replayed Events Not Advancing `lastSeenAt`

### Context
When a device disconnects for 20 minutes and subsequently dumps hundreds of buffered readings upon reconnecting, the system must evaluate operational rules against the historical data (e.g. detect a motor overheating while offline), but must **not** falsely treat the historical timestamps as live heartbeats.

### Decision
Flag replayed events with `replayed: true` (or detect `receivedAt - timestamp > 5 minutes`), and **isolate replayed telemetry from device liveness tracking**.

### Alternatives Considered
1. **Treat All Received Telemetry Equally**: Update device `lastSeenAt` to `new Date()` or event `timestamp` on every event.
   *Problem*: If a device was offline for an hour and reconnects, replaying old events with historical timestamps would cause device status to bounce incorrectly or falsely mask active stale alerts.

### Trade-offs & Rationale
- **How It Works**:
  - When `isReplay === true`:
    - The event is evaluated against all threshold rules (incidents created are flagged `fromReplay: true`).
    - Device `lastSeenAt` is **not advanced**.
    - Device `status` is **not set to online**.
    - Open `stale` incidents are **not auto-resolved**.
  - Device liveness updates and stale incident auto-resolution occur **only** when fresh, non-replayed live telemetry arrives.
- **Trade-off**:
  - Requires devices to accurately set the `replayed` flag or server to use a 5-minute threshold. Both mechanisms are implemented in the API for layered safety.
