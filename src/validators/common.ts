import { z } from 'zod';
import { Types } from 'mongoose';

export const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');

export const idParams = z.object({ id: objectId });

export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};

export const httpUrl = z.string().trim().url('Must be a valid URL').refine((v) => /^https:\/\//.test(v), 'Must be an https URL');

/** An uploaded https image, or a self-hosted asset path served by the web client (e.g. /images/catalogue/tomato.jpg). */
export const imageRef = z.union([
  httpUrl,
  z.string().trim().regex(/^\/images\/[a-z0-9/_-]+\.(jpg|jpeg|png|webp)$/i, 'Must be an https URL or /images/… path'),
]);

// coerce turns a missing value into NaN, so give that case a readable message.
export const longitude = z.coerce.number({ invalid_type_error: 'Location (lng) is required' }).min(-180).max(180);
export const latitude = z.coerce.number({ invalid_type_error: 'Location (lat) is required' }).min(-90).max(90);

/** Accepts "2026-11-17" or full ISO strings. */
export const dateInput = z.coerce.date({ invalid_type_error: 'Enter a valid date' });

export const booleanQuery = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();
