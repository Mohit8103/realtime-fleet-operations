import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { config } from '@fleet/config';
import { createLogger, createHttpLoggerMiddleware } from '@fleet/logger';
import { healthRouter } from './routes/health.js';
import { devicesRouter } from './routes/devices.js';
import { eventsRouter } from './routes/events.js';
import { rulesRouter } from './routes/rules.js';
import { adminRouter } from './routes/admin.js';
import { incidentsRouter } from './routes/incidents.js';
import { operatorsRouter } from './routes/operators.js';
import { notificationsRouter } from './routes/notifications.js';
import { mockWebhookRouter, mockWebhookAdminRouter } from './routes/mockWebhook.js';

export const logger = createLogger({ service: 'api' });

export function createApp(): Express {
  const app = express();

  // Security & Cross-Origin
  app.use(helmet());
  app.use(
    cors({
      origin: config.api.corsOrigin,
      credentials: true
    })
  );

  // JSON Body Parsing
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Handle broken JSON payloads before reaching route handlers
  app.use(async (err: any, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      try {
        const { RejectedEvent } = await import('./models/rejectedEvent.js');
        await RejectedEvent.create({
          rawPayload: err.body ?? null,
          deviceId: (req.headers['x-device-id'] as string) || null,
          reason: `Malformed JSON: ${err.message}`,
          receivedAt: new Date()
        });
      } catch {
        // ignore persistence error to ensure clean 400 response
      }

      return res.status(400).json({
        error: 'Malformed JSON payload',
        message: err.message
      });
    }
    next(err);
  });

  // Correlation ID and structured request logger
  app.use(createHttpLoggerMiddleware(logger));

  // Health probe (exposed at root /healthz and /api/healthz)
  app.use('/', healthRouter);
  app.use('/api', healthRouter);

  // V1 Core Ingestion & Operations APIs (mount at both /v1 and /api/v1)
  app.use('/v1/devices', devicesRouter);
  app.use('/api/v1/devices', devicesRouter);

  app.use('/v1/events', eventsRouter);
  app.use('/api/v1/events', eventsRouter);

  app.use('/v1/rules', rulesRouter);
  app.use('/api/v1/rules', rulesRouter);

  app.use('/v1/incidents', incidentsRouter);
  app.use('/api/v1/incidents', incidentsRouter);

  app.use('/v1/operators', operatorsRouter);
  app.use('/api/v1/operators', operatorsRouter);

  app.use('/v1/notifications', notificationsRouter);
  app.use('/api/v1/notifications', notificationsRouter);

  app.use('/mock', mockWebhookRouter);
  app.use('/v1/admin', mockWebhookAdminRouter);
  app.use('/api/v1/admin', mockWebhookAdminRouter);

  app.use('/v1/admin', adminRouter);
  app.use('/api/v1/admin', adminRouter);

  // Fallback 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'Not Found',
      path: req.originalUrl,
      correlationId: req.correlationId
    });
  });

  // Global Error Handler
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    req.log?.error({ err: err.message }, 'Unhandled application error');
    res.status(500).json({
      error: 'Internal Server Error',
      correlationId: req.correlationId
    });
  });

  return app;
}
