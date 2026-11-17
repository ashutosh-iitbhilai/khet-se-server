import { Schema, model, type HydratedDocument } from 'mongoose';
import { jsonTransform } from './common';

export const PRODUCT_TYPES = ['fresh', 'dry'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PRODUCT_CATEGORIES = {
  fresh: ['leafy-greens', 'roots-tubers', 'bulbs', 'fruiting', 'cruciferous', 'beans-pods', 'gourds', 'herbs'],
  dry: ['sun-dried', 'dried-leaves', 'dehydrated-mix', 'powders'],
} as const satisfies Record<ProductType, readonly string[]>;
export const ALL_CATEGORIES = [...PRODUCT_CATEGORIES.fresh, ...PRODUCT_CATEGORIES.dry];

export const UNITS = ['kg', 'g', 'bunch', 'piece', 'dozen', 'packet'] as const;
export type Unit = (typeof UNITS)[number];

/**
 * Shared catalogue entry (e.g. "Tomato"). Farmer-specific price/stock lives in Inventory,
 * so one catalogue product can be listed by many farmers at different prices.
 */
export interface IProduct {
  name: string;
  localName?: string; // Hindi / regional name, e.g. "Tamatar"
  slug: string;
  type: ProductType;
  category: string;
  defaultUnit: Unit;
  description?: string;
  image: string;
  imageCredit?: string;
  /** Typical shelf life in days — used by the freshness score. */
  shelfLifeDays: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export type ProductDocument = HydratedDocument<IProduct>;

const productSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    localName: { type: String, trim: true, maxlength: 80 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, match: /^[a-z0-9-]+$/ },
    type: { type: String, enum: PRODUCT_TYPES, required: true },
    category: {
      type: String,
      required: true,
      validate: {
        validator(this: IProduct, v: string) {
          return (PRODUCT_CATEGORIES[this.type] as readonly string[])?.includes(v) ?? false;
        },
        message: 'Category does not match product type',
      },
    },
    defaultUnit: { type: String, enum: UNITS, required: true },
    description: { type: String, trim: true, maxlength: 600 },
    image: { type: String, required: true, trim: true },
    imageCredit: { type: String, trim: true, maxlength: 200 },
    shelfLifeDays: { type: Number, required: true, min: 1, max: 1095 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, toJSON: jsonTransform },
);

productSchema.index({ type: 1, category: 1, isActive: 1 });
productSchema.index({ name: 'text', localName: 'text' });

export const Product = model<IProduct>('Product', productSchema);
