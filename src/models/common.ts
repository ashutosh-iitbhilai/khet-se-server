import { Schema } from 'mongoose';

/** GeoJSON Point — coordinates are [longitude, latitude] (MongoDB order). */
export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number];
}

export const pointSchema = new Schema<GeoPoint>(
  {
    type: { type: String, enum: ['Point'], default: 'Point', required: true },
    coordinates: {
      type: [Number],
      required: true,
      validate: {
        validator: (v: number[]) =>
          Array.isArray(v) && v.length === 2 && v[0] >= -180 && v[0] <= 180 && v[1] >= -90 && v[1] <= 90,
        message: 'coordinates must be [lng, lat] within valid ranges',
      },
    },
  },
  { _id: false },
);

/** Shared toJSON transform: `_id` → `id`, drop `__v`. */
export const jsonTransform = {
  virtuals: true,
  transform: (_doc: unknown, ret: Record<string, unknown>) => {
    ret.id = String(ret._id);
    delete ret._id;
    delete ret.__v;
    return ret;
  },
};

export const toPoint = (lng: number, lat: number): GeoPoint => ({ type: 'Point', coordinates: [lng, lat] });
