# Architecture Blueprint: Real-Time Fleet Operations Platform

## 1. System Vision & Overview

The **Real-Time Fleet Operations Platform** is an enterprise-grade, event-driven operations system designed to ingest high-frequency IoT telemetry, evaluate operational alert rules, manage incident lifecycles, and fan out live stream updates to a mission-control web dashboard.

The architecture emphasizes:
- **Decoupled Ingestion**: Fast HTTP edge ingestion decoupled from database writes via asynchronous Redis queueing.
- **Authoritative Deduplication**: MongoDB unique constraints provide durable at-least-once to exactly-once idempotency.
- **Transactional Outbox**: Atomic database transactions guarantee zero notification loss during worker crashes.
- **Observable Stream Fanout**: Capped Redis Streams combined with Redis Pub/Sub power resilient Server-Sent Events (SSE) with `Last-Event-ID` resumption.

---

## 2. End-to-End System Architecture

```mermaid
flowchart TD
    subgraph Edge ["1. Edge & Telemetry Sources"]
        DEV["Physical Fleet Devices<br/>(Sensors / GPS / Telemetry)"]
        SIM["Fleet Simulator CLI<br/>(apps/simulator)"]
    end

    subgraph API_Cluster ["2. Ingestion & API Layer"]
        API1["API Instance 1<br/>(apps/api :3000)"]
        API2["API Instance 2<br/>(apps/api :3003)"]
        HEALTH["GET /healthz<br/>GET /readyz"]
    end

    subgraph Storage_Queue ["3. Storage & Message Broker"]
        MONGO[("MongoDB Atlas<br/>(events, devices, incidents,<br/>notifications, rejected_events)")]
        REDIS_QUEUE[("Redis BullMQ Queue<br/>('telemetry-queue')")]
        REDIS_STREAM[("Redis Stream & Pub/Sub<br/>(Capped XADD ~ 500 & channel 'sse_events')")]
    end

    subgraph Worker_Layer ["4. Processing & Incident Engine"]
        WORKER["Worker Daemon<br/>(apps/worker :3001)"]
        ENGINE["Rules Engine<br/>(Thresholds & Anomalies)"]
        STALE["Stale Device Detector<br/>(Scheduled Heartbeat Sweep)"]
        OUTBOX["Transactional Outbox Dispatcher<br/>(Lease Locks & Exponential Retries)"]
        REPAIR["Outbox Repair Sweeper<br/>(Crash Recovery)"]
    end

    subgraph Notification_Sink ["5. External Notification Sinks"]
        WEBHOOK["Operator Webhook / Pager<br/>(Mock Webhook :3000/mock/webhook)"]
    end

    subgraph Frontend ["6. Client Operations Dashboard"]
        WEB["React 18 + Vite Dashboard<br/>(apps/web :5173)"]
        SSE_CLIENT["EventSource SSE Receiver<br/>(Resumes with Last-Event-ID)"]
    end

    %% Flow connections
    DEV -->|HTTP POST /v1/events<br/>POST /v1/events/batch| API1
    SIM -->|HTTP POST /v1/events<br/>POST /v1/events/batch| API1
    DEV -.->|Load Balanced Ingestion| API2

    API1 -->|1. Write Source of Truth| MONGO
    API1 -->|2. Fast Enqueue| REDIS_QUEUE
    API2 -->|1. Write Source of Truth| MONGO
    API2 -->|2. Fast Enqueue| REDIS_QUEUE

    REDIS_QUEUE -->|Consume Telemetry Jobs| WORKER
    WORKER --> ENGINE
    WORKER --> STALE
    WORKER --> OUTBOX
    WORKER --> REPAIR

    ENGINE -->|Atomically Write Incident & Outbox Record| MONGO
    STALE -->|Create Stale Incident| MONGO
    REPAIR -->|Idempotently Create Missing Outbox Records| MONGO

    OUTBOX -->|HTTP POST with Idempotency-Key| WEBHOOK

    WORKER -->|Publish Realtime Event via Lua Script| REDIS_STREAM
    REDIS_STREAM -->|Pub/Sub Fanout to Connected APIs| API1
    REDIS_STREAM -->|Pub/Sub Fanout to Connected APIs| API2

    API1 -->|SSE Stream /v1/stream| SSE_CLIENT
    SSE_CLIENT --> WEB
```

---

## 3. Offline Disconnection, Replay, and Auto-Resolution Sequence

