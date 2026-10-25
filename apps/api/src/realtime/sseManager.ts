import type { Request, Response } from 'express';
import crypto from 'node:crypto';
import {
  type RealtimeMessage,
  createRedisClient,
  createDedicatedRedisClient,
  REALTIME_STREAM_KEY,
  REALTIME_PUBSUB_CHANNEL,
  type Redis
} from '@fleet/config';
import { createLogger } from '@fleet/logger';

const logger = createLogger({ service: 'sse-manager' });

export class SSEClient {
  public readonly id: string;
  private res: Response;
  private req: Request;
  private isAlive: boolean = true;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Rate limiting / coalescing for event_ingested: at most 10 per second per client
  private eventsSentThisSecond: number = 0;
  private windowResetTimer: NodeJS.Timeout | null = null;
  private queuedEvents: RealtimeMessage[] = [];

  constructor(id: string, req: Request, res: Response, onClose: () => void) {
    this.id = id;
    this.req = req;
    this.res = res;

    // Reset 1-second rate limit window every 1000ms and flush queued coalesced events
    this.windowResetTimer = setInterval(() => {
      this.eventsSentThisSecond = 0;
      this.flushQueuedEvents();
    }, 1000);

    // Heartbeat comment every 15 seconds: ": heartbeat\n\n"
    this.heartbeatTimer = setInterval(() => {
      this.sendComment('heartbeat');
    }, 15000);

    // Clean up on disconnect
    req.on('close', () => {
      this.close();
      onClose();
    });

    req.on('error', () => {
      this.close();
      onClose();
    });
  }

  public send(msg: RealtimeMessage): void {
    if (!this.isAlive) return;

    // Critical messages: incidents and device status ALWAYS delivered immediately and never dropped
    if (msg.event !== 'event_ingested') {
      this.writeMessage(msg);
      return;
    }

    // High rate throttling for event_ingested: coalesce to at most 10 per second per client
    if (this.eventsSentThisSecond < 10) {
      this.eventsSentThisSecond++;
      this.writeMessage(msg);
    } else {
      // Buffer latest coalesced events for next window (bounded to avoid memory buildup)
      if (this.queuedEvents.length < 50) {
        this.queuedEvents.push(msg);
      }
    }
  }

  private flushQueuedEvents(): void {
    if (!this.isAlive || !this.queuedEvents.length) return;

    while (this.queuedEvents.length > 0 && this.eventsSentThisSecond < 10) {
      const nextMsg = this.queuedEvents.shift();
      if (nextMsg) {
        this.eventsSentThisSecond++;
        this.writeMessage(nextMsg);
      }
    }
  }

  public writeRaw(chunk: string): void {
    if (!this.isAlive) return;
    try {
      this.res.write(chunk);
    } catch {
      this.close();
    }
  }

  public writeMessage(msg: { id?: number | string; event: string; data: Record<string, unknown> }): void {
    if (!this.isAlive) return;
    try {
      const idLine = msg.id !== undefined ? `id: ${msg.id}\n` : '';
      const eventLine = `event: ${msg.event}\n`;
      const dataLine = `data: ${JSON.stringify(msg.data)}\n\n`;
      this.res.write(`${idLine}${eventLine}${dataLine}`);
    } catch {
      this.close();
    }
  }

  public sendComment(comment: string): void {
    if (!this.isAlive) return;
    try {
      this.res.write(`: ${comment}\n\n`);
    } catch {
      this.close();
    }
  }

  public close(): void {
    if (!this.isAlive) return;
    this.isAlive = false;

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.windowResetTimer) clearInterval(this.windowResetTimer);

    this.queuedEvents = [];
    try {
      this.res.end();
    } catch {
      // ignore
    }
  }
}

export class SSEManager {
  private clients: Map<string, SSEClient> = new Map();
  private redisSub: Redis | null = null;
  private redisQuery: Redis | null = null;
  private isSubscribed: boolean = false;

  constructor() {
    this.initSubscriber();
  }

