import { Schema, model, type HydratedDocument, type Types } from 'mongoose';
import { jsonTransform, pointSchema, type GeoPoint } from './common';
import { PRODUCT_TYPES, UNITS, type ProductType, type Unit } from './Product';

/**
 * A farmer's listing of a catalogue product at one farm: price, stock and freshness.
 * Product name/type and farm location/city are denormalised so listing queries
 * (including $geoNear) never need joins for filtering.
 */
export interface IInventory {
  farmer: Types.ObjectId;
  farm: Types.ObjectId;
  product: Types.ObjectId;

  // Denormalised for fast filtering / sorting
  productName: string;
  productType: ProductType;
  category: string;
  city: string;
  farmLocation: GeoPoint;

  price: number; // INR per `unit`
  unit: Unit;
  /** For packets: net weight in grams (e.g. 250). */
  packSizeGrams?: number;
  quantityAvailable: number; // in `unit`s
  quantityReserved: number; // held by unpaid / unconfirmed orders
  minOrderQty: number;

  // Fresh produce
  harvestDate?: Date;
  // Dry produce
  processedDate?: Date;
  expiryDate?: Date;
  packaging?: string;

  description?: string;
  images: string[];
  organicClaim: boolean;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type InventoryDocument = HydratedDocument<IInventory>;

const inventorySchema = new Schema<IInventory>(
  {
    farmer: { type: Schema.Types.ObjectId, ref: 'Farmer', required: true },
    farm: { type: Schema.Types.ObjectId, ref: 'Farm', required: true },
    product: { type: Schema.Types.ObjectId, ref: 'Product', required: true },

    productName: { type: String, required: true },
    productType: { type: String, enum: PRODUCT_TYPES, required: true },
    category: { type: String, required: true },
    city: { type: String, required: true, lowercase: true },
    farmLocation: { type: pointSchema, required: true },

    price: { type: Number, required: true, min: 1, max: 100000 },
    unit: { type: String, enum: UNITS, required: true },
    packSizeGrams: { type: Number, min: 1, max: 50000 },
    quantityAvailable: { type: Number, required: true, min: 0 },
    quantityReserved: { type: Number, default: 0, min: 0 },
    minOrderQty: { type: Number, default: 1, min: 0.1 },

    harvestDate: Date,
    processedDate: Date,
    expiryDate: Date,
    packaging: { type: String, trim: true, maxlength: 120 },

    description: { type: String, trim: true, maxlength: 600 },
    images: { type: [String], default: [] },
    organicClaim: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: jsonTransform },
);

// One listing per product per farm — farmers update stock rather than duplicating.
inventorySchema.index({ farm: 1, product: 1 }, { unique: true });
// Listing / marketplace queries
inventorySchema.index({ product: 1, isActive: 1, quantityAvailable: 1 });
inventorySchema.index({ city: 1, productType: 1, category: 1, isActive: 1 });
inventorySchema.index({ farmer: 1, isActive: 1, updatedAt: -1 });
// Geo discovery of listings. Compound 2dsphere: active / in-stock filtering happens on index
// keys before documents are fetched (see `npm run bench`). Must stay the only 2dsphere index
// on farmLocation so $geoNear can pick it.
inventorySchema.index({ farmLocation: '2dsphere', isActive: 1, quantityAvailable: 1 });

export const Inventory = model<IInventory>('Inventory', inventorySchema, 'inventory');
