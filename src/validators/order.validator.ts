import { z } from 'zod';
import { ORDERS } from '../config/orders';
import { PAYMENT_METHODS } from '../models/Order';
import { idParams, latitude, longitude, objectId, pagination } from './common';

const line = z.object({
  listing: objectId,
  quantity: z.coerce.number().positive('Quantity must be more than 0').max(1000),
});

const lines = z
  .array(line)
  .min(1, 'Your cart is empty')
  .max(ORDERS.maxLinesPerOrder, `At most ${ORDERS.maxLinesPerOrder} items per order`)
  .refine((ls) => new Set(ls.map((l) => l.listing)).size === ls.length, 'Each product can appear only once');

export const quoteSchema = z.object({
  body: z.object({ items: lines, location: z.object({ lng: longitude, lat: latitude }) }),
});

export const placeOrderSchema = z.object({
  body: z.object({
    items: lines,
    addressId: objectId,
    paymentMethod: z.enum(PAYMENT_METHODS),
    /** Grand total the customer saw; if prices moved since, the order is refused with the new quote. */
    expectedTotal: z.coerce.number().min(0),
  }),
});

export const myOrdersSchema = z.object({ query: z.object({ ...pagination, limit: z.coerce.number().int().min(1).max(50).default(10) }) });

export const farmerOrdersSchema = z.object({
  query: z.object({
    view: z.enum(['incoming', 'active', 'completed']).default('incoming'),
    ...pagination,
  }),
});

export const orderIdSchema = z.object({ params: idParams });

/** Statuses a farmer may move a group to. */
export const FARMER_TARGETS = ['accepted', 'rejected', 'packed', 'out_for_delivery', 'delivered', 'cancelled'] as const;

export const updateStatusSchema = z.object({
  params: idParams,
  body: z.object({
    groupId: objectId,
    status: z.enum(FARMER_TARGETS),
    note: z.string().trim().max(300).optional(),
    /** Required for "delivered": the customer's 4-digit handover code. */
    code: z.string().trim().regex(/^\d{4}$/, 'Enter the 4-digit code from the customer').optional(),
    /** Optional delivery date when accepting. */
    deliveryDate: z.coerce.date().optional(),
  }),
});

export const groupCodeSchema = z.object({ params: z.object({ id: objectId, groupId: objectId }) });

export const cancelSchema = z.object({
  params: idParams,
  body: z.object({ groupId: objectId.optional(), reason: z.string().trim().max(300).optional() }),
});

export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

export type QuoteLine = z.infer<typeof line>;
export type PlaceOrderInput = z.infer<typeof placeOrderSchema>['body'];
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>['body'];
