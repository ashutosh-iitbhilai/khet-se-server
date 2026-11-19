import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { jsonTransform, pointSchema, type GeoPoint } from './common';

/**
 * scheduled        — farmer accepted the group; the farmer will deliver it (or hasn't decided)
 * requested        — farmer asked for a delivery partner; waiting for one to accept
 * assigned         — a partner accepted; on the way to pick up
 * out_for_delivery — picked up (by the farmer or the partner)
 * delivered / cancelled
 */
export const DELIVERY_STATUSES = ['scheduled', 'requested', 'assigned', 'out_for_delivery', 'delivered', 'cancelled'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * The delivery run for one order group. Created when the farmer accepts the group and kept
 * in step with its status. When the farmer asks for a delivery partner it becomes a job that
 * nearby partners can accept (first one wins).
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
  mode: 'self' | 'partner';
  partner?: Types.ObjectId | null;
  /** Farm location (pickup) and customer location (drop), for job matching and navigation. */
  pickupLocation?: GeoPoint;
  dropLocation?: GeoPoint;
  /** What the partner earns for this job (₹). */
  payout?: number;
  /** Cash the partner must collect from the customer (COD), ₹. */
  codAmount?: number;
  requestedAt?: Date;
  assignedAt?: Date;
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
    mode: { type: String, enum: ['self', 'partner'], default: 'self' },
    partner: { type: Schema.Types.ObjectId, ref: 'DeliveryPartner', default: null },
    pickupLocation: { type: pointSchema, default: undefined },
    dropLocation: { type: pointSchema, default: undefined },
    payout: Number,
    codAmount: Number,
    requestedAt: Date,
    assignedAt: Date,
    outAt: Date,
    deliveredAt: Date,
  },
  { timestamps: true, toJSON: jsonTransform },
);

deliverySchema.index({ order: 1, group: 1 }, { unique: true });
deliverySchema.index({ farmer: 1, status: 1, scheduledFor: 1 });
// Job board: open requests near a partner (geo first so $geoNear can use it).
deliverySchema.index({ pickupLocation: '2dsphere', status: 1 });
// A partner's own jobs, newest first.
deliverySchema.index({ partner: 1, status: 1, updatedAt: -1 });

export const Delivery = model<IDelivery>('Delivery', deliverySchema);
