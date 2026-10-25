import crypto from 'node:crypto';
import {
  Incident,
  Notification,
  Operator,
  Rule,
  Device,
  mongoose,
  type IIncident,
  type IDevice,
  type IEvent,
  type IRule
} from '@fleet/database';
import { config, publishRealtimeEvent } from '@fleet/config';
import { createLogger } from '@fleet/logger';

const logger = createLogger({ service: 'incident-manager' });

/**
 * Resolve operator for an incident:
 * 1. rule.notifyOperator if set and valid
 * 2. operator whose locations include device.location
 * 3. fallback to rule.notifyOperator or null
 */
export async function resolveOperatorId(rule: IRule, device: IDevice): Promise<string | null> {
  try {
    if (rule.notifyOperator) {
      const explicit = await Operator.findOne({ operatorId: rule.notifyOperator }).lean();
      if (explicit) return explicit.operatorId;
    }

    if (device.location) {
      const locationMatch = await Operator.findOne({ locations: device.location }).lean();
      if (locationMatch) return locationMatch.operatorId;
    }

    return rule.notifyOperator || null;
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to resolve operator for rule notification');
    return rule.notifyOperator || null;
  }
}

/**
 * Atomically create or update an incident for a rule match.
 * Guarantees at most ONE non-resolved incident per dedupeKey (ruleId:deviceId)
 * via MongoDB partial unique index and atomic findOneAndUpdate.
 */
export async function recordIncidentMatch(params: {
  rule: IRule;
  device: IDevice;
  event?: IEvent | null;
  isReplay: boolean;
  matchReason: string;
}): Promise<{ incident: IIncident; isCreated: boolean }> {
  const { rule, device, event, isReplay, matchReason } = params;
  const ruleId = String(rule._id);
  const dedupeKey = `${ruleId}:${device.deviceId}`;
  const eventId = event?.eventId || null;

  // 1. Try atomic update if a non-resolved incident already exists
  const existing = await Incident.findOneAndUpdate(
    {
      dedupeKey,
      state: { $in: ['open', 'acknowledged'] }
    },
    {
      $inc: { occurrenceCount: 1 },
      $set: {
        lastEventId: eventId,
        updatedAt: new Date()
      },
      ...(eventId
        ? {
            $push: {
              triggeringEvents: { $each: [eventId], $slice: -20 },
              timeline: {
                action: 'occurrence',
                timestamp: new Date(),
                note: matchReason
              }
            }
          }
        : {})
    },
    { new: true }
  );

  if (existing) {
    publishRealtimeEvent({ event: 'incident_updated', data: existing.toObject() }).catch(() => {});
    return { incident: existing, isCreated: false };
  }

  // 2. No non-resolved incident exists -> create a new one inside a single MongoDB transaction
  const operatorId = await resolveOperatorId(rule, device);
  const incidentId = crypto.randomUUID();

  const session = await mongoose.startSession();
  try {
    let createdIncident: IIncident | null = null;

    await session.withTransaction(async () => {
      const createdDocs = await Incident.create(
        [
          {
            incidentId,
            deviceId: device.deviceId,
            ruleId,
            ruleName: rule.name,
            dedupeKey,
            severity: rule.severity,
            state: 'open',
            fromReplay: isReplay,
            eventId,
            firstEventId: eventId,
            lastEventId: eventId,
            occurrenceCount: 1,
            triggeringEvents: eventId ? [eventId] : [],
            timeline: [
              {
                action: 'created',
                timestamp: new Date(),
                note: matchReason
              }
            ],
            createdAt: new Date()
          }
        ],
        { session }
      );
      createdIncident = createdDocs[0];

      // Write transactional outbox notification in the same transaction
      await Notification.create(
        [
          {
            notificationId: crypto.randomUUID(),
            incidentId,
            operatorId,
            status: 'pending',
            attempts: 0,
            maxAttempts: config.notifications.maxAttempts,
            nextAttemptAt: new Date(),
            idempotencyKey: crypto.randomUUID(),
            payload: {
              incidentId,
              ruleId,
              ruleName: rule.name,
              deviceId: device.deviceId,
              severity: rule.severity,
              reason: matchReason
            }
          }
        ],
        { session }
      );
    });

    publishRealtimeEvent({ event: 'incident_created', data: createdIncident!.toObject() }).catch(() => {});
    return { incident: createdIncident!, isCreated: true };
  } catch (err: any) {
    // 3. Handle concurrent race condition (E11000 duplicate key error)
    if (err.code === 11000 || String(err.message).includes('E11000')) {
      logger.debug({ dedupeKey }, 'Concurrent incident creation caught by partial unique index; retrying atomic update');

      const raced = await Incident.findOneAndUpdate(
        {
          dedupeKey,
          state: { $in: ['open', 'acknowledged'] }
        },
        {
          $inc: { occurrenceCount: 1 },
          $set: {
            lastEventId: eventId,
            updatedAt: new Date()
          },
          ...(eventId
            ? {
                $push: {
                  triggeringEvents: { $each: [eventId], $slice: -20 },
                  timeline: {
                    action: 'occurrence',
                    timestamp: new Date(),
                    note: matchReason
                  }
                }
              }
            : {})
        },
        { new: true }
      );

      if (raced) {
        publishRealtimeEvent({ event: 'incident_updated', data: raced.toObject() }).catch(() => {});
        return { incident: raced, isCreated: false };
      }
    }

    throw err;
  } finally {
    await session.endSession();
  }
}