  private initSubscriber(): void {
    if (this.isSubscribed) return;

    try {
      this.redisSub = createDedicatedRedisClient();
      this.redisQuery = createRedisClient();

      this.redisSub.subscribe(REALTIME_PUBSUB_CHANNEL, (err) => {
        if (err) {
          logger.error({ err: err.message }, 'Failed to subscribe to realtime pubsub channel');
        } else {
          this.isSubscribed = true;
          logger.info('📡 SSEManager subscribed to Redis pub/sub channel for live streaming');
        }
      });

      this.redisSub.on('message', (_channel, messageStr) => {
        try {
          const msg = JSON.parse(messageStr) as RealtimeMessage;
          this.broadcast(msg);
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Failed to parse SSE pubsub message');
        }
      });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to initialize SSEManager subscriber');
    }
  }

  public getConnectedClientCount(): number {
    return this.clients.size;
  }

  public broadcast(msg: RealtimeMessage): void {
    for (const client of this.clients.values()) {
      client.send(msg);
    }
  }

  public async handleConnection(req: Request, res: Response): Promise<void> {
    // 1. Set proper SSE and CORS headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': req.headers.origin || '*',
      'Access-Control-Allow-Credentials': 'true'
    });
    res.flushHeaders?.();

    const lastEventIdHeader = req.headers['last-event-id'] || req.query.lastEventId;

    // 2. Handle reconnection with Last-Event-ID
    if (lastEventIdHeader !== undefined && lastEventIdHeader !== '') {
      const lastId = parseInt(String(lastEventIdHeader), 10);
      if (!isNaN(lastId) && this.redisQuery) {
        try {
          // Check oldest retained entry in stream
          const oldest = await this.redisQuery.xrange(REALTIME_STREAM_KEY, '-', '+', 'COUNT', 1);

          if (oldest && oldest.length > 0) {
            const oldestId = parseInt(oldest[0][0].split('-')[0], 10);

            if (lastId < oldestId) {
              // Requested ID is older than retained log -> send resync_required
              res.write(
                `event: resync_required\ndata: ${JSON.stringify({
                  message: 'Log truncated, resync required',
                  lastRetainedId: oldestId
                })}\n\n`
              );
            } else {
              // Replay missed messages from stream (> lastId)
              const missed = await this.redisQuery.xrange(
                REALTIME_STREAM_KEY,
                `(${lastId}-0`,
                '+'
              );

              for (const entry of missed) {
                const entryIdStr = entry[0];
                const fields = entry[1];
                let msgId = parseInt(entryIdStr.split('-')[0], 10);
                let msgEvent = 'message';
                let msgData = {};

                for (let i = 0; i < fields.length; i += 2) {
                  const key = fields[i];
                  const val = fields[i + 1];
                  if (key === 'id') msgId = parseInt(val, 10);
                  if (key === 'event') msgEvent = val;
                  if (key === 'data') {
                    try {
                      msgData = JSON.parse(val);
                    } catch {
                      msgData = { raw: val };
                    }
                  }
                }

                res.write(`id: ${msgId}\nevent: ${msgEvent}\ndata: ${JSON.stringify(msgData)}\n\n`);
              }
            }
          }
        } catch (streamErr: any) {
          logger.warn({ err: streamErr.message }, 'Error checking stream backlog on reconnect');
        }
      }
    }

    // 3. Register client for live stream
    const clientId = crypto.randomUUID();
    const client = new SSEClient(clientId, req, res, () => {
      this.clients.delete(clientId);
      logger.debug({ clientId, activeClients: this.clients.size }, 'SSE client disconnected');
    });

    this.clients.set(clientId, client);
    logger.debug({ clientId, activeClients: this.clients.size }, 'SSE client connected');
  }

  public async close(): Promise<void> {
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();

    if (this.redisSub) {
      await this.redisSub.quit().catch(() => {});
      this.redisSub = null;
    }
    if (this.redisQuery) {
      await this.redisQuery.quit().catch(() => {});
      this.redisQuery = null;
    }
  }
}

export const sseManager = new SSEManager();
