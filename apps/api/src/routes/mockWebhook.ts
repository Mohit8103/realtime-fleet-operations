import { Router, type Request, type Response } from 'express';
import { createRedisClient } from '@fleet/config';

export const mockWebhookRouter = Router();
const redis = createRedisClient();

let inMemoryFailToggle = false;

export async function isMockWebhookFailing(): Promise<boolean> {
  try {
    const val = await redis.get('mock_webhook_fail');
    if (val !== null) return val === 'true' || val === '1';
  } catch {
    // fallback to memory
  }
  return inMemoryFailToggle;
}

export async function setMockWebhookFailing(fail: boolean): Promise<void> {
  inMemoryFailToggle = fail;
  try {
    await redis.set('mock_webhook_fail', fail ? 'true' : 'false');
  } catch {
    // fallback
  }
}

// POST /mock/webhook - Mock webhook receiving notifications
mockWebhookRouter.post('/webhook', async (req: Request, res: Response) => {
  const shouldFail = await isMockWebhookFailing();
  const idempotencyKey = req.headers['idempotency-key'] as string;

  if (shouldFail) {
    req.log?.warn({ idempotencyKey, body: req.body }, '🚨 Mock webhook simulated failure triggered by admin toggle');
    return res.status(500).json({
      error: 'Mock webhook forced failure by admin toggle',
      status: 'failed'
    });
  }

  req.log?.info({ idempotencyKey, notificationId: req.body?.notificationId }, '✅ Mock webhook received notification');
  return res.status(200).json({
    status: 'received',
    idempotencyKey: idempotencyKey || null,
    receivedAt: new Date().toISOString()
  });
});

// Admin toggle router
export const mockWebhookAdminRouter = Router();

mockWebhookAdminRouter.post('/mock-webhook', async (req: Request, res: Response) => {
  const fail = Boolean(req.body?.fail);
  await setMockWebhookFailing(fail);

  req.log?.info({ fail }, 'Mock webhook failure toggle updated');
  return res.status(200).json({
    status: 'ok',
    fail
  });
});

mockWebhookAdminRouter.get('/mock-webhook', async (_req: Request, res: Response) => {
  const fail = await isMockWebhookFailing();
  return res.status(200).json({ fail });
});
