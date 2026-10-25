# Device Telemetry & Ingestion Protocol Specification

This document specifies the communication contract, payload schemas, authentication mechanism, and retry semantics between edge devices (or the fleet simulator) and the Fleet Operations Platform Ingestion API.

---

## 1. Device Authentication

All device ingestion endpoints require device authentication via an API key passed in the request header.

- **Header Name**: `x-api-key` (case-insensitive: `x-api-key` or `X-API-KEY`).
- **Storage Model**: API keys are generated as secure random hex strings (`fleet_<random_hex>`) and stored in MongoDB as **SHA-256 hashes** (`devices.apiKeyHash`). Plaintext keys are never stored on the server.
- **Fast-Path Verification**: Once verified, the API caches the device identity in Redis (`device_key:<hash>`) with a 24-hour TTL.

### Device Registration (`POST /v1/devices`)
Unregistered devices can register once to obtain an API key:

```http
POST /v1/devices HTTP/1.1
Content-Type: application/json

{
  "deviceId": "device-sensor-042",
  "name": "Warehouse Sensor 42",
  "location": "tokyo-dc1"
}
```

**Response (HTTP 201 Created)**:
```json
{
  "status": "created",
  "deviceId": "device-sensor-042",
  "name": "Warehouse Sensor 42",
  "location": "tokyo-dc1",
  "apiKey": "fleet_36ff8d96135686ae831aa984663dce3f08e44d56a0f7440e",
  "createdAt": "2026-10-25T12:00:00.000Z"
}
```
*If a device re-registers with an existing `deviceId`, the server returns HTTP 200 with the existing device record without regenerating the key.*

---

## 2. Telemetry Event Schema

Every telemetry event must conform to the following schema:

| Field | Type | Required | Description | Example |
| :--- | :--- | :---: | :--- | :--- |
| `eventId` | String (UUIDv4) | **Yes** | Globally unique event identifier for idempotency. | `"a814187e-07a8-486a-b27b-2016335017e4"` |
| `deviceId` | String | **Yes** | Unique identifier of the transmitting device. | `"device-sensor-042"` |
| `seq` | Number (Integer >= 0) | **Yes** | Strictly monotonic counter per device. | `142` |
| `type` | String | **Yes** | Event categorization (`reading`, `heartbeat`, `telemetry`). | `"reading"` |
| `timestamp` | String (ISO-8601) | **Yes** | Device clock generation time (UTC). | `"2026-10-25T12:05:30.123Z"` |
| `replayed` | Boolean | No | Flags whether this event is replayed from offline buffer. | `false` |
| `payload` | Object (JSON) | **Yes** | Arbitrary telemetry measurements and operational metrics. | `{"temperature": 74.2, "battery": 92}` |

### Validation Rules
- `eventId` must be a valid UUID string.
- `seq` must be an integer `>= 0`.
- `timestamp` must parse as a valid ISO-8601 datetime string.
- `payload` must be a valid JSON object.

---

## 3. Single Event Ingestion (`POST /v1/events`)

Used for real-time live event transmission.

```http
POST /v1/events HTTP/1.1
Content-Type: application/json
x-api-key: fleet_36ff8d96135686ae831aa984663dce3f08e44d56a0f7440e

{
  "eventId": "a814187e-07a8-486a-b27b-2016335017e4",
  "deviceId": "device-sensor-042",
  "seq": 142,
  "type": "reading",
  "timestamp": "2026-10-25T12:05:30.123Z",
  "payload": {
    "temperature": 74.5,
    "battery": 88
  }
}
```

### Potential Responses:
- **HTTP 202 Accepted**: Ingested and queued successfully.
  ```json
  {
    "status": "accepted",
    "eventId": "a814187e-07a8-486a-b27b-2016335017e4",
    "receivedAt": "2026-10-25T12:05:30.245Z"
  }
  ```
- **HTTP 200 OK (`status: "duplicate"`)**: Event was already received and processed.
  ```json
  {
    "status": "duplicate",
    "eventId": "a814187e-07a8-486a-b27b-2016335017e4",
    "message": "Duplicate event, already received"
  }
  ```
- **HTTP 400 Bad Request**: Validation failed (saved to `rejected_events`).
  ```json
  {
    "error": "Validation failed",
    "details": [{"message": "seq must be a number", "path": ["seq"]}]
  }
  ```
- **HTTP 401 Unauthorized**: Missing or invalid `x-api-key`.
- **HTTP 429 Too Many Requests**: Per-device rate limit exceeded or ingestion queue backpressure active (`code: "queue_full"` or `"rate_limited"`).

---

## 4. Batch Event Ingestion (`POST /v1/events/batch`)

Used during reconnection bursts after an offline period to efficiently replay buffered telemetry.

