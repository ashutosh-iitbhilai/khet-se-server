import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { jsonTransform, pointSchema, type GeoPoint } from './common';

export interface IFarm {
  farmer: Types.ObjectId;
  name: string;
  description?: string;
  /** City slug, e.g. "raipur". Partition key for multi-city expansion. */
  city: string;
  address: {
    line1: string;
    village?: string;
    district?: string;
    state: string;
    pincode: string;
  };
  location: GeoPoint;
  areaAcres?: number;
  images: string[];
  deliveryRadiusKm: number;
  deliveryAvailable: boolean;
  pickupAvailable: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type FarmDocument = HydratedDocument<IFarm>;

const farmSchema = new Schema<IFarm>(
  {
    farmer: { type: Schema.Types.ObjectId, ref: 'Farmer', required: true, index: true },
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 1500 },
    city: { type: String, required: true, lowercase: true, trim: true },
    address: {
      line1: { type: String, required: true, trim: true, maxlength: 200 },
      village: { type: String, trim: true, maxlength: 100 },
      district: { type: String, trim: true, maxlength: 100 },
      state: { type: String, required: true, trim: true, maxlength: 60 },
      pincode: { type: String, required: true, match: /^\d{6}$/ },
    },
    location: { type: pointSchema, required: true },
    areaAcres: { type: Number, min: 0, max: 100000 },
    images: {
      type: [String],
      default: [],
      validate: { validator: (v: string[]) => v.length <= 8, message: 'At most 8 farm images' },
    },
    deliveryRadiusKm: { type: Number, default: 8, min: 1, max: 50 },
    deliveryAvailable: { type: Boolean, default: true },
    pickupAvailable: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: jsonTransform },
);

// Core geo index — powers $geoNear farm discovery; open/delivering filters use the index keys.
farmSchema.index({ location: '2dsphere', isActive: 1, deliveryAvailable: 1 });
farmSchema.index({ city: 1, isActive: 1, deliveryAvailable: 1 });

export const Farm = model<IFarm>('Farm', farmSchema);
