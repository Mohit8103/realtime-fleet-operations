# Deployment and Operations Guide

This runbook provides complete instructions for launching, verifying, and developing the Real-Time Operations Platform.

---

## 1. System Requirements

- **Containerized Run**:
  - Docker Desktop or Docker Engine `>= 24.0`
  - Docker Compose v2 (`docker compose`)
- **Local Native Run** (optional):
  - Node.js `>= 20.0.0` (LTS recommended, tested on Node 22/24)
  - npm `>= 10.0.0`

---

## 2. Quickstart with Docker Compose

To start all services (MongoDB, Redis, API Gateway, Background Worker, and Web Dashboard) in orchestrated order:

```bash
# Clone the repository and navigate to root
cd fleet-operations-platform

# Copy the environment file template
cp .env.example .env

# Build and start all services in detached mode
docker compose up --build -d

# Follow unified logs across all containers
docker compose logs -f
```

---

## 3. Health Check Verification

Once containers are started, verify that each service is healthy and responding to its `/healthz` probe.

### 3.1 API Gateway Probe
```bash
curl -i http://localhost:3000/healthz
```
**Expected Response (HTTP 200 OK)**:
```json
{
  "status": "ok",
  "service": "api",
  "uptime": 12.45,
  "timestamp": "2026-10-25T02:00:00.000Z",
  "environment": "development",
  "correlationId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### 3.2 Background Worker Probe
```bash
curl -i http://localhost:3001/healthz
```
**Expected Response (HTTP 200 OK)**:
```json
{
  "status": "ok",
  "service": "worker",
  "uptime": 11.23,
  "timestamp": "2026-10-25T02:00:00.000Z",
  "environment": "development",
  "concurrency": 5
}
```

### 3.3 Web Dashboard Probe
```bash
curl -i http://localhost:5173/healthz
```
**Expected Response (HTTP 200 OK)**:
```json
{
  "status": "ok",
  "service": "web",
  "timestamp": "2026-10-25T02:00:00.000Z"
}
```

### 3.4 Web Dashboard UI
Open your browser and navigate to:
```text
http://localhost:5173
```
You will see the **Fleet Ops Platform Mission Control** dashboard showing green status indicators for the API Gateway, Worker Engine, MongoDB, and Redis.

---

## 4. Local Development (Without Docker for Node Services)

For rapid iteration, you can run MongoDB and Redis in Docker while running the Node.js services directly on your host machine:

### Step 1: Start only databases
```bash
docker compose up -d mongo redis
```

### Step 2: Install dependencies
```bash
npm install
```

### Step 3: Run services concurrently or independently
```bash
# Start API Gateway (runs on :3000 with hot reload)
npm run dev:api

# Start Background Worker (runs on :3001 with hot reload)
npm run dev:worker

# Start Web Dashboard (runs on :5173 with Vite HMR)
npm run dev:web

# Run Simulator CLI test
npm run dev:simulator -- --devices 5 --interval 2000
```

---

## 5. Testing & Verification

Run the Vitest test suite across all packages and services:

```bash
# Run all tests once
npm test

# Run tests in interactive watch mode
npm run test:watch
```

---

## 6. Environment Variables Reference

| Variable | Description | Default |
| :--- | :--- | :--- |
| `NODE_ENV` | Application runtime environment (`development`, `production`, `test`) | `development` |
| `LOG_LEVEL` | Minimum log level (`debug`, `info`, `warn`, `error`) | `info` |
| `API_PORT` | HTTP port for Express API Gateway | `3000` |
| `API_HOST` | Network interface binding for API | `0.0.0.0` |
| `CORS_ORIGIN` | Allowed origin for frontend requests | `http://localhost:5173` |
| `WORKER_HEALTH_PORT` | HTTP port for Worker health probe | `3001` |
| `WORKER_CONCURRENCY` | Maximum concurrent jobs processed per worker instance | `5` |
| `WEB_PORT` | Frontend HTTP port | `5173` |
| `VITE_API_BASE_URL` | Base URL used by React frontend to call the API | `http://localhost:3000` |
| `MONGO_URL` | MongoDB connection URI (e.g. MongoDB Atlas `mongodb+srv://...`) | `mongodb://localhost:27017/fleet_ops` |
| `MONGO_URI` | MongoDB connection URI alias | (Fallback to `MONGO_URL`) |
| `MONGO_DATABASE` | MongoDB database name | `fleet_ops` |
| `REDIS_URL` | Redis connection URI with TLS support (e.g. Upstash `rediss://...`) | (Optional, overrides host/port) |
| `REDIS_HOST` | Redis hostname (for local / Docker instances) | `localhost` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password (if applicable) | `""` |
| `STALE_DEVICE_THRESHOLD_SECONDS`| Time in seconds before an inactive device is marked stale | `60` |

---

## 7. Teardown & Troubleshooting

### Stopping Containers
```bash
# Stop containers while preserving database volumes
docker compose down

# Stop containers and remove all persistent database volumes
docker compose down -v
```

### Port Conflicts
If port `3000`, `3001`, `5173`, `27017`, or `6379` is already in use on your host machine:
1. Adjust the conflicting port mapping in `docker-compose.yml` or `.env`.
2. Ensure no rogue MongoDB or Redis instances are running on standard ports.