When a device loses connectivity, it buffers events locally to memory and disk (`.simulator-buffer.json`). The platform detects the absence of heartbeats, triggers a stale device incident, processes historical batch replays without false status updates, and automatically resolves incidents once fresh live events resume.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Device / Simulator
    participant API as API Gateway (:3000)
    participant DB as MongoDB Atlas
    participant Q as Redis Queue
    participant W as Worker Daemon (:3001)
    participant RedisPub as Redis Stream & Pub/Sub
    participant Dashboard as Web Dashboard (:5173)

    Note over Dev,Dashboard: Phase 1: Device Goes Offline
    Dev->>Dev: Network drops. Stops live transmissions.<br/>Appends telemetry to .simulator-buffer.json
    Note over W: Stale detection scheduled job (runs every 5s)
    W->>DB: Query devices where (now - lastSeenAt) > 60s
    DB-->>W: Device marked stale
    W->>DB: Atomically create 'Manual Stale' Incident & Outbox Record
    W->>RedisPub: Publish 'incident_created' & 'device_status_changed'
    RedisPub-->>API: Pub/Sub Broadcast
    API-->>Dashboard: SSE Push (device stale, incident open)

    Note over Dev,Dashboard: Phase 2: Device Reconnects & Replays Buffered Burst
    Dev->>Dev: Network restored. Reads .simulator-buffer.json
    Dev->>API: POST /v1/events/batch (50 events, replayed: true)
    API->>DB: Insert events to 'events' collection (E11000 dedupe)
    API->>Q: Enqueue telemetry-event jobs to BullMQ
    API-->>Dev: HTTP 200 { status: 'batch_processed', summary: { accepted: 50 } }
    Dev->>Dev: Truncate accepted items from disk buffer

    Q->>W: Process replayed event job
    W->>W: Detect isReplay = true (replayed flag or age > 5 min)
    W->>DB: Evaluate threshold rules & record RuleEvaluation
    Note over W,DB: CRITICAL: Do NOT advance device lastSeenAt.<br/>Do NOT resolve stale incident from historical data.

    Note over Dev,Dashboard: Phase 3: Fresh Live Stream Resumes & Auto-Resolves
    Dev->>API: POST /v1/events (fresh telemetry, replayed: false)
    API->>DB: Insert event & update device lastSeenAt = now, status = 'online'
    API->>Q: Enqueue telemetry-event job
    API-->>Dev: HTTP 202 Accepted
    Q->>W: Process fresh event job
    W->>DB: Evaluate rules & detect open stale incident for device
    W->>DB: Atomically update incident state = 'resolved', resolvedBy = 'system:auto-resolve'
    W->>RedisPub: Publish 'incident_updated' (resolved) & 'device_status_changed' (online)
    RedisPub-->>API: Pub/Sub Broadcast
    API-->>Dashboard: SSE Push (device online, incident resolved)
```

---

## 4. Pipeline Component Specifications

### 4.1 Ingestion API Gateway (`apps/api`)
- **Fast Ingestion Validation**: Validates telemetry payloads with Zod (`telemetryEventSchema` and `batchEventsSchema`).
- **Deduplication Gatekeeper**: Inserts directly to MongoDB `events` collection. Catches duplicate key error `E11000` on `eventId` and returns HTTP 200 `status: "duplicate"` with zero side effects.
- **Backpressure & Throttling**:
  - Rejects incoming traffic with HTTP 429 `code: "queue_full"` when BullMQ queue depth exceeds `MAX_QUEUE_DEPTH`.
  - Enforces per-device rate limiting (`rate_limited`) with `Retry-After`.
- **Realtime SSE Gateway**: Exposes `GET /v1/stream` with native `Last-Event-ID` header support, 15-second heartbeat comments, and client connection tracking.

### 4.2 Background Worker Daemon (`apps/worker`)
- **BullMQ Telemetry Consumer**: Processes telemetry jobs at controlled concurrency (`WORKER_CONCURRENCY: 5`), isolating write load from ingestion spikes.
- **Rules Engine (`rulesEngine.ts`)**: Evaluates `threshold`, `type_match`, and `no_report` rules with optional cooldown suppression windows. Writes explainability records to `rule_evaluations` (with a 24-hour TTL index).
- **Incident Manager (`incidentManager.ts`)**: Atomically creates and updates incidents with single-incident guarantees via MongoDB partial unique index on `{ dedupeKey: 1, state: { $in: ['open', 'acknowledged'] } }`.
- **Transactional Outbox (`notificationDispatcher.ts`)**: Dispatches notifications to operator webhooks using atomic leases (`lockedUntil`) and exponential backoff with jitter, marking notifications `dead` after reaching `MAX_NOTIFY_ATTEMPTS`.
- **Outbox Repair Sweeper**: Periodic sweep (at startup and every 60s) finding orphaned open incidents and repairing missing notification records idempotently.

### 4.3 Operations Mission Control Dashboard (`apps/web`)
- **Vite 6 + React 18**: Low-latency SPA consuming SSE streams and status REST endpoints.
- **Resilient Connection Handling**: Visual banner (`connected`, `reconnecting`, `offline`). Reconnects automatically using native `EventSource`. On receiving `resync_required`, transparently refetches REST snapshots.
- **Optimistic UI Updates**: Instant incident acknowledgment and resolution with automatic rollback on error.

### 4.4 Fleet Simulator CLI (`apps/simulator`)
- Single-file lightweight CLI supporting steady, burst, offline replay, and chaos scenarios.
- Caches authenticated device keys to `.simulator-keys.json` and buffers offline telemetry to `.simulator-buffer.json`.
