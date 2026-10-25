# Real-Time Fleet Operations Platform

[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Architecture](https://img.shields.io/badge/Docs-Architecture-blueviolet.svg)](docs/ARCHITECTURE.md)
[![Test Report](https://img.shields.io/badge/Docs-Test%20Report-success.svg)](docs/TEST_REPORT.md)

An enterprise-grade, event-driven **Real-Time Operations Platform** for device fleet telemetry monitoring, rules evaluation, incident orchestration, and live operations dashboarding.

Built with a focus on **operational reliability, predictable latency, fault-tolerance, and deep observability**.

---

## 📋 Prerequisites

- **Node.js**: Version `20.0.0` or higher (tested on Node 20, 22, and 24).
- **npm**: Version `10.0.0` or higher.
- **MongoDB**: A free [MongoDB Atlas](https://www.mongodb.com/cloud/atlas) M0 cluster (or local MongoDB 7.0).
- **Redis**: A free [Upstash Redis](https://upstash.com/) or [Redis Cloud](https://redis.io/cloud/) database (or local Redis 7.2).
- *(Optional)* **Docker & Docker Compose**: Docker is secondary and optional; all services can run locally via native Node.js.

> [!CAUTION]
> **Security Notice**: Never commit real database connection strings or credentials to source control. Always store credentials in a local `.env` file, which is ignored by git.

---

## ⚙️ Setup & Installation

### 1. Clone & Install Dependencies
```bash
# Clone repository
git clone https://github.com/Mohit8103/assesment.git
cd assesment

# Install workspace dependencies
npm install
```

### 2. Configure Environment Variables
Copy the template environment file:
```bash
cp .env.example .env
```

Edit `.env` and configure your cloud database endpoints:
```env
# MongoDB Atlas Connection URI
MONGO_URL=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/fleet_ops?retryWrites=true&w=majority

# Upstash Redis / Redis Cloud Connection URI (with TLS)
REDIS_URL=rediss://default:<password>@<endpoint>.upstash.io:6379

# Service Ports & Host Bindings
NODE_ENV=development
API_PORT=3000
WORKER_HEALTH_PORT=3001
WEB_PORT=5173
CORS_ORIGIN=http://localhost:5173
```

### 3. Seed Database
Initialize default operational rules and primary operators:
```bash
npm run seed
```

### 4. Start Local Development Stack
Start the API gateway, background worker, and React dashboard concurrently:
```bash
npm run dev
```

Alternatively, run each service in separate terminals for dedicated logs:
```bash
npm run dev:api         # Terminal 1: API Gateway on http://localhost:3000
npm run dev:worker      # Terminal 2: Worker Daemon on http://localhost:3001
npm run dev:web         # Terminal 3: React Dashboard on http://localhost:5173
```

---

## 🖥️ Operations Mission Control Dashboard

Open your web browser and navigate to:
```text
http://localhost:5173
```

The mission-control UI features:
- **Connection Status Banner**: Visible live indicator (`connected`, `reconnecting`, `offline`).
- **Overview Tab**: Live stat cards (`devices online/stale/offline`, `open incidents by severity`, `events/min`, `queue depth`, `failed notifications`) and recent activity audit log.
- **Devices Tab**: Real-time fleet registry with status badges, location, last seen timestamp, and last sequence number. Click any device to inspect its recent events.
- **Live Events Tab**: Realtime Server-Sent Events (SSE) feed capped at 200 rows with pause/resume controls and type/device filtering.
- **Incidents Tab**: Filterable incident management interface with state badges, triggering events, explainability audit reasons, and optimistic `Acknowledge` and `Resolve` actions.

---

## 🎮 Running Demos & Simulator Scenarios

The platform includes an automated device simulator (`apps/simulator`) with realistic network scenarios:

```bash
# 1. Normal Steady Telemetry (3 devices, 1 event/sec)
npm run demo:normal

# 2. Offline Disconnection & Burst Replay (3 devices, offline after 20s for 90s)
npm run demo:offline

# 3. Burst Stress Test (1 device, 300 events fired instantly)
npm run demo:burst

# 4. Chaos Scenario (5 devices with duplicates, out-of-order, malformations, and anomalies)
npm run demo:chaos
```

### What to Watch For in the Offline Demo (`npm run demo:offline`)
1. **0s – 20s (Live Sending)**: All 3 devices stream regular readings and heartbeats. Dashboard shows devices as `online` with events updating smoothly.
2. **20s – 110s (Offline Window)**:
   - Devices stop transmitting over HTTP and buffer events in local memory and disk (`.simulator-buffer.json`).
   - The simulator console shows `state: offline` and `buffered` climbing.
   - After ~60 seconds of inactivity, the worker's stale detector triggers and flags devices as `stale`, opening `Manual Stale` incidents on the dashboard.
3. **110s+ (Replay & Recovery)**:
   - Simulator reconnects and displays `state: replaying`.
   - Buffered events are drained in sequential batches of 50 via `POST /v1/events/batch` with `replayed: true`.
   - Replayed events preserve their original historical generation timestamps and do **not** falsely mark devices online.
   - Once the buffer decrements to `0`, live sending resumes (`state: online`), fresh events update `lastSeenAt`, and the open stale incidents **auto-resolve automatically** (`resolvedBy: "system:auto-resolve"`).

---

## 🧪 Running Tests & Test Data Cleanup

The platform features a consolidated end-to-end failure scenario test suite:

```bash
npm test
```

> [!IMPORTANT]
> **Prerequisites for Running Tests**:
> - `npm test` runs against an **already-running local stack** (`api` on `:3000`, `worker` on `:3001`, and both MongoDB and Redis reachable).
> - The consolidated test run takes **roughly 5 minutes** (`~258 seconds`) because it exercises real-world timeouts, rate limits, 500-event bursts, concurrency stress tests, and SSE disconnect cycles.
> - The test run writes synthetic devices, incidents, and events into the database.

### Database Cleanup After Testing
To reset your database to a pristine demo state after running tests:
```bash
# 1. Drop test collections via helper script
npx tsx scripts/cleanup.ts

# 2. Re-seed default operational rules and operators
npm run seed
```

### Individual Test Suites
```bash
npm run test:unit          # Vitest unit tests (API & Worker health/readiness probes)
npm run test:acceptance    # Phase 1: Ingestion, dedupe, rejection, queue backpressure
npm run test:phase2        # Phase 2: Rules engine, evaluations, sweeper, replay isolation
npm run test:phase3        # Phase 3: Incidents, deduplication, outbox atomicity, dispatcher
npm run test:phase4        # Phase 4: Realtime SSE, Last-Event-ID, multi-instance fan-out
```

Detailed test proofs and results are documented in [docs/TEST_REPORT.md](docs/TEST_REPORT.md).

---

## 🩺 Service Health Probes

Both services expose standard liveness and deep readiness endpoints:

| Service | Port | Endpoint | Description | Verification Command |
| :--- | :--- | :--- | :--- | :--- |
| **API** | `3000` | `GET /healthz` | Cheap, non-blocking liveness check | `curl http://localhost:3000/healthz` |
| **API** | `3000` | `GET /readyz` | Deep readiness: MongoDB & Redis (2s timeout) | `curl http://localhost:3000/readyz` |
| **Worker** | `3001` | `GET /healthz` | Cheap, non-blocking liveness check | `curl http://localhost:3001/healthz` |
| **Worker** | `3001` | `GET /readyz` | Deep readiness: Mongo, Redis, & BullMQ Queue | `curl http://localhost:3001/readyz` |

---

## 🐳 Docker Deployment (Optional)

If preferred, Docker Compose can orchestrate the entire platform with local MongoDB and Redis:

```bash
# Build and run all containers
docker compose up --build

# Tear down containers and volumes
docker compose down -v
```

---

## 📚 Technical Documentation

- [System Architecture](docs/ARCHITECTURE.md) - Architecture diagrams, sequence flows, and component specs.
- [Device Ingestion Protocol](docs/PROTOCOL.md) - Payload schema, batch formats, headers, and retry semantics.
- [Architecture Decisions (ADRs)](docs/DECISIONS.md) - Technical rationale, trade-off analysis, and alternatives.
- [Reliability & Failure Recovery](docs/RELIABILITY.md) - Failure scenarios, recovery mechanisms, and testing matrix.
- [Known Limitations](docs/LIMITATIONS.md) - Transparent assessment of trade-offs, constraints, and edge cases.
- [Production Deployment Guide](docs/DEPLOYMENT.md) - Kubernetes, ECS, MQTT gateway, CDN, and autoscaling.
- [Automated Test Report](docs/TEST_REPORT.md) - Verified test results, proof analysis, and execution timings.