```http
POST /v1/events/batch HTTP/1.1
Content-Type: application/json
x-api-key: fleet_36ff8d96135686ae831aa984663dce3f08e44d56a0f7440e

{
  "events": [
    {
      "eventId": "b1111111-0000-0000-0000-000000000001",
      "deviceId": "device-sensor-042",
      "seq": 143,
      "type": "reading",
      "timestamp": "2026-10-25T12:06:00.000Z",
      "replayed": true,
      "payload": { "temperature": 75.1 }
    },
    {
      "eventId": "b1111111-0000-0000-0000-000000000002",
      "deviceId": "device-sensor-042",
      "seq": 144,
      "type": "reading",
      "timestamp": "2026-10-25T12:06:10.000Z",
      "replayed": true,
      "payload": { "temperature": 76.4 }
    }
  ]
}
```

### Per-Event Results Response (HTTP 200 OK)
The batch endpoint processes in parallel chunks and returns an array of granular per-event outcomes matching the index order of the input array:

```json
{
  "status": "batch_processed",
  "summary": {
    "total": 2,
    "accepted": 2,
    "duplicate": 0,
    "rejected": 0
  },
  "results": [
    {
      "status": "accepted",
      "eventId": "b1111111-0000-0000-0000-000000000001"
    },
    {
      "status": "accepted",
      "eventId": "b1111111-0000-0000-0000-000000000002"
    }
  ]
}
```

If individual events within a batch fail schema validation or are duplicate, the batch still completes with HTTP 200, isolating failures:
```json
{
  "status": "batch_processed",
  "summary": {
    "total": 3,
    "accepted": 1,
    "duplicate": 1,
    "rejected": 1
  },
  "results": [
    { "status": "accepted", "eventId": "ev-01" },
    { "status": "duplicate", "eventId": "ev-02", "message": "Duplicate event, already received" },
    { "status": "rejected", "eventId": "ev-03", "error": "Validation failed", "details": ["payload is required"] }
  ]
}
```

---

## 5. Idempotency & Deduplication Semantics

1. **Authoritative Unique Key**:
   - The platform enforces a durable unique constraint on `events.eventId` in MongoDB.
   - Any insertion attempt of an already-existing `eventId` raises MongoDB error `E11000`.
   - The API catches this error and returns HTTP 200 with `status: "duplicate"`.
2. **Fast-Path Redis Cache**:
   - On successful insertion, the server sets `event_seen:<eventId>` with a 24-hour TTL.
   - If Redis is cleared, restarts, or evicts the key under memory pressure, the MongoDB unique index guarantees that duplicates remain 100% ignored.
3. **Reprocessing Idempotency**:
   - The worker background consumer checks `eventDoc.processingStatus === 'completed'` before processing rules. If an event job is redelivered by BullMQ, it is immediately skipped with zero duplicate side effects.

---

## 6. Retry & Backpressure Semantics

Devices transmitting telemetry must implement the following retry policies:

### 1. HTTP 429 Too Many Requests
- Occurs when:
  - **Rate Limit**: Device exceeds requests per window (`code: "rate_limited"`).
  - **Queue Backpressure**: BullMQ queue depth exceeds `MAX_QUEUE_DEPTH` (`code: "queue_full"`).
- **Behavior**:
  - The response includes a standard `Retry-After: <seconds>` header.
  - The device **must** pause transmissions for the duration specified in `Retry-After` (defaulting to 1–2 seconds if header is missing) plus random jitter before retrying.

### 2. HTTP 5xx Server Errors & Network Failures
- If the server returns a 5xx error (e.g. 500, 502, 503 Service Unavailable) or an HTTP connection timeout occurs:
  - The device must **never drop the event**.
  - Events must remain stored in local buffer memory and persisted to disk (`.simulator-buffer.json`).
  - Retry with **exponential backoff and random jitter**:
    $$\text{delay} = \min(1000 \times 2^{\text{attempt}} + \text{jitter}, 60000)$$

### 3. Buffer Deletion Guarantee
- Buffered events are removed from local storage **only after** the server accepts them (`status: "accepted"` or `"duplicate"`).
- Events flagged as `"duplicate"` or `"rejected"` within a 200 batch result are counted as delivered and purged from the buffer so the device does not get stuck in an infinite retry loop.

---

## 7. The `replayed` Flag & Stale Incident Isolation

When devices recover from an offline outage and dump buffered data:
1. Replayed events must set `"replayed": true` in the JSON payload (or have a generation `timestamp` older than 5 minutes relative to server `receivedAt`).
2. **Rules Processing**: Replayed telemetry triggers threshold alert rules (e.g. overspeed or temperature spikes that occurred while offline). Resulting incidents are marked `fromReplay: true`.
3. **Liveness Isolation**: Replayed telemetry **does not update device `lastSeenAt`** and does **not resolve open stale incidents**.
4. **Auto-Resolution**: Open stale incidents auto-resolve only when fresh, non-replayed live telemetry (`replayed: false`) arrives.
