import crypto from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { createRedisClient, createDedicatedRedisClient, publishRealtimeEvent } from '@fleet/config';
import {
  Device,
  Rule,
  Incident,
  RuleEvaluation,
  calculateDeviceStatus
} from '@fleet/database';
import { createLogger } from '@fleet/logger';
import { matchesDeviceFilter } from './rulesEngine.js';
import { recordIncidentMatch } from './incidentManager.js';

const logger = createLogger({ service: 'stale-detector' });

export function setupStaleDeviceDetector() {
  const redis = createRedisClient();
  const queue = new Queue('stale-detection-queue', { connection: redis });

  // Register repeatable job every 5 seconds with fixed jobId to prevent double-firing
  queue
    .add(
      'scan-stale-devices',
      {},
      {
        repeat: { every: 5000 },
        jobId: 'stale-device-scanner',
        removeOnComplete: true,
        removeOnFail: true
      }
    )
    .catch((err) => {
      logger.warn({ err: err.message }, 'Failed to schedule stale device repeatable job');
    });

  const worker = new Worker(
    'stale-detection-queue',
    async () => {
      try {
        await executeStaleScan();
      } catch (err: any) {
        logger.error({ err: err.message }, 'Error during stale device scan');
      }
    },
    {
      connection: createDedicatedRedisClient(),
      concurrency: 1
    }
  );

  worker.on('error', (err) => {
    logger.warn({ err: err.message }, 'Stale detector worker error');
  });

  return { queue, worker };
}

export async function executeStaleScan(): Promise<void> {
  const devices = await Device.find({}).lean();
  if (!devices.length) return;

  const staleRules = await Rule.find({ type: 'no_report', enabled: true }).lean();

  for (const device of devices) {
    // 1. Dynamically compute device status from lastSeenAt
    const currentStatus = calculateDeviceStatus(device.lastSeenAt);
    if (device.status !== currentStatus) {
      const oldStatus = device.status;
      await Device.updateOne(
        { _id: device._id },
        { $set: { status: currentStatus } }
      );
      publishRealtimeEvent({
        event: 'device_status_changed',
        data: {
          deviceId: device.deviceId,
          oldStatus,
          newStatus: currentStatus,
          timestamp: new Date().toISOString()
        }
      }).catch(() => {});
    }

    if (!staleRules.length || !device.lastSeenAt) continue;

    const diffSeconds = (Date.now() - new Date(device.lastSeenAt).getTime()) / 1000;

    // 2. Evaluate no_report rules
    for (const rule of staleRules) {
      const conditions = rule.conditions as any;
      if (!matchesDeviceFilter(conditions.deviceFilter, device as any)) {
        continue;
      }

      const thresholdSeconds = conditions.seconds ?? conditions.durationSeconds;

      if (diffSeconds > thresholdSeconds) {
        const dedupeKey = `${String(rule._id)}:${device.deviceId}`;
        const existingOpen = await Incident.findOne({
          dedupeKey,
          state: { $in: ['open', 'acknowledged'] }
        });

        if (existingOpen) {
          // Storage hygiene: do not write a new evaluation record for a stale-rule check
          // that is suppressed because an incident is already open; increment a counter on the incident instead.
          await Incident.updateOne(
            { _id: existingOpen._id },
            { $inc: { suppressedStaleChecksCount: 1, occurrenceCount: 1 } }
          );
          continue;
        }

        // Verify fresh lastSeenAt from DB to prevent racing with recently arrived events
        const freshDev = await Device.findOne({ deviceId: device.deviceId }, { lastSeenAt: 1 }).lean();
        if (freshDev?.lastSeenAt) {
          const freshDiff = (Date.now() - new Date(freshDev.lastSeenAt).getTime()) / 1000;
          if (freshDiff <= thresholdSeconds) {
            continue;
          }
        }

        // Suppression 2: Cooldown (if configured)
        if (rule.cooldownSeconds > 0) {
          const lastInc = await Incident.findOne({
            deviceId: device.deviceId,
            ruleId: String(rule._id)
          })
            .sort({ createdAt: -1 })
            .lean();

          if (lastInc) {
            const elapsed = (Date.now() - new Date(lastInc.createdAt).getTime()) / 1000;
            if (elapsed < rule.cooldownSeconds) {
              await RuleEvaluation.create({
                eventId: null,
                ruleId: String(rule._id),
                ruleName: rule.name,
                deviceId: device.deviceId,
                matched: true,
                reason: 'suppressed: cooldown',
                evaluatedAt: new Date()
              });
              continue;
            }
          }
        }

        const reason = `Device ${device.deviceId} has not reported for ${Math.round(diffSeconds)}s (threshold: ${thresholdSeconds}s)`;

        // Atomically upsert incident with partial unique index guarantee
        const { incident, isCreated } = await recordIncidentMatch({
          rule: rule as any,
          device: device as any,
          event: null,
          isReplay: false,
          matchReason: reason
        });

        if (isCreated) {
          logger.warn(
            { deviceId: device.deviceId, rule: rule.name, diffSeconds },
            '⏰ Stale device incident created'
          );

          await RuleEvaluation.create({
            eventId: null,
            ruleId: String(rule._id),
            ruleName: rule.name,
            deviceId: device.deviceId,
            matched: true,
            reason,
            evaluatedAt: new Date()
          });
        }
      }
    }
  }
}
