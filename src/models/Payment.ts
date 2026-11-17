import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { jsonTransform } from './common';

export const PAYMENT_PROVIDERS = ['cod', 'razorpay'] as const;
export const PAYMENT_RECORD_STATUSES = ['created', 'paid', 'failed', 'cancelled'] as const;

/** One record per payment attempt — kept separate from the order for auditability. */
export interface IPayment {
  order: Types.ObjectId;
  customer: Types.ObjectId;
  provider: (typeof PAYMENT_PROVIDERS)[number];
  amount: number; // INR
  currency: 'INR';
  status: (typeof PAYMENT_RECORD_STATUSES)[number];
  providerOrderId?: string;
  providerPaymentId?: string;
  failureReason?: string;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type PaymentDocument = HydratedDocument<IPayment>;

const paymentSchema = new Schema<IPayment>(
  {
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    customer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, enum: PAYMENT_PROVIDERS, required: true },
    amount: { type: Number, required: true, min: 0 },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    status: { type: String, enum: PAYMENT_RECORD_STATUSES, default: 'created' },
    providerOrderId: String,
    providerPaymentId: String,
    failureReason: String,
    paidAt: Date,
  },
  { timestamps: true, toJSON: jsonTransform },
);

paymentSchema.index({ providerOrderId: 1 }, { unique: true, partialFilterExpression: { providerOrderId: { $type: 'string' } } });
paymentSchema.index({ providerPaymentId: 1 }, { unique: true, partialFilterExpression: { providerPaymentId: { $type: 'string' } } });

export const Payment = model<IPayment>('Payment', paymentSchema);
