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
});
