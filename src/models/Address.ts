import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { jsonTransform, pointSchema, type GeoPoint } from './common';

export const ADDRESS_LABELS = ['home', 'work', 'other'] as const;

export interface IAddress {
  user: Types.ObjectId;
  label: (typeof ADDRESS_LABELS)[number];
  name: string;
  phone: string;
  line1: string;
  landmark?: string;
  city: string;
  pincode: string;
  location: GeoPoint;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type AddressDocument = HydratedDocument<IAddress>;

const addressSchema = new Schema<IAddress>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, enum: ADDRESS_LABELS, default: 'home' },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    phone: { type: String, required: true, match: /^[6-9]\d{9}$/ },
    line1: { type: String, required: true, trim: true, maxlength: 200 },
    landmark: { type: String, trim: true, maxlength: 120 },
    city: { type: String, required: true, trim: true, maxlength: 60 },
    pincode: { type: String, required: true, match: /^\d{6}$/ },
    // Exact delivery point — used to check which farms can reach this address.
    location: { type: pointSchema, required: true },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true, toJSON: jsonTransform },
);

export const Address = model<IAddress>('Address', addressSchema);
