import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { type Logger } from 'pino';
import { contextStorage } from './index.js';

declare global {
  namespace Express {
    interface Request {
      correlationId: string;
      log: Logger;
    }
  }
}

export function createHttpLoggerMiddleware(baseLogger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const rawHeader = req.headers['x-correlation-id'] || req.headers['x-request-id'];
    const correlationId = typeof rawHeader === 'string' && rawHeader.trim() !== ''
      ? rawHeader.trim()
      : crypto.randomUUID();

    req.correlationId = correlationId;
    res.setHeader('x-correlation-id', correlationId);

    const childLogger = baseLogger.child({
      correlationId,
      method: req.method,
      url: req.originalUrl || req.url,
      ip: req.ip
    });

    req.log = childLogger;

    const startTime = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      const statusCode = res.statusCode;

      const logData = {
        statusCode,
        durationMs,
        userAgent: req.headers['user-agent']
      };

      if (statusCode >= 500) {
        childLogger.error(logData, 'HTTP Request Failed');
      } else if (statusCode >= 400) {
        childLogger.warn(logData, 'HTTP Client Error');
      } else {
        childLogger.info(logData, 'HTTP Request Completed');
      }
    });

    contextStorage.run({ correlationId }, () => {
      next();
    });
  };
}
