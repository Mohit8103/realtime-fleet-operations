import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface IRejectedEvent extends Document {
  rawPayload: unknown;
  deviceId?: string | null;
  reason: string;
  receivedAt: Date;
}

const rejectedEventSchema = new Schema<IRejectedEvent>(
  {
    rawPayload: { type: Schema.Types.Mixed },
    deviceId: { type: String, default: null, index: true },
    reason: { type: String, required: true },
    receivedAt: { type: Date, required: true, default: Date.now, index: true }
  },
  {
    timestamps: true
  }
);

export const RejectedEvent: Model<IRejectedEvent> =
  mongoose.models.RejectedEvent ||
  mongoose.model<IRejectedEvent>('RejectedEvent', rejectedEventSchema, 'rejected_events');
