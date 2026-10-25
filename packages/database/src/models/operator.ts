import mongoose, { Schema, type Document, type Model } from 'mongoose';

export interface IOperator extends Document {
  id?: string;
  operatorId: string;
  name: string;
  email: string;
  locations: string[];
  createdAt: Date;
  updatedAt: Date;
}

const operatorSchema = new Schema<IOperator>(
  {
    operatorId: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    email: { type: String, required: true },
    locations: { type: [String], default: [], index: true }
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (_doc, ret: any) => {
        ret.id = ret.operatorId;
        return ret;
      }
    },
    toObject: { virtuals: true }
  }
);

operatorSchema.virtual('id').get(function (this: IOperator) {
  return this.operatorId;
});

export const Operator: Model<IOperator> =
  mongoose.models.Operator || mongoose.model<IOperator>('Operator', operatorSchema, 'operators');
