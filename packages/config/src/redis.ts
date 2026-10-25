import { Redis, type RedisOptions } from 'ioredis';
import { config } from './index.js';

let sharedClient: Redis | null = null;

export function createDedicatedRedisClient(customOptions?: RedisOptions): Redis {
  const baseOptions: RedisOptions = {
    maxRetriesPerRequest: null, // Required by BullMQ
    connectTimeout: 4000,
    lazyConnect: true,
    retryStrategy(times) {
      if (times > 2) {
        return null; // Stop retrying fast on failure to prevent hanging
      }
      return Math.min(times * 150, 500);
    },
    ...customOptions
  };

  const client = config.redis.url
    ? new Redis(config.redis.url, baseOptions)
    : new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        ...baseOptions
      });

  client.on('error', () => {
    // Avoid unhandled error event spam when connection checks handle errors explicitly
  });

  return client;
}

export function getSharedRedisClient(): Redis {
  if (!sharedClient || sharedClient.status === 'end') {
    sharedClient = createDedicatedRedisClient();
  }
  return sharedClient;
}

export function createRedisClient(customOptions?: RedisOptions): Redis {
  if (customOptions && Object.keys(customOptions).length > 0) {
    return createDedicatedRedisClient(customOptions);
  }
  return getSharedRedisClient();
}

export async function verifyRedisConnection(client?: Redis, timeoutMs = 4000): Promise<Redis> {
  const redis = client || createRedisClient();
  let lastError: any = null;

  redis.on('error', (err: any) => {
    lastError = err;
  });

  const timeoutPromise = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Connection timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
  });

  try {
    if (redis.status !== 'ready' && redis.status !== 'connecting') {
      await Promise.race([redis.connect(), timeoutPromise]);
    }
    await Promise.race([redis.ping(), timeoutPromise]);
    return redis;
  } catch (err: any) {
    try {
      redis.disconnect();
    } catch {
      // ignore
    }
    const message = lastError?.message || err?.message || String(err);
    throw new Error(`[Redis Error] ${message}`);
  }
}

export { Redis, type RedisOptions };
