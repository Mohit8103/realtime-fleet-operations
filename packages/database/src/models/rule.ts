import mongoose, { Schema, type Document, type Model } from 'mongoose';

export type RuleType = 'threshold' | 'type_match' | 'no_report';
export type RuleSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type ThresholdOperator = '>' | '<' | '>=' | '<=' | '==';

export interface DeviceFilter {
  type: 'all' | 'ids' | 'location';
  ids?: string[];
  location?: string;
}

export interface ThresholdConditions {
  metric: string;
  operator: ThresholdOperator;
  value: number;
  deviceFilter?: DeviceFilter;
}

export interface TypeMatchConditions {
  eventType: string;
  deviceFilter?: DeviceFilter;
}

export interface NoReportConditions {
  seconds: number;
  deviceFilter?: DeviceFilter;
}

export interface IRule extends Document {
  name: string;
  type: RuleType;
  severity: RuleSeverity;
  enabled: boolean;
  cooldownSeconds: number;
  notifyOperator?: string;
  conditions: ThresholdConditions | TypeMatchConditions | NoReportConditions;
  createdAt: Date;
  updatedAt: Date;
}

const ruleSchema = new Schema<IRule>(
  {
    name: { type: String, required: true, trim: true, unique: true, index: true },
    type: {
      type: String,
      enum: ['threshold', 'type_match', 'no_report'],
      required: true,
      index: true
    },
    severity: {
      type: String,
      enum: ['info', 'low', 'medium', 'high', 'critical'],
      default: 'medium'
    },
    enabled: { type: Boolean, default: true, index: true },
    cooldownSeconds: { type: Number, default: 0 },
    notifyOperator: { type: String, default: null },
    conditions: { type: Schema.Types.Mixed, required: true }
  },
  {
    timestamps: true
  }
);

export const Rule: Model<IRule> =
  mongoose.models.Rule || mongoose.model<IRule>('Rule', ruleSchema, 'rules');
