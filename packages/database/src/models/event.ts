import mongoose, { Schema, type Document, type Model } from 'mongoose';

export type EventProcessingStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface IEvent extends Document {
  eventId: string;
  deviceId: string;
  seq: number;
  type: string;
  timestamp: Date;
  receivedAt: Date;
  payload: Record<string, unknown>;
  replayed: boolean;
  processingStatus: EventProcessingStatus;
  processedAt?: Date | null;
  error?: string | null;
  attempts?: number;
  createdAt: Date;
  updatedAt: Date;
}

const eventSchema = new Schema<IEvent>(
  {
    eventId: { type: String, required: true },
    deviceId: { type: String, required: true, index: true },
    seq: { type: Number, required: true },
    type: { type: String, required: true, index: true },
    timestamp: { type: Date, required: true, index: true },
    receivedAt: { type: Date, required: true, default: Date.now, index: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    replayed: { type: Boolean, default: false, index: true },
    processingStatus: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed'],
      default: 'pending',
      index: true
    },
    processedAt: { type: Date, default: null },
    error: { type: String, default: null },
    attempts: { type: Number, default: 0 }
  },
  {
    timestamps: true
  }
);

eventSchema.index({ eventId: 1 }, { unique: true });
eventSchema.index({ processingStatus: 1, updatedAt: 1 });

export const Event: Model<IEvent> =
  mongoose.models.Event || mongoose.model<IEvent>('Event', eventSchema);
