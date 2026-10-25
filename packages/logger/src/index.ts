import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import pino, { type Logger, type LoggerOptions } from 'pino';
import { config } from '@fleet/config';

export interface LogContext {
  correlationId: string;
  [key: string]: unknown;
}

export const contextStorage = new AsyncLocalStorage<LogContext>();

export function getCorrelationId(): string | undefined {
  return contextStorage.getStore()?.correlationId;
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T, extra?: Record<string, unknown>): T {
  return contextStorage.run({ correlationId, ...extra }, fn);
}

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  pretty?: boolean;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  const isPretty = options.pretty ?? (config.isDevelopment && process.env.NODE_ENV !== 'test');

  const pinoOptions: LoggerOptions = {
    name: options.service,
    level: options.level || config.logLevel || 'info',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
      log(object) {
        const store = contextStorage.getStore();
        if (store?.correlationId && !object.correlationId) {
          return { correlationId: store.correlationId, ...object };
        }
        return object;
      }
    },
    base: {
      service: options.service,
      env: config.env,
      pid: process.pid
    }
  };

  if (isPretty) {
    return pino({
      ...pinoOptions,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
          ignore: 'pid,hostname'
        }
      }
    });
  }

  return pino(pinoOptions);
}

export const defaultLogger = createLogger({
  service: 'fleet-app'
});

export * from './middleware.js';
export type { Logger } from 'pino';
