import crypto from 'node:crypto';
import {
  Rule,
  Incident,
  RuleEvaluation,
  type IRule,
  type IDevice,
  type IEvent,
  type ThresholdConditions,
  type TypeMatchConditions
} from '@fleet/database';
import { createLogger } from '@fleet/logger';
import { recordIncidentMatch } from './incidentManager.js';

const logger = createLogger({ service: 'rules-engine' });

export function matchesDeviceFilter(filter: any, device: IDevice): boolean {
  if (!filter || filter.type === 'all') return true;
  if (filter.type === 'ids' && Array.isArray(filter.ids)) {
    return filter.ids.includes(device.deviceId);
  }
  if (filter.type === 'location' && filter.location) {
    return device.location === filter.location;
  }
  return true;
}

export function evaluateThreshold(
  val: number,
  operator: string,
  target: number
): boolean {
  switch (operator) {
    case '>':
      return val > target;
    case '<':
      return val < target;
    case '>=':
      return val >= target;
    case '<=':
      return val <= target;
    case '==':
      return val === target;
    default:
      return false;
  }
}

export async function processEventRules(event: IEvent, device: IDevice): Promise<void> {
  const rules = await Rule.find({ enabled: true }).lean();
  if (!rules.length) return;

  const isReplay =
    Boolean(event.replayed) ||
    (new Date(event.receivedAt).getTime() - new Date(event.timestamp).getTime() > 300000);

  for (const rule of rules) {
    if (rule.type === 'no_report') {
      // no_report rules are evaluated by the stale detector schedule
      continue;
    }

    const conditions = rule.conditions as any;

    // 1. Device filter check
    if (!matchesDeviceFilter(conditions.deviceFilter, device)) {
      await RuleEvaluation.create({
        eventId: event.eventId,
        ruleId: String(rule._id),
        ruleName: rule.name,
        deviceId: event.deviceId,
        matched: false,
        reason: 'Device filter mismatch',
        evaluatedAt: new Date()
      });
      continue;
    }

    let matched = false;
    let matchReason = '';

    // 2. Evaluate Rule Conditions
    if (rule.type === 'threshold') {
      const tc = conditions as ThresholdConditions;
      let metricValue = (event.payload as any)?.[tc.metric];
      if (metricValue === undefined && (event.payload as any)?.metric === tc.metric) {
        metricValue = (event.payload as any)?.value;
      }

      if (metricValue === undefined || metricValue === null || typeof metricValue !== 'number') {
        matched = false;
        matchReason = `metric ${tc.metric} not found or not a number in payload`;
      } else {
        matched = evaluateThreshold(metricValue, tc.operator, tc.value);
        if (matched) {
          matchReason = `${tc.metric} ${metricValue} ${tc.operator} ${tc.value}`;
        } else {
          matchReason = `no match: ${metricValue} not ${tc.operator} ${tc.value}`;
        }
      }
    } else if (rule.type === 'type_match') {
      const tmc = conditions as TypeMatchConditions;
      matched = event.type === tmc.eventType;
      if (matched) {
        matchReason = `event type matched: ${event.type}`;
      } else {
        matchReason = `no match: event type ${event.type} !== ${tmc.eventType}`;
      }
    }

    // 3. Incident handling if matched
    if (matched) {
      // Cooldown suppression check
      if (rule.cooldownSeconds > 0) {
        const lastIncident = await Incident.findOne({
          deviceId: event.deviceId,
          ruleId: String(rule._id)
        })
          .sort({ createdAt: -1 })
          .lean();

        if (lastIncident) {
          const elapsedSec = (Date.now() - new Date(lastIncident.createdAt).getTime()) / 1000;
          if (elapsedSec < rule.cooldownSeconds) {
            await RuleEvaluation.create({
              eventId: event.eventId,
              ruleId: String(rule._id),
              ruleName: rule.name,
              deviceId: event.deviceId,
              matched: true,
              reason: 'suppressed: cooldown',
              evaluatedAt: new Date()
            });
            continue;
          }
        }
      }

      logger.info(
        {
          eventId: event.eventId,
          deviceId: event.deviceId,
          rule: rule.name,
          matchReason
        },
        '🎯 Rule matched by event'
      );

      // Atomically upsert incident with partial unique index guarantee
      const { incident, isCreated } = await recordIncidentMatch({
        rule: rule as any,
        device,
        event,
        isReplay,
        matchReason
      });

      logger.info(
        {
          eventId: event.eventId,
          deviceId: event.deviceId,
          incidentId: incident.incidentId,
          rule: rule.name,
          isCreated,
          occurrenceCount: incident.occurrenceCount,
          fromReplay: isReplay
        },
        isCreated ? '🚨 Incident created by rules engine' : '🔄 Incident occurrence updated by rules engine'
      );

      // Record successful matched evaluation
      await RuleEvaluation.create({
        eventId: event.eventId,
        ruleId: String(rule._id),
        ruleName: rule.name,
        deviceId: event.deviceId,
        matched: true,
        reason: matchReason,
        evaluatedAt: new Date()
      });
    } else {
      // Record unmatched evaluation
      await RuleEvaluation.create({
        eventId: event.eventId,
        ruleId: String(rule._id),
        ruleName: rule.name,
        deviceId: event.deviceId,
        matched: false,
        reason: matchReason,
        evaluatedAt: new Date()
      });
    }
  }
}
