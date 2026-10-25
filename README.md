# Real-Time Fleet Operations Platform

[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green.svg)](https://nodejs.org/)
[![Docker Compose](https://img.shields.io/badge/Docker-Compose%20v2-blue.svg)](https://docs.docker.com/compose/)
[![Architecture](https://img.shields.io/badge/Docs-Architecture%20%26%20ADRs-blueviolet.svg)](docs/ARCHITECTURE.md)

An event-driven **Real-Time Operations Platform** for device fleet telemetry monitoring, rules evaluation, incident orchestration, and live operations dashboarding.

Built with a focus on **reliability, predictable latency, fault-tolerance, and deep observability**.

---

## 🛠️ Stack & Technologies

- **Runtime & Language**: Node.js 22 / 24, TypeScript (ESM)
- **Monorepo**: npm Workspaces (`apps/*`, `packages/*`)
- **API Service**: Express 5, Helmet, CORS, Server-Sent Events (SSE)
- **Background Worker**: BullMQ, Redis 7.2, Stale Device Scheduler
- **Frontend Dashboard**: React 18, Vite 6, JetBrains Mono & Inter typography
- **Database & Cache**: MongoDB 7.0, Redis 7.2
- **Simulator**: Node CLI tool (`apps/simulator`)
- **Logging & Tracing**: Pino JSON logger with `x-correlation-id` and `AsyncLocalStorage` tracing
- **Orchestration**: Docker Compose with container health checks and dependencies
- **Testing**: Vitest, Supertest

---

## 📁 Repository Structure

```text
├── apps/
│   ├── api/             # HTTP ingestion, REST endpoints, SSE live stream (:3000)
│   ├── worker/          # BullMQ consumers, stale scheduler, incident dispatcher (:3001)
│   ├── web/             # React + Vite operations dashboard (:5173)
│   └── simulator/       # Device fleet telemetry simulator CLI
├── packages/
│   ├── config/          # Centralized Zod-validated environment config (@fleet/config)
│   └── logger/          # Structured Pino JSON logger with Correlation IDs (@fleet/logger)
├── docs/
│   ├── ARCHITECTURE.md  # System architecture, event pipelines, and guarantees
│   ├── DECISIONS.md     # Architecture Decision Records (ADRs)
│   └── DEPLOYMENT.md    # Deployment runbook, health checks, and local dev
├── docker-compose.yml   # Multi-container orchestration (Mongo, Redis, API, Worker, Web)
└── vitest.config.ts     # Root test runner configuration
```

---

## 🚀 Quick Start (Docker Compose)

Start all services with a single command:

```bash
docker compose up --build
```

All 5 core services will start in dependency order:
1. `fleet_mongo` (`:27017`) - MongoDB 7.0
2. `fleet_redis` (`:6379`) - Redis 7.2
3. `fleet_api` (`:3000`) - Express Ingestion & REST API
4. `fleet_worker` (`:3001`) - BullMQ Background Worker
5. `fleet_web` (`:5173`) - React Vite Dashboard

---

## 🩺 Service Health Verification

Each service includes a standardized `/healthz` endpoint:

| Service | Port | Endpoint | Health Probe Command |
| :--- | :--- | :--- | :--- |
| **API Gateway** | `3000` | `/healthz` | `curl http://localhost:3000/healthz` |
| **Worker Engine** | `3001` | `/healthz` | `curl http://localhost:3001/healthz` |
| **Web Dashboard** | `5173` | `/healthz` | `curl http://localhost:5173/healthz` |
| **Mission Control UI** | `5173` | `/` | Open in browser: `http://localhost:5173` |

### Sample API `/healthz` Response:
```json
{
  "status": "ok",
  "service": "api",
  "uptime": 5.12,
  "timestamp": "2026-10-25T02:00:00.000Z",
  "environment": "development",
  "correlationId": "4a71b262-e64e-4f70-bfe5-1cb6b38cbbde"
}
```

---

## 💻 Local Development (Without Docker)

You can run databases in Docker and Node services natively on your machine:

```bash
# 1. Start MongoDB and Redis containers
docker compose up -d mongo redis

# 2. Install workspace dependencies
npm install

# 3. Run individual services in parallel terminals
npm run dev:api         # Starts API on http://localhost:3000
npm run dev:worker      # Starts Worker on http://localhost:3001
npm run dev:web         # Starts Web on http://localhost:5173

# 4. Run simulator CLI
npm run dev:simulator -- --devices 10 --interval 1000
```

---

## ☁️ Connecting to Cloud Databases (MongoDB Atlas & Upstash Redis)

If you do not have Docker installed or prefer managed cloud services, the platform natively reads `MONGO_URL` and `REDIS_URL` from your `.env` via `@fleet/config`.

### 1. MongoDB Atlas Configuration
Create a MongoDB Atlas cluster, retrieve your connection URI, and set `MONGO_URL` in `.env`:

```env
MONGO_URL=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/fleet_ops?retryWrites=true&w=majority
```
- `@fleet/config` automatically resolves `MONGO_URL` (with backward compatibility for `MONGO_URI`).
- No local MongoDB daemon or container is required.

### 2. Upstash Redis Configuration
Create a serverless Redis database on [Upstash](https://upstash.com/), copy the standard Redis TLS URI (`rediss://...`), and set `REDIS_URL` in `.env`:

```env
REDIS_URL=rediss://default:<password>@<endpoint>.upstash.io:6379
```
- `@fleet/config` detects `REDIS_URL` and flags TLS encryption (`isTls: true`) for `rediss://` protocols.
- Setting `REDIS_URL` automatically takes precedence over `REDIS_HOST` and `REDIS_PORT`.
- BullMQ and ioredis connect directly through the encrypted TLS tunnel.

### 3. Start Services with Cloud Datastores
With `.env` populated, start the services without Docker:

```bash
npm run dev:api        # Terminal 1
npm run dev:worker     # Terminal 2
npm run dev:web        # Terminal 3
```

---

## 🧪 Running Tests

Execute unit and integration tests across the workspace:

```bash
npm test
```

---

## ⚠️ Known Limitations & Edge Cases

- **Redis Lua Script `cjson` Serialization Quirk**:
  - The atomic publication Lua script (`ATOMIC_PUBLISH_LUA` in `@fleet/config`) decodes and re-encodes event payloads using Redis's built-in `cjson` library to guarantee atomic stream ID allocation and Pub/Sub fanout.
  - In Lua tables, empty associative dictionaries cannot be distinguished from empty arrays, so `cjson` encodes `{}` as `[]`. If an event or telemetry payload contains an empty object (`{}`), it will appear on the live SSE stream as `[]`. Objects with keys are serialized normally.

---

## 📚 Detailed Documentation

- [System Architecture](docs/ARCHITECTURE.md) - Event pipelines, reliability guarantees, and observability design
- [Architecture Decisions (ADRs)](docs/DECISIONS.md) - Trade-off analysis and rationale for technical choices
- [Deployment & Operations Guide](docs/DEPLOYMENT.md) - Runbooks, environment variables, and verification

