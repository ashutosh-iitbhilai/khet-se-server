import { z } from 'zod';
import { Types } from 'mongoose';
import { env } from '../config/env';

export const objectId = z.string().refine((v) => Types.ObjectId.isValid(v), 'Invalid id');

export const idParams = z.object({ id: objectId });

/**
 * Indian mobile number in any common written form ("+91 98765 43210", "098765-43210",
 * "9876543210") → the 10 digits we store. Anything else fails with a readable message.
 */
export const normalizePhone = (value: string) => {
  let d = value.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
};
export const mobile = z
  .string({ required_error: 'Enter your mobile number' })
  .trim()
  .transform(normalizePhone)
  .refine((v) => /^[6-9]\d{9}$/.test(v), 'Enter a valid 10-digit mobile number');

export const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};

export const httpUrl = z.string().trim().url('Must be a valid URL').refine((v) => /^https:\/\//.test(v), 'Must be an https URL');

const IMAGE_HOSTS_MESSAGE = `Photos must come from ${env.ALLOWED_IMAGE_HOSTS.join(', ')}`;

// Zod still runs refinements after an earlier check (like .url()) fails, so never assume a valid URL here.
function approvedImageHost(value: string) {
  try {
    return env.ALLOWED_IMAGE_HOSTS.includes(new URL(value).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * A photo shown to other users: an https URL on an approved image host (our Cloudinary
 * account, or the photo libraries the catalogue uses), or a self-hosted asset path served by
 * the web client (e.g. /images/catalogue/tomato.jpg). Arbitrary hosts are refused so a
 * listing can't make every visitor's browser load content from an unknown server.
 */
export const imageRef = z.union([
  httpUrl.refine(approvedImageHost, IMAGE_HOSTS_MESSAGE),
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
