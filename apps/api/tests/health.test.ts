import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('API Health Probe', () => {
  const app = createApp();

  it('GET /healthz returns 200 OK with service status and correlationId', async () => {
    const response = await request(app).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body).toHaveProperty('service', 'api');
    expect(response.body).toHaveProperty('uptime');
    expect(response.body).toHaveProperty('correlationId');
    expect(response.headers).toHaveProperty('x-correlation-id');
  });

  it('preserves client-provided x-correlation-id header', async () => {
    const customCorrelationId = 'custom-test-trace-id-12345';
    const response = await request(app)
      .get('/healthz')
      .set('x-correlation-id', customCorrelationId);

    expect(response.status).toBe(200);
    expect(response.body.correlationId).toBe(customCorrelationId);
    expect(response.headers['x-correlation-id']).toBe(customCorrelationId);
  });

  it('GET /readyz returns 200 or 503 with per-dependency readiness status', async () => {
    const response = await request(app).get('/readyz');

    expect([200, 503]).toContain(response.status);
    expect(response.body).toHaveProperty('dependencies');
    expect(response.body.dependencies).toHaveProperty('mongo');
    expect(response.body.dependencies).toHaveProperty('redis');
  });
});
