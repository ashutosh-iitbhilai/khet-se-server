import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { jsonTransform } from './common';

export const DELIVERY_STATUSES = ['scheduled', 'out_for_delivery', 'delivered', 'cancelled'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * The delivery run for one order group. Created when the farmer accepts the group and kept
 * in step with its status. Separate from the order so a future rider app or route planner
 * can work on deliveries without touching orders.
 */
export interface IDelivery {
  order: Types.ObjectId;
  group: Types.ObjectId;
  farmer: Types.ObjectId;
  farm: Types.ObjectId;
  customer: Types.ObjectId;
  distanceKm: number;
  status: DeliveryStatus;
  scheduledFor: Date;
  outAt?: Date;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export type DeliveryDocument = HydratedDocument<IDelivery>;

const deliverySchema = new Schema<IDelivery>(
  {
    order: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    group: { type: Schema.Types.ObjectId, required: true },
    farmer: { type: Schema.Types.ObjectId, ref: 'Farmer', required: true },
    farm: { type: Schema.Types.ObjectId, ref: 'Farm', required: true },
    customer: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    distanceKm: { type: Number, required: true },
    status: { type: String, enum: DELIVERY_STATUSES, default: 'scheduled' },
    scheduledFor: { type: Date, required: true },
    outAt: Date,
    deliveredAt: Date,
  },
  { timestamps: true, toJSON: jsonTransform },
);

deliverySchema.index({ order: 1, group: 1 }, { unique: true });
deliverySchema.index({ farmer: 1, status: 1, scheduledFor: 1 });

export const Delivery = model<IDelivery>('Delivery', deliverySchema);
