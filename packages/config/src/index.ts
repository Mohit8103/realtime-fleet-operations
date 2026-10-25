import dotenv from 'dotenv';
import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';

function loadDotenv() {
  let curr = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(curr, '.env');
    if (fs.existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
    const parent = path.dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  dotenv.config();
}

loadDotenv();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // API Service
  API_PORT: z.coerce.number().default(3000),
  API_HOST: z.string().default('0.0.0.0'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Worker Service
  WORKER_HEALTH_PORT: z.coerce.number().default(3001),
  WORKER_PORT: z.coerce.number().optional(),
  WORKER_CONCURRENCY: z.coerce.number().default(5),

  // Web Service
  WEB_PORT: z.coerce.number().default(5173),
  VITE_API_BASE_URL: z.string().default('http://localhost:3000'),

  // MongoDB - Supports MONGO_URL (e.g. MongoDB Atlas) or MONGO_URI
  MONGO_URL: z.string().optional(),
  MONGO_URI: z.string().optional(),
  MONGO_DATABASE: z.string().default('fleet_ops'),

  // Redis - Supports REDIS_URL (e.g. Upstash rediss://...) or REDIS_HOST + REDIS_PORT
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().default('localhost'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_PASSWORD: z.string().optional().default(''),

  // Operations Rules & Thresholds
  STALE_DEVICE_THRESHOLD_SECONDS: z.coerce.number().default(60),
  METRIC_ANOMALY_CPU_PERCENT: z.coerce.number().default(90),
  METRIC_ANOMALY_MEMORY_PERCENT: z.coerce.number().default(90),

  // Queue Backpressure
  MAX_QUEUE_DEPTH: z.coerce.number().default(5000),

  // Incident Management & Notifications
  AUTO_RESOLVE_STALE: z.coerce.boolean().default(true),
  MAX_NOTIFY_ATTEMPTS: z.coerce.number().default(5),
  MOCK_WEBHOOK_URL: z.string().default('http://localhost:3000/mock/webhook'),

  // Dashboard Authentication (optional, for browser EventSource and status APIs)
  DASHBOARD_TOKEN: z.string().optional()
});

export type RawEnv = z.infer<typeof envSchema>;

function loadConfig() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const errorMessages = result.error.errors.map(
      (err) => `${err.path.join('.')}: ${err.message}`
    ).join('\n');
    console.error('❌ Invalid environment configuration:\n' + errorMessages);
    throw new Error('Environment validation failed');
  }

  const raw = result.data;
  const mongoUri = raw.MONGO_URL || raw.MONGO_URI || 'mongodb://localhost:27017/fleet_ops';
  const redisUrl = raw.REDIS_URL || undefined;

  return {
    isProduction: raw.NODE_ENV === 'production',
    isTest: raw.NODE_ENV === 'test',
    isDevelopment: raw.NODE_ENV === 'development',
    env: raw.NODE_ENV,
    logLevel: raw.LOG_LEVEL,
    api: {
      port: raw.API_PORT,
      host: raw.API_HOST,
      corsOrigin: raw.CORS_ORIGIN
    },
    worker: {
      healthPort: raw.WORKER_PORT ?? raw.WORKER_HEALTH_PORT,
      concurrency: raw.WORKER_CONCURRENCY
    },
    web: {
      port: raw.WEB_PORT,
      apiBaseUrl: raw.VITE_API_BASE_URL
    },
    mongo: {
      url: mongoUri,
      uri: mongoUri,
      database: raw.MONGO_DATABASE
    },
    redis: {
      url: redisUrl,
      host: raw.REDIS_HOST,
      port: raw.REDIS_PORT,
      password: raw.REDIS_PASSWORD || undefined,
      isTls: Boolean(redisUrl && redisUrl.startsWith('rediss://'))
    },
    fleet: {
      staleDeviceThresholdSeconds: raw.STALE_DEVICE_THRESHOLD_SECONDS,
      anomalyCpuPercent: raw.METRIC_ANOMALY_CPU_PERCENT,
      anomalyMemoryPercent: raw.METRIC_ANOMALY_MEMORY_PERCENT,
      autoResolveStale: raw.AUTO_RESOLVE_STALE
    },
    notifications: {
      maxAttempts: raw.MAX_NOTIFY_ATTEMPTS,
      mockWebhookUrl: raw.MOCK_WEBHOOK_URL
    },
    dashboardToken: raw.DASHBOARD_TOKEN || undefined,
    maxQueueDepth: raw.MAX_QUEUE_DEPTH,
    redisMemory: {
      sseMaxLen: 500,
      bullMqJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 }
      }
    }
  };
}

export const config = loadConfig();
export type Config = ReturnType<typeof loadConfig>;
export * from './redis.js';
export * from './realtime.js';

