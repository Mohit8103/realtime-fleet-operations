import { z } from 'zod';

export const deviceFilterSchema = z
  .object({
    type: z.enum(['all', 'ids', 'location']).default('all'),
    ids: z.array(z.string()).optional(),
    location: z.string().optional()
  })
  .optional()
  .default({ type: 'all' });

export const thresholdConditionsSchema = z.object({
  metric: z.string().min(1, 'metric is required'),
  operator: z.enum(['>', '<', '>=', '<=', '==']),
  value: z.number(),
  deviceFilter: deviceFilterSchema
});

export const typeMatchConditionsSchema = z.object({
  eventType: z.string().min(1, 'eventType is required'),
  deviceFilter: deviceFilterSchema
});

export const noReportConditionsSchema = z.preprocess((val: any) => {
  if (val && typeof val === 'object' && val.durationSeconds !== undefined && val.seconds === undefined) {
    return { ...val, seconds: val.durationSeconds };
  }
  return val;
}, z.object({
  seconds: z.number().int().positive('seconds must be a positive integer'),
  deviceFilter: deviceFilterSchema
}));

export const createRuleSchema = z.preprocess((raw: any) => {
  if (raw && typeof raw === 'object') {
    const data = { ...raw };
    if (!data.conditions) {
      if (data.type === 'threshold') {
        data.conditions = {
          metric: data.metric,
          operator: data.operator,
          value: data.value,
          deviceFilter: data.deviceFilter || { type: 'all' }
        };
      } else if (data.type === 'no_report') {
        data.conditions = {
          seconds: data.seconds ?? data.durationSeconds,
          deviceFilter: data.deviceFilter || { type: 'all' }
        };
      } else if (data.type === 'type_match') {
        data.conditions = {
          eventType: data.eventType || data.typeMatch,
          deviceFilter: data.deviceFilter || { type: 'all' }
        };
      }
    }
    return data;
  }
  return raw;
}, z
  .object({
    name: z.string().min(1, 'Rule name is required'),
    type: z.enum(['threshold', 'type_match', 'no_report']),
    severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).default('medium'),
    enabled: z.boolean().default(true),
    cooldownSeconds: z.number().int().nonnegative().default(0),
    notifyOperator: z.string().optional(),
    conditions: z.record(z.unknown()).default({})
  })
  .superRefine((data, ctx) => {
    if (data.type === 'threshold') {
      const res = thresholdConditionsSchema.safeParse(data.conditions);
      if (!res.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['conditions'],
          message: `Threshold conditions error: ${res.error.errors.map((e) => e.message).join(', ')}`
        });
      }
    } else if (data.type === 'type_match') {
      const res = typeMatchConditionsSchema.safeParse(data.conditions);
      if (!res.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['conditions'],
          message: `Type match conditions error: ${res.error.errors.map((e) => e.message).join(', ')}`
        });
      }
    } else if (data.type === 'no_report') {
      const res = noReportConditionsSchema.safeParse(data.conditions);
      if (!res.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['conditions'],
          message: `No-report conditions error: ${res.error.errors.map((e) => e.message).join(', ')}`
        });
      }
    }
  }));

export const updateRuleSchema = z.object({
  name: z.string().min(1).optional(),
  type: z.enum(['threshold', 'type_match', 'no_report']).optional(),
  severity: z.enum(['info', 'low', 'medium', 'high', 'critical']).optional(),
  enabled: z.boolean().optional(),
  cooldownSeconds: z.number().int().nonnegative().optional(),
  notifyOperator: z.string().optional(),
  conditions: z.record(z.unknown()).optional()
});
