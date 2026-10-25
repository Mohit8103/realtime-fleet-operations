# Known Limitations and Trade-offs

This document outlines the known limitations, architectural trade-offs, and operational boundaries of the current Real-Time Operations Platform implementation.

---

## 1. Single Node Mongo & Redis Deployments (Free-Tier Topology)
- **Current State**: Configured against single-node managed instances (MongoDB Atlas free tier M0, Upstash/Redis Cloud free tier).
- **Limitation**: While suitable for local development, testing, and prototype demonstrations, single nodes lack multi-region active-active clustering, distributed consensus across geographic zones, and automated cross-region failover.
- **Impact**: Upstream network partitions between the local worker and remote cloud regions may induce intermittent connection timeouts or reduced batch throughput.

---

## 2. Shared-Secret API Key Device Authentication
- **Current State**: Device authentication relies on pre-shared API keys transmitted via the `x-api-key` header (`apps/api/src/middleware/auth.ts`).
- **Limitation**:
  - No per-device public-key infrastructure (mTLS or asymmetric Ed25519/RSA device signatures).
  - Keys are provisioned statically during registration rather than through hardware secure enclaves (TPM / Secure Element / HSM).
  - Revocation requires updating or deleting the device key record in MongoDB; no automated certificate revocation list (CRL) or rotating short-lived JWT token exchange.

---

## 3. Dashboard Operator Authentication & RBAC
- **Current State**: The React web dashboard (`apps/web`) communicates directly with the API Gateway without requiring operator authentication or role-based access control (RBAC).
- **Limitation**: Anyone with network access to the web interface or API port can acknowledge/resolve incidents or trigger manual batch retries.
- **Production Path**: Integrate an identity provider (OAuth 2.0 / OIDC with Auth0, Okta, or Keycloak) and issue signed JWTs for operator actions.

---

## 4. Device Clock Skew & Timestamp Trust
- **Current State**: Event ordering and staleness checks evaluate the device-provided ISO-8601 `timestamp`.
- **Limitation**: If an IoT device experiences severe clock drift or has an unsynchronized RTC (Real-Time Clock):
  - Future timestamps could skew anomaly detection windows.
  - Expired historical events might evade stale device checks.
- **Mitigation**: The system inspects arrival time against `timestamp` and applies a 5-minute replay heuristic (`Date.now() - timestamp > 300_000` marks events as replayed), but production environments should enforce NTP synchronization on client devices or pair client timestamps with server arrival timestamps (`receivedAt`).

---

## 5. SSE Replay Buffer Window Capped at ~500 Messages
- **Current State**: Real-time event broadcasting utilizes a Redis Stream (`XADD fleet:events:stream MAXLEN ~ 500`) paired with Pub/Sub.
- **Limitation**: When a client disconnects and reconnects using `Last-Event-ID`, Redis retrieves missed events from the stream buffer. If a client stays disconnected through more than ~500 ingested events, the stream will have evicted older messages.
- **Client Behavior**: When the requested `Last-Event-ID` is purged from the stream, the API sends a `resync_required` event, prompting the web dashboard to fetch full snapshot state via REST.

---

## 6. Concurrent Worker Processing & Per-Device Ordering
- **Current State**: Ingestion queues allow BullMQ workers to process events concurrently across multiple threads (`concurrency: 5`).
- **Limitation**: There is no strict FIFO partition key guaranteeing that event `seq: 10` is processed strictly before `seq: 9` across distinct worker threads if both are in-flight simultaneously.
- **Design Safeguard**: MongoDB atomic operators (`$max: { lastSeq }`, `$max: { lastSeenAt }`, and `$setOnInsert`) ensure database consistency regardless of worker arrival order. Historical out-of-order events are recorded without overwriting newer sequence positions.

---

## 7. Replayed Events Policy on Staleness and Auto-Resolution
- **Current State**: Events flagged with `replayed: true` (or generated more than 5 minutes prior to ingestion) do not update `lastSeenAt` and do not auto-resolve `device_stale` incidents.
- **Limitation**: If a device was offline for 2 hours, reconnects, and dumps its offline buffer, the stale incident remains open until the device emits a fresh, real-time heartbeat or telemetry reading.
- **Rationale**: Replayed events represent historical data; an active operational alarm must only be cleared by verified real-time device liveness.

---

## 8. Stale Device Check Suppression and Evaluation Records
- **Current State**: The periodic stale device evaluator runs every 30 seconds (`staleDeviceJob`). If an existing `device_stale` incident is already open, it increments the occurrence count and logs a suppression entry rather than writing a duplicate rule evaluation document.
- **Limitation**: Audit logs show the initial stale evaluation and subsequent incident resolution, but suppress redundant evaluation entries for every intermediate 30-second tick to prevent MongoDB write amplification.

---

## 9. Cloud Free-Tier Storage and Throughput Thresholds
- **Current State**:
  - MongoDB Atlas M0 cluster enforces a 512 MB storage quota and connection pool caps (max 500 connections).
  - Upstash / Redis Cloud free tiers impose memory caps (30 MB) and daily command limits (10,000 commands/day).
- **Limitation**: Continuous load tests running millions of events will eventually exhaust storage or throttle on connection limits. In production, enterprise tiers with dedicated IOPS and memory are mandatory.

---

## 10. Lua CJSON Serialization Edge Case (`{}` -> `[]`)
- **Current State**: The atomic Redis publishing script (`publish_event.lua`) decodes and re-encodes the event payload using Redis's internal `cjson` module before executing `XADD` and `PUBLISH`.
- **Limitation**: The Lua `cjson` library encodes empty Lua tables `{}` as JSON arrays `[]` rather than empty JSON objects `{}`.
- **Impact**: If a telemetry event contains an empty object payload (e.g. `"metadata": {}`), the live SSE stream receives `"metadata": []`. The API REST endpoints and MongoDB storage are unaffected because they use native Node.js JSON parsing.
