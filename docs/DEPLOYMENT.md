# Deployment and Operations Guide

This runbook provides complete instructions for launching, verifying, and developing the Real-Time Operations Platform locally, along with enterprise production deployment guidelines for cloud environments.

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

## 3. Health & Readiness Verification

Verify that each service is healthy and all backing dependencies (MongoDB, Redis, BullMQ) are operational.

### 3.1 API Gateway Probes
```bash
# Liveness probe (HTTP 200 OK)
curl -i http://localhost:3000/healthz

# Readiness probe (HTTP 200 OK with dependency checks)
curl -i http://localhost:3000/readyz
```
**Sample `/readyz` Response**:
```json
{
  "status": "ok",
  "service": "api",
  "timestamp": "2026-10-25T19:00:00.000Z",
  "dependencies": {
    "mongodb": { "status": "ok", "latencyMs": 14 },
    "redis": { "status": "ok", "latencyMs": 8 }
  }
}
```

### 3.2 Background Worker Probes
```bash
# Liveness probe (HTTP 200 OK)
curl -i http://localhost:3001/healthz

# Readiness probe (HTTP 200 OK with dependency & queue checks)
curl -i http://localhost:3001/readyz
```
**Sample `/readyz` Response**:
```json
{
  "status": "ok",
  "service": "worker",
  "timestamp": "2026-10-25T19:00:00.000Z",
  "dependencies": {
    "mongodb": { "status": "ok", "latencyMs": 15 },
    "redis": { "status": "ok", "latencyMs": 9 },
    "queue": { "status": "ok", "waiting": 0, "active": 0 }
  }
}
```

### 3.3 Web Dashboard UI
Open your browser and navigate to:
```text
http://localhost:5173
```
The **Fleet Ops Platform Mission Control** dashboard provides real-time streaming telemetry, device inventory, incident triage, and connection banners.

---

## 4. Local Development (Without Docker for Node Services)

For rapid iteration, run MongoDB and Redis in Docker while running the Node.js services directly on your host machine:

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

Run the unified test suite across all packages and services:

```bash
# Run all test suites (unit + scenario suites against local stack)
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
| `MONGO_DATABASE` | MongoDB database name | `fleet_ops` |
| `REDIS_URL` | Redis connection URI with TLS support (e.g. `rediss://...`) | (Optional, overrides host/port) |
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

---

## 8. Enterprise Production Deployment Reference

For deploying the platform in client production environments at scale, adopt the following architecture and operational practices.

### 8.1 Container Orchestration (AWS ECS / Kubernetes)
- **Deployment Topology**:
  - Deploy `apps/api` and `apps/worker` as decoupled, independently scalable workloads.
  - In Kubernetes (EKS/GKE): Use separate `Deployments` with distinct Horizontal Pod Autoscalers (HPA).
  - In AWS ECS: Use distinct ECS Services running on AWS Fargate with dedicated Task Definitions.
- **Resource Allocations**:
  - `apps/api`: High I/O, low-to-medium CPU (e.g., 1 vCPU, 2 GB RAM). Focus on connection capacity.
  - `apps/worker`: Compute and network bound (e.g., 2 vCPU, 4 GB RAM). Sized according to rule complexity and concurrency.

### 8.2 Managed Cloud Databases
- **MongoDB**:
  - Use **MongoDB Atlas M10+** (or enterprise self-managed replica sets) with a 3-node replica set spread across distinct Availability Zones.
  - Enable Continuous Cloud Backups with Point-in-Time Recovery (PITR) with 7-day retention.
  - Enforce TLS 1.3 encryption in transit and AES-256 encryption at rest.
- **Redis**:
  - Use **AWS ElastiCache for Redis**, **MemoryDB**, or **Redis Enterprise Cloud**.
  - Configure Multi-AZ with automatic failover and read replicas if query scaling is required.
  - Enable Redis persistence via AOF (everysec) or daily RDB snapshots.

### 8.3 Load Balancer & Reverse Proxy Configuration for SSE
Server-Sent Events (SSE) maintain long-lived HTTP streaming connections that require specific load balancer adjustments:
- **AWS ALB (Application Load Balancer)**:
  - Set **Idle Timeout** to `>= 3600 seconds` (1 hour) to prevent AWS from terminating active SSE streams.
  - Ensure HTTP/2 is enabled on the ALB listener for multiplexed browser connections.
