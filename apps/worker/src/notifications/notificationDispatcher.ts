import { Notification, type INotification } from '@fleet/database';
import { config } from '@fleet/config';
import { createLogger } from '@fleet/logger';

const logger = createLogger({ service: 'notification-dispatcher' });

export interface NotifierResult {
  success: boolean;
  error?: string;
}

/**
 * Pluggable notifier sending notification to mock webhook and console.
 * Sends Idempotency-Key header to ensure idempotent delivery.
 */
export async function sendNotification(notification: INotification): Promise<NotifierResult> {
  // 1. Console notifier
  logger.info(
    {
      notificationId: notification.notificationId,
      incidentId: notification.incidentId,
      operatorId: notification.operatorId,
      attempt: notification.attempts + 1
    },
    '📢 Dispatching incident notification'
  );

  // 2. Webhook notifier
  try {
    const response = await fetch(config.notifications.mockWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': notification.notificationId
      },
      body: JSON.stringify({
        notificationId: notification.notificationId,
        incidentId: notification.incidentId,
        operatorId: notification.operatorId,
        payload: notification.payload,
        timestamp: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return {
        success: false,
        error: `Webhook returned status ${response.status}: ${errText}`
      };
    }

    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: `Network/Webhook error: ${err.message}`
    };
  }
}

/**
 * Atomically claim next pending/retryable notification.
 * Uses findOneAndUpdate with lease timeout to guarantee that concurrent workers
 * never dispatch the same notification twice.
 */
export async function claimNextNotification(
  leaseTimeoutMs = 30000,
  filter?: Record<string, unknown>
): Promise<INotification | null> {
  const now = new Date();
  const leaseUntil = new Date(Date.now() + leaseTimeoutMs);

  return Notification.findOneAndUpdate(
    {
      ...(filter || {}),
      $or: [
        {
          status: { $in: ['pending', 'failed'] },
          nextAttemptAt: { $lte: now }
        },
        {
          status: 'sending',
          lockedUntil: { $lt: now } // Expired lease recovery after worker crash
        }
      ]
    },
    {
      $set: {
        status: 'sending',
        lockedUntil: leaseUntil
      }
    },
    { new: true }
  );
}

/**
 * Process a single notification delivery and update outbox status with exponential backoff & jitter.
 */
export async function processNotification(notification: INotification): Promise<boolean> {
  const result = await sendNotification(notification);

  if (result.success) {
    notification.status = 'sent';
    notification.sentAt = new Date();
    notification.lockedUntil = null;
    notification.lastError = null;
    await notification.save();

    logger.info(
      { notificationId: notification.notificationId, incidentId: notification.incidentId },
      '✅ Notification successfully delivered'
    );
    return true;
  }

  // Delivery failed - handle retry with exponential backoff and jitter
  const attempts = notification.attempts + 1;
  notification.attempts = attempts;
  notification.lockedUntil = null;
  notification.lastError = result.error || 'Unknown dispatch error';

  if (attempts >= notification.maxAttempts) {
    notification.status = 'dead';
    logger.error(
      {
        notificationId: notification.notificationId,
        incidentId: notification.incidentId,
        attempts,
        maxAttempts: notification.maxAttempts,
        error: notification.lastError
      },
      '💀 Notification marked DEAD after reaching max retry attempts'
    );
  } else {
    // Exponential backoff with jitter: min(1000 * 2^attempts + random(500), 60000)
    const baseDelay = 1000 * Math.pow(2, attempts);
    const jitter = Math.floor(Math.random() * 500);
    const delayMs = Math.min(baseDelay + jitter, 60000);

    notification.status = 'failed';
    notification.nextAttemptAt = new Date(Date.now() + delayMs);

    logger.warn(
      {
        notificationId: notification.notificationId,
        attempts,
        nextAttemptInMs: delayMs,
        error: notification.lastError
      },
      '⚠️ Notification failed; scheduled for retry'
    );
  }

  await notification.save();
  return false;
}

/**
 * Run a single dispatcher batch tick.
 */
export async function dispatchBatch(maxBatch = 10): Promise<number> {
  let dispatched = 0;

  for (let i = 0; i < maxBatch; i++) {
    const item = await claimNextNotification();
    if (!item) break;

    await processNotification(item);
    dispatched++;
  }

  return dispatched;
}

/**
 * Start the background polling dispatcher loop.
 */
export function setupNotificationDispatcher(pollIntervalMs = 2000) {
  let isRunning = false;

  const timer = setInterval(async () => {
    if (isRunning) return;
    isRunning = true;

    try {
      await dispatchBatch(10);
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error in notification dispatcher cycle');
    } finally {
      isRunning = false;
    }
  }, pollIntervalMs);

  return {
    stop: () => clearInterval(timer),
    tick: () => dispatchBatch(10)
  };
}
