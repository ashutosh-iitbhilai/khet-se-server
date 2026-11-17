import { z } from 'zod';
import { ALL_CATEGORIES, PRODUCT_TYPES, UNITS } from '../models/Product';
import { imageRef, pagination } from './common';

export const listProductsSchema = z.object({
  query: z.object({
    type: z.enum(PRODUCT_TYPES).optional(),
    category: z.enum(ALL_CATEGORIES as [string, ...string[]]).optional(),
    q: z.string().trim().max(60).optional(),
    page: pagination.page,
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
});

const productBody = z.object({
  name: z.string().trim().min(2).max(80),
  localName: z.string().trim().max(80).optional(),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9-]+$/, 'Use lowercase letters, numbers and dashes'),
  type: z.enum(PRODUCT_TYPES),
  category: z.enum(ALL_CATEGORIES as [string, ...string[]]),
  defaultUnit: z.enum(UNITS),
  description: z.string().trim().max(600).optional(),
  image: imageRef,
  imageCredit: z.string().trim().max(200).optional(),
  shelfLifeDays: z.coerce.number().int().min(1).max(1095),
  isActive: z.boolean().optional(),
});

export const productParamSchema = z.object({ params: z.object({ id: z.string().min(1).max(80) }) });
export const createProductSchema = z.object({ body: productBody });
export const updateProductSchema = z.object({
  params: z.object({ id: z.string().min(1).max(80) }),
  body: productBody.partial(),
});

export type ListProductsQuery = z.infer<typeof listProductsSchema>['query'];
export type ProductInput = z.infer<typeof productBody>;