/**
 * Auto-resolve open stale incidents when a fresh, non-replayed event arrives.
 * Replayed events never auto-resolve.
 */
export async function autoResolveStaleIncidents(device: IDevice, event: IEvent): Promise<number> {
  if (!config.fleet.autoResolveStale) return 0;
  if (event.replayed) return 0; // Invariant: Replayed events NEVER auto-resolve

  try {
    const staleRules = await Rule.find({ type: 'no_report' }).select('_id').lean();
    if (!staleRules.length) return 0;

    const staleRuleIds = staleRules.map((r) => String(r._id));

    const openStaleIncidents = await Incident.find({
      deviceId: device.deviceId,
      state: { $in: ['open', 'acknowledged'] },
      ruleId: { $in: staleRuleIds }
    });

    if (!openStaleIncidents.length) return 0;

    const now = new Date();
    for (const inc of openStaleIncidents) {
      inc.state = 'resolved';
      inc.resolvedAt = now;
      inc.resolvedBy = 'system:auto-resolve';
      inc.timeline.push({
        action: 'resolved',
        timestamp: now,
        operator: 'system:auto-resolve',
        note: `Stale incident auto-resolved on fresh event ${event.eventId} (seq: ${event.seq})`
      });
      await inc.save();

      publishRealtimeEvent({ event: 'incident_updated', data: inc.toObject() }).catch(() => {});

      logger.info(
        { incidentId: inc.incidentId, deviceId: device.deviceId, eventId: event.eventId },
        '✅ Stale incident auto-resolved by fresh incoming event'
      );
    }

    return openStaleIncidents.length;
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed during auto-resolve of stale incidents');
    return 0;
  }
}

/**
 * Outbox Repair Sweep:
 * Finds incidents in state 'open' created more than 30 seconds ago
 * that have no notification record in the outbox, and idempotently creates one.
 */
export async function repairOutboxSweep(olderThanMs = 30000): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanMs);

  try {
    const unnotifiedIncidents = await Incident.find({
      state: 'open',
      createdAt: { $lte: cutoff }
    });

    if (!unnotifiedIncidents.length) return 0;

    let repaired = 0;

    for (const incident of unnotifiedIncidents) {
      // Check if notification already exists for this incident
      const exists = await Notification.exists({ incidentId: incident.incidentId });
      if (exists) continue;

      // Find rule and device to resolve operator
      let operatorId: string | null = null;
      try {
        const isOid = mongoose.Types.ObjectId.isValid(incident.ruleId);
        const [ruleDoc, deviceDoc] = await Promise.all([
          isOid ? Rule.findById(incident.ruleId).lean() : Rule.findOne({ name: incident.ruleName }).lean(),
          Device.findOne({ deviceId: incident.deviceId }).lean()
        ]);
        if (ruleDoc && deviceDoc) {
          operatorId = await resolveOperatorId(ruleDoc as any, deviceDoc as any);
        } else if (ruleDoc?.notifyOperator) {
          operatorId = ruleDoc.notifyOperator;
        }
      } catch (opErr: any) {
        logger.debug({ err: opErr.message }, 'Could not resolve operator for repaired incident notification');
      }

      try {
        await Notification.create({
          notificationId: crypto.randomUUID(),
          incidentId: incident.incidentId,
          operatorId,
          status: 'pending',
          attempts: 0,
          maxAttempts: config.notifications.maxAttempts,
          nextAttemptAt: new Date(),
          idempotencyKey: crypto.randomUUID(),
          payload: {
            incidentId: incident.incidentId,
            ruleId: incident.ruleId,
            ruleName: incident.ruleName,
            deviceId: incident.deviceId,
            severity: incident.severity,
            reason: incident.reason || incident.timeline?.[0]?.note || 'Repaired outbox notification'
          }
        });
        repaired++;
        logger.info(
          { incidentId: incident.incidentId },
          '🔧 Outbox repair sweep created missing notification record'
        );
      } catch (createErr: any) {
        // E11000 duplicate key error on incidentId or notificationId (handled idempotently)
        if (createErr.code === 11000 || String(createErr.message).includes('E11000')) {
          logger.debug({ incidentId: incident.incidentId }, 'Notification already created concurrently');
        } else {
          logger.error({ err: createErr.message, incidentId: incident.incidentId }, 'Failed to create repaired notification');
        }
      }
    }

    return repaired;
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed during outbox repair sweep');
    return 0;
  }
}

/**
 * Setup Outbox Repair Sweeper in the background worker:
 * Runs immediately at startup, then periodically every 60 seconds.
 */
export function setupOutboxRepairSweeper(intervalMs = 60000) {
  let isRunning = false;

  const runSweep = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await repairOutboxSweep(30000);
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error during outbox repair sweep execution');
    } finally {
      isRunning = false;
    }
  };

  // 1. Startup sweep
  runSweep().catch(() => {});

  // 2. Periodic sweep every 60 seconds
  const timer = setInterval(() => {
    runSweep().catch(() => {});
  }, intervalMs);

  return {
    stop: () => clearInterval(timer),
    runNow: runSweep
  };
}

