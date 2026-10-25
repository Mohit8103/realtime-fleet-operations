import mongoose, { Schema, type Document, type Model } from 'mongoose';

export type DeviceStatus = 'registered' | 'online' | 'stale' | 'offline';

export interface IDevice extends Document {
  deviceId: string;
  name: string;
  location: string;
  apiKeyHash: string;
  status: DeviceStatus;
  createdAt: Date;
  lastSeenAt?: Date;
  lastSeq?: number;
}

const deviceSchema = new Schema<IDevice>(
  {
    deviceId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    location: { type: String, default: 'default', index: true },
    apiKeyHash: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ['registered', 'online', 'stale', 'offline'],
      default: 'registered',
      index: true
    },
    createdAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, index: true },
    lastSeq: { type: Number, default: 0 }
  },
  {
    timestamps: true
  }
);

export const Device: Model<IDevice> =
  mongoose.models.Device || mongoose.model<IDevice>('Device', deviceSchema);
