import { z } from 'zod';

export const telemetryEventSchema = z.object({
  eventId: z
    .string({ required_error: 'eventId is required' })
    .min(1, 'eventId cannot be empty'),
  deviceId: z
    .string({ required_error: 'deviceId is required' })
    .min(1, 'deviceId cannot be empty'),
  seq: z
    .number({ required_error: 'seq is required', invalid_type_error: 'seq must be a number' })
    .int('seq must be an integer')
    .nonnegative('seq must be non-negative'),
  type: z
    .string({ required_error: 'type is required' })
    .min(1, 'type cannot be empty'),
  timestamp: z
    .string({ required_error: 'timestamp is required' })
    .datetime({ message: 'timestamp must be a valid ISO 8601 datetime' }),
  payload: z.record(z.unknown()).optional().default({}),
  replayed: z.boolean().optional().default(false)
});

export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;

export const batchEventsSchema = z.object({
  events: z.array(z.unknown()).min(1, 'events array must contain at least 1 event')
});

export const deviceRegistrationSchema = z.object({
  deviceId: z
    .string({ required_error: 'deviceId is required' })
    .min(1, 'deviceId cannot be empty'),
  name: z.string().optional(),
  location: z.string().optional().default('default')
});
