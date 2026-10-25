import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { type RuleSeverity } from './rule.js';

export type IncidentState = 'open' | 'acknowledged' | 'resolved';

export interface ITimelineEntry {
  action: string;
  timestamp: Date;
  operator?: string | null;
  note?: string | null;
}

export interface IIncident extends Document {
  id?: string;
  incidentId: string;
  deviceId: string;
  ruleId: string;
  ruleName?: string;
  dedupeKey: string;
  severity: RuleSeverity;
  state: IncidentState;
  fromReplay: boolean;
  eventId?: string | null;
  firstEventId?: string | null;
  lastEventId?: string | null;
  occurrenceCount: number;
  triggeringEvents: string[];
  acknowledgedAt?: Date | null;
  acknowledgedBy?: string | null;
  resolvedAt?: Date | null;
  resolvedBy?: string | null;
  timeline: ITimelineEntry[];
  suppressedStaleChecksCount: number;
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

const timelineEntrySchema = new Schema<ITimelineEntry>(
  {
    action: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
    operator: { type: String, default: null },
    note: { type: String, default: null }
  },
  { _id: false }
);

const incidentSchema = new Schema<IIncident>(
  {
    incidentId: { type: String, required: true, unique: true, index: true },
    deviceId: { type: String, required: true, index: true },
    ruleId: { type: String, required: true, index: true },
    ruleName: { type: String },
    dedupeKey: { type: String, required: true },
    severity: {
      type: String,
      enum: ['info', 'low', 'medium', 'high', 'critical'],
      default: 'medium'
    },
    state: {
      type: String,
      enum: ['open', 'acknowledged', 'resolved'],
      default: 'open',
      index: true
    },
    fromReplay: { type: Boolean, default: false, index: true },
    eventId: { type: String, default: null, index: true },
    firstEventId: { type: String, default: null },
    lastEventId: { type: String, default: null },
    occurrenceCount: { type: Number, default: 1 },
    triggeringEvents: { type: [String], default: [] },
    acknowledgedAt: { type: Date, default: null },
    acknowledgedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: String, default: null },
    timeline: { type: [timelineEntrySchema], default: [] },
    suppressedStaleChecksCount: { type: Number, default: 0 },
    reason: { type: String }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        ret.id = ret.incidentId;
        return ret;
      }
    },
    toObject: { virtuals: true }
  }
);

incidentSchema.virtual('id').get(function (this: IIncident) {
  return this.incidentId;
});

// Partial unique index: at most ONE non-resolved incident per dedupeKey
incidentSchema.index(
  { dedupeKey: 1 },
  {
    unique: true,
    partialFilterExpression: { state: { $in: ['open', 'acknowledged'] } }
  }
);

incidentSchema.index({ deviceId: 1, state: 1 });
incidentSchema.index({ ruleId: 1, state: 1 });

export const Incident: Model<IIncident> =
  mongoose.models.Incident || mongoose.model<IIncident>('Incident', incidentSchema, 'incidents');
