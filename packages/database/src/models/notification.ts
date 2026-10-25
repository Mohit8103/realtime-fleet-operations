import mongoose, { Schema, type Document, type Model } from 'mongoose';

export type NotificationStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'dead';

export interface INotification extends Document {
  id?: string;
  notificationId: string;
  incidentId: string;
  operatorId?: string | null;
  status: NotificationStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lockedUntil?: Date | null;
  lastError?: string | null;
  sentAt?: Date | null;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    notificationId: { type: String, required: true, unique: true, index: true },
    incidentId: { type: String, required: true, index: true },
    operatorId: { type: String, default: null, index: true },
    status: {
      type: String,
      enum: ['pending', 'sending', 'sent', 'failed', 'dead'],
      default: 'pending',
      index: true
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    lockedUntil: { type: Date, default: null, index: true },
    lastError: { type: String, default: null },
    sentAt: { type: Date, default: null },
    idempotencyKey: { type: String, required: true, index: true },
    payload: { type: Schema.Types.Mixed, default: {} }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        ret.id = ret.notificationId;
        return ret;
      }
    },
    toObject: { virtuals: true }
  }
);

notificationSchema.virtual('id').get(function (this: INotification) {
  return this.notificationId;
});

// Composite index for dispatcher atomic polling
notificationSchema.index({ status: 1, nextAttemptAt: 1, lockedUntil: 1 });

export const Notification: Model<INotification> =
  mongoose.models.Notification || mongoose.model<INotification>('Notification', notificationSchema, 'notifications');
