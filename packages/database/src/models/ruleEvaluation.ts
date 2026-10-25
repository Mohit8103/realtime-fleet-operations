import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface IRuleEvaluation extends Document {
  eventId?: string | null;
  ruleId: string;
  ruleName?: string;
  deviceId: string;
  matched: boolean;
  reason: string;
  evaluatedAt: Date;
}

const ruleEvaluationSchema = new Schema<IRuleEvaluation>(
  {
    eventId: { type: String, default: null, index: true },
    ruleId: { type: String, required: true, index: true },
    ruleName: { type: String },
    deviceId: { type: String, required: true, index: true },
    matched: { type: Boolean, required: true, index: true },
    reason: { type: String, required: true },
    evaluatedAt: { type: Date, required: true, default: Date.now }
  },
  {
    timestamps: true
  }
);

ruleEvaluationSchema.index({ eventId: 1, ruleId: 1 });
// 24-hour TTL index for storage hygiene
ruleEvaluationSchema.index({ evaluatedAt: 1 }, { expireAfterSeconds: 86400 });

export const RuleEvaluation: Model<IRuleEvaluation> =
  mongoose.models.RuleEvaluation ||
  mongoose.model<IRuleEvaluation>('RuleEvaluation', ruleEvaluationSchema, 'rule_evaluations');
