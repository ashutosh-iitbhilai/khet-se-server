import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { jsonTransform, pointSchema, type GeoPoint } from './common';

export const VEHICLES = ['bicycle', 'bike', 'scooter', 'auto', 'van'] as const;
export type Vehicle = (typeof VEHICLES)[number];

/**
 * A delivery partner's working profile. Partners pick up parcels from farms near their base
 * and deliver them to customers. Created (empty) when someone registers as a partner; they
 * only see jobs after setting a base location and going online.
 */
export interface IDeliveryPartner {
  user: Types.ObjectId;
  vehicle: Vehicle;
  /** Where the partner usually starts from. Jobs are offered within serviceRadiusKm of it. */
  baseLocation?: GeoPoint;
  baseLabel?: string;
  serviceRadiusKm: number;
  isOnline: boolean;
  /** How many accepted-but-not-delivered jobs they may hold at once. */
  maxActiveJobs: number;
  createdAt: Date;
  updatedAt: Date;
}

export type DeliveryPartnerDocument = HydratedDocument<IDeliveryPartner>;

const partnerSchema = new Schema<IDeliveryPartner>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    vehicle: { type: String, enum: VEHICLES, default: 'bike' },
    baseLocation: { type: pointSchema, default: undefined },
    baseLabel: { type: String, trim: true, maxlength: 120 },
    serviceRadiusKm: { type: Number, min: 1, max: 30, default: 10 },
    isOnline: { type: Boolean, default: false },
    maxActiveJobs: { type: Number, min: 1, max: 10, default: 3 },
  },
  { timestamps: true, toJSON: jsonTransform },
);

export const DeliveryPartner = model<IDeliveryPartner>('DeliveryPartner', partnerSchema);
