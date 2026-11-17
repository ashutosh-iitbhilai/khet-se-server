import { z } from 'zod';
import { ALL_CATEGORIES, PRODUCT_TYPES } from '../models/Product';
import { RECOMMENDATION } from '../config/recommendation';
import { booleanQuery, latitude, longitude, objectId, pagination } from './common';

const geo = {
  lng: longitude,
  lat: latitude,
  /** Omit to let the engine start at the default radius and widen automatically. */
  radiusKm: z.coerce.number().min(1).max(RECOMMENDATION.maxRadiusKm).optional(),
};

const productFilters = {
  type: z.enum(PRODUCT_TYPES).optional(),
  category: z.enum(ALL_CATEGORIES as [string, ...string[]]).optional(),
  maxPrice: z.coerce.number().min(1).max(100000).optional(),
  organic: booleanQuery, // only farmers with verified organic certification
};

export const nearbyFarmersSchema = z.object({
  query: z.object({
    ...geo,
    ...productFilters,
    sort: z.enum(['recommended', 'distance', 'rating']).default('recommended'),
    ...pagination,
    limit: z.coerce.number().int().min(1).max(50).default(12),
  }),
});

export const nearbyListingsSchema = z.object({
  query: z.object({
    ...geo,
    ...productFilters,
    q: z.string().trim().max(60).optional(),
    product: objectId.optional(),
    farm: objectId.optional(),
    sort: z.enum(['recommended', 'distance', 'price_asc', 'price_desc', 'freshness']).default('recommended'),
    ...pagination,
    limit: z.coerce.number().int().min(1).max(60).default(24),
  }),
});

export const listingDetailSchema = z.object({
  params: z.object({ id: objectId }),
  query: z.object({ lng: longitude.optional(), lat: latitude.optional() }),
});

export type NearbyFarmersQuery = z.infer<typeof nearbyFarmersSchema>['query'];
export type NearbyListingsQuery = z.infer<typeof nearbyListingsSchema>['query'];
