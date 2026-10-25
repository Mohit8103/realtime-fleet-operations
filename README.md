# Real-Time Fleet Operations Platform

A platform for monitoring a fleet of devices in real time. Devices send events over HTTP, a rules engine turns them into incidents, and operators work those incidents from a live dashboard.

The core reliability idea is **at-least-once delivery combined with idempotent processing**. Duplicates, out-of-order events, offline buffering with burst replay, worker restarts and a failing notification service are all handled through `eventId` deduplication, MongoDB unique indexes (including a partial unique index for incidents), a transactional outbox for notifications, and a Server-Sent Events (SSE) stream that clients can resume with `Last-Event-ID`.

[Architecture](docs/ARCHITECTURE.md) | [Reliability](docs/RELIABILITY.md) | [Decisions](docs/DECISIONS.md) | [Limitations](docs/LIMITATIONS.md)

---

## Reviewer Quick Start

You need Node.js 20 or newer, plus two free cloud databases (no Docker required).

1. **Clone and install**
   ```bash
   git clone https://github.com/Mohit8103/assesment.git
   cd assesment
   npm install
   ```
2. **Create a MongoDB Atlas database.** Create a free [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) M0 cluster. Under *Network Access*, allow access from anywhere (`0.0.0.0/0`). Under *Database Access*, create a user whose password uses **letters and numbers only**, then copy the connection string (`mongodb+srv://...`).
3. **Create a Redis Cloud database.** Create a free [Redis Cloud](https://redis.io/cloud/) database. Copy the public endpoint (`<host>:<port>`) and the default user's password, and build the URL `redis://default:<password>@<host>:<port>` (use `rediss://` if TLS is enabled).
4. **Configure the environment.** Copy the template and paste both URLs into it:
   ```bash
   cp .env.example .env        # PowerShell: Copy-Item .env.example .env
   ```
5. **Seed the database.** This creates the indexes, two default rules and one operator.
   ```bash
   npm run reset-data
   ```
   > **Warning:** `reset-data` deletes all data in the database named in `MONGO_URL` and clears the Redis queue, stream and counters. Only use it against a throwaway database.
6. **Start everything** (API, worker and dashboard):
   ```bash
   npm run dev
   ```
7. **Open the dashboard** at [http://localhost:5173](http://localhost:5173). The banner at the top should say it is connected.
8. **Run the offline and replay demo** in a second terminal:
   ```bash
   npm run demo:offline
   ```

---

## Prerequisites

- **Node.js** 20 or newer and **npm** 10 or newer.
- **MongoDB**: a free Atlas M0 cluster (or a local MongoDB 7.0).
- **Redis**: a free Redis Cloud database (or a local Redis 7.2).
- *(Optional)* Docker and Docker Compose. The native Node setup above is the main path.

> **Security:** never commit real connection strings. Keep credentials in the local `.env` file, which is ignored by git. `.env.example` contains placeholders only.

---

## Configuration

```env
# MongoDB Atlas connection string
MONGO_URL=mongodb+srv://<username>:<password>@<cluster-host>/fleet_ops?retryWrites=true&w=majority

# Redis Cloud connection URL (use rediss:// if TLS is required)
REDIS_URL=redis://default:<password>@<host>:<port>

NODE_ENV=development
API_PORT=3000
WORKER_HEALTH_PORT=3001
WEB_PORT=5173
CORS_ORIGIN=http://localhost:5173
```

If a password contains reserved characters such as `@`, `:` or `#`, URL-encode them (`@` becomes `%40`, `#` becomes `%23`), or simply use an alphanumeric password.

The API and the worker check both databases at startup and exit with a clear message naming the failing service if one is unreachable.

To run the services separately instead of `npm run dev`:

```bash
npm run dev:api         # API gateway on http://localhost:3000
npm run dev:worker      # Worker on http://localhost:3001 (health port)
npm run dev:web         # Dashboard on http://localhost:5173
```

---

## Dashboard

- **Connection banner:** shows connected, reconnecting or offline. During an interruption the last known data stays on screen and the stream resumes with `Last-Event-ID`.
- **Overview:** device status counts, open incidents by severity, events per minute, queue depth, notification status and a recent activity feed.
- **Devices:** status badge (online, stale or offline), location, last seen time and last sequence number. Click a device to see its recent events.
- **Live Events:** streaming feed capped at 200 rows, with pause/resume and device and type filters.
- **Incidents:** filter by state, view the timeline, triggering events and the rule evaluation reason, and Acknowledge or Resolve (with optimistic updates and rollback on error).

---

## Rules

Rules are managed through the REST API; there is no rules page in the dashboard. `npm run reset-data` seeds two rules: a temperature threshold rule (`High Heat Alert`) and a 30-second no-report rule (`Stale Device Alert`).

```bash
# List rules
curl http://localhost:3000/v1/rules

# Create a threshold rule
curl -X POST http://localhost:3000/v1/rules \
  -H "Content-Type: application/json" \
  -d '{"name":"Very High Heat","type":"threshold","severity":"critical","enabled":true,"cooldownSeconds":0,"conditions":{"metric":"temperature","operator":">","value":90,"deviceFilter":{"type":"all"}}}'

# Create a rule that fires when a device reports a given event type
curl -X POST http://localhost:3000/v1/rules \
  -H "Content-Type: application/json" \
  -d '{"name":"Device Error Reported","type":"type_match","severity":"high","enabled":true,"cooldownSeconds":0,"conditions":{"eventType":"error","deviceFilter":{"type":"all"}}}'
```

Rule names are unique; creating a duplicate returns `409 Conflict`. To see why a rule did or did not fire for an event, call `GET /v1/events/<eventId>/evaluations`.

---

## Demos and Simulator

The simulator (`apps/simulator`) generates device traffic. All scenarios run against the local API.

```bash
npm run demo:normal     # 3 devices, steady traffic
npm run demo:offline    # 3 devices, offline after 20s for 90s, then replay
npm run demo:burst      # 1 device, 300 events sent at once
npm run demo:chaos      # 5 devices with duplicates, out-of-order, malformed payloads and anomalies
```

### What to watch in the offline demo

If you ran the simulator before, delete `.simulator-keys.json` and `.simulator-buffer.json` first so devices register cleanly.

1. **0s to 20s:** the devices send readings and heartbeats and show as online.
2. **20s to 110s (offline window):** the devices stop sending and buffer events in memory and in `.simulator-buffer.json`. The console shows `state: offline` with `buffered` climbing (roughly 270 to 300 events). About 30 seconds after each device's last event, the stale detector opens one `Stale Device Alert` incident per device.
3. **After 110s (replay):** the simulator reconnects, shows `state: replaying`, and sends the buffer in batches of 50 to `POST /v1/events/batch` with `replayed: true`. Replayed events keep their original timestamps and do not mark a device as healthy. Once the buffer reaches 0, live sending resumes, `lastSeenAt` updates, and the open stale incidents auto-resolve (`resolvedBy: "system:auto-resolve"`).

---

## Tests

```bash
npm test
```

- `npm test` runs against an **already-running local stack**: the API, the worker and both databases must be up.
- It takes roughly 4 to 5 minutes, because it exercises reconnects, rate limits, bursts, concurrency and SSE disconnects.
- It **writes test data into the database**. Run `npm run reset-data` afterwards (same warning as above) to return to a clean state.

Individual suites:

```bash
npm run test:unit          # health and readiness unit tests
npm run test:acceptance    # ingestion, dedupe, rejection, queue backpressure
npm run test:phase2        # rules engine, evaluations, sweeper, replay handling
npm run test:phase3        # incidents, dedupe under concurrency, outbox, dispatcher
npm run test:phase4        # SSE, Last-Event-ID resume, multi-instance fan-out
```

Results and what each scenario proves are in [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

---

## Health Checks

| Service | Port | Endpoint | Purpose |
| :--- | :--- | :--- | :--- |
| API | 3000 | `GET /healthz` | Liveness |
| API | 3000 | `GET /readyz` | Readiness: MongoDB and Redis (2s timeout each) |
| Worker | 3001 | `GET /healthz` | Liveness |
| Worker | 3001 | `GET /readyz` | Readiness: MongoDB, Redis and the BullMQ queue |

Operational endpoints: `GET /v1/stats`, `GET /v1/activity`, `GET /v1/admin/failed-events`, `POST /v1/admin/failed-events/:id/retry`, `GET /v1/admin/rejected-events`.

---

## Docker (optional)

```bash
docker compose up --build     # start the stack
docker compose down -v        # stop and remove volumes
```

---

## Documentation

- [System Architecture](docs/ARCHITECTURE.md): components, data flow, and the offline replay sequence.
- [Device Ingestion Protocol](docs/PROTOCOL.md): event schema, batch endpoint, idempotency and retry semantics.
- [Architecture Decisions](docs/DECISIONS.md): alternatives considered and trade-offs.
- [Reliability and Failure Handling](docs/RELIABILITY.md): each failure scenario, the behavior, where it is implemented and how it is tested.
- [Known Limitations](docs/LIMITATIONS.md): what is not solved and why.
- [Deployment Guide](docs/DEPLOYMENT.md): how this would be deployed, monitored and scaled for a real client.
- [Test Report](docs/TEST_REPORT.md): scenarios, results and timings.
