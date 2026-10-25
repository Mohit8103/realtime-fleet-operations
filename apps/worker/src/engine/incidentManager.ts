import crypto from 'node:crypto';
import {
  Incident,
  Notification,
  Operator,
  Rule,
  type IIncident,
  type IDevice,
  type IEvent,
  type IRule
} from '@fleet/database';
import { config } from '@fleet/config';
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
    return { incident: existing, isCreated: false };
  }

  // 2. No non-resolved incident exists -> create a new one
  try {
    const incidentId = crypto.randomUUID();
    const operatorId = await resolveOperatorId(rule, device);

    const newIncident = await Incident.create({
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
    });

    // Write transactional outbox notification ONLY on creation
    try {
      await Notification.create({
        notificationId: crypto.randomUUID(),
        incidentId: newIncident.incidentId,
        operatorId,
        status: 'pending',
        attempts: 0,
        maxAttempts: config.notifications.maxAttempts,
        nextAttemptAt: new Date(),
        idempotencyKey: crypto.randomUUID(),
        payload: {
          incidentId: newIncident.incidentId,
          ruleId,
          ruleName: rule.name,
          deviceId: device.deviceId,
          severity: rule.severity,
          reason: matchReason
        }
      });
    } catch (notifErr: any) {
      // Notification failure must NEVER block or roll back incident creation
      logger.error({ err: notifErr.message }, 'Failed to write notification outbox; incident creation preserved');
    }

    return { incident: newIncident, isCreated: true };
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
        return { incident: raced, isCreated: false };
      }
    }

    throw err;
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