- **NGINX / Reverse Proxy Headers**:
  ```nginx
  location /v1/stream {
      proxy_pass http://api_upstream;
      proxy_http_version 1.1;
      proxy_set_header Connection "";
      proxy_set_header Host $host;
      
      # Disable proxy response buffering (CRITICAL for real-time SSE)
      proxy_buffering off;
      proxy_cache off;
      proxy_read_timeout 3600s;
      proxy_send_timeout 3600s;
      chunked_transfer_encoding on;
  }
  ```

### 8.4 IoT Fleet Ingestion & MQTT Gateway
For massive IoT deployments (> 10,000 devices):
- **MQTT Gateway**: Position an MQTT broker (AWS IoT Core, EMQX, or HiveMQ) at the edge. Devices publish lightweight MQTT topics.
- **Bridge Worker**: An ingestion bridge service consumes MQTT messages, validates schemas, and pushes directly to the Redis BullMQ ingestion queue, avoiding HTTP handshake overhead per device telemetry tick.

### 8.5 Worker Scaling & KEDA Autoscaling
- Rather than scaling workers solely on CPU/memory utilization, use **KEDA (Kubernetes Event-driven Autoscaling)**.
- **KEDA Scaler**: Scale the `apps/worker` deployment based on BullMQ Redis queue depth (`fleet:events:queue:wait`).
  ```yaml
  apiVersion: keda.sh/v1alpha1
  kind: ScaledObject
  metadata:
    name: fleet-worker-scaler
  spec:
    scaleTargetRef:
      name: fleet-worker-deployment
    minReplicaCount: 2
    maxReplicaCount: 30
    triggers:
      - type: redis
        metadata:
          address: redis-cluster:6379
          listName: bull:fleet:events:queue:wait
          listLength: "500"
  ```

### 8.6 Frontend Web Hosting (CDN & Object Storage)
- Build the web dashboard for production:
  ```bash
  npm run build --workspace=apps/web
  ```
- Deploy the compiled static output (`apps/web/dist`) to **Amazon S3** fronted by **AWS CloudFront** (or Cloudflare / GCP Cloud Storage).
- Configure CloudFront error response to route `404` to `/index.html` (HTTP 200) for Single-Page Application (SPA) routing.
- Inject the API Gateway URL via runtime configuration (`/config.json`) or build-time environment variables (`VITE_API_BASE_URL`).

### 8.7 Secrets Management & Compliance
- **Zero Plaintext Secrets**: Never store database credentials, Redis connection strings, or webhook signing keys in repository code or `.env` files.
- **Integration**: Utilize **AWS Secrets Manager**, **HashiCorp Vault**, or **Kubernetes Secrets** with external-secrets-operator.
- Inject secrets into container runtimes as environment variables at task initialization time.

### 8.8 Production Observability & Recommended Prometheus/Grafana Alerts

Deploy Prometheus metrics scrapers and configure PagerDuty / Opsgenie alert rules for the following critical thresholds:

| Metric / Symptom | PromQL / Trigger Condition | Severity | Action Required |
| :--- | :--- | :--- | :--- |
| **API Ingestion Latency** | `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > 0.25` | Warning | Check Mongo write latency and connection pool saturation. |
| **Ingestion Queue Backlog** | `bullmq_queue_waiting{queue="fleet:events:queue"} > 1000` for 3m | High | KEDA worker scale-up failed or worker crash loop. |
| **Rate Limit Spikes** | `rate(http_requests_total{status="429"}[5m]) > 50` | Warning | Device flood or rogue simulator key sending without backoff. |
| **Outbox Failure Rate** | `rate(outbox_dispatch_errors_total[5m]) / rate(outbox_dispatched_total[5m]) > 0.05` | High | Remote notification webhook endpoints down; outbox retrying. |
| **Dead Notifications** | `increase(notifications_dead_letter_total[5m]) > 0` | Critical | Webhook permanently failed after 5 retries; inspect dead letter log. |
| **Service Crash / Restart** | `increase(process_start_time_seconds[15m]) > 3` | High | Investigate pod OOMKills or unhandled exception crashes. |

### 8.9 Disaster Recovery & Multi-Region Topology
- **Active-Passive Multi-Region**:
  - Primary Region (e.g. `us-east-1`): Full stack (API, Worker, Mongo Primary, Redis Primary).
  - Secondary Region (e.g. `us-west-2`): Standby API instances, MongoDB cross-region read replica, Redis read replica.
- **DNS Failover**: Use **AWS Route 53** latency-based routing with health check probes on `/readyz`. On primary region failure, fail over DNS and promote secondary replicas.
