import { z } from 'zod';
import { UNITS } from '../models/Product';
import { dateInput, idParams, imageRef, objectId, pagination } from './common';

const quantity = z.coerce.number().min(0, 'Quantity cannot be negative').max(100000);

const inventoryBody = z.object({
  farm: objectId.optional(), // defaults to the farmer's only farm
  product: objectId,
  price: z.coerce.number().min(1, 'Price must be at least ₹1').max(100000),
  unit: z.enum(UNITS),
  packSizeGrams: z.coerce.number().int().min(1).max(50000).optional(),
  quantityAvailable: quantity,
  minOrderQty: z.coerce.number().min(0.1).max(1000).optional(),
  harvestDate: dateInput.optional(),
  processedDate: dateInput.optional(),
  expiryDate: dateInput.optional(),
  packaging: z.string().trim().max(120).optional(),
  description: z.string().trim().max(600).optional(),
  images: z.array(imageRef).max(6).optional(),
  organicClaim: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const createInventorySchema = z.object({ body: inventoryBody });

// Product and farm are fixed once listed — create a new listing instead.
export const updateInventorySchema = z.object({
  params: idParams,
  body: inventoryBody.omit({ product: true, farm: true }).partial(),
});

export const adjustStockSchema = z.object({
  params: idParams,
  body: z.object({
    mode: z.enum(['set', 'add']),
    quantity: z.coerce.number().min(-100000).max(100000),
  }),
});

export const inventoryIdSchema = z.object({ params: idParams });

export const listMyInventorySchema = z.object({
  query: z.object({
    status: z.enum(['all', 'active', 'low', 'out', 'inactive']).default('all'),
    type: z.enum(['fresh', 'dry']).optional(),
    q: z.string().trim().max(60).optional(),
    ...pagination,
  }),
});

export type InventoryInput = z.infer<typeof inventoryBody>;
export type InventoryUpdate = z.infer<typeof updateInventorySchema>['body'];
export type ListMyInventoryQuery = z.infer<typeof listMyInventorySchema>['query'];
