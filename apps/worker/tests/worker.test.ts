import { describe, it, expect, afterAll } from 'vitest';
import http from 'node:http';
import { createLogger } from '@fleet/logger';
import { startHealthServer, type HealthServerInstance } from '../src/healthServer.js';

describe('Worker Health Server', () => {
  const testLogger = createLogger({ service: 'worker-test' });
  let healthInstance: HealthServerInstance;
  const testPort = 3099;

  afterAll(async () => {
    if (healthInstance) {
      await healthInstance.close();
    }
  });

  it('responds to GET /healthz with 200 OK and worker metadata', async () => {
    healthInstance = startHealthServer(testLogger, testPort);

    const data = await new Promise<{ status: string; service: string }>((resolve, reject) => {
      http.get(`http://localhost:${testPort}/healthz`, (res) => {
        expect(res.statusCode).toBe(200);
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => resolve(JSON.parse(raw)));
        res.on('error', reject);
      });
    });

    expect(data.status).toBe('ok');
    expect(data.service).toBe('worker');
  });
});
