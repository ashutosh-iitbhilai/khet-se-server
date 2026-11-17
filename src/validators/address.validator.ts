import { z } from 'zod';
import { ADDRESS_LABELS } from '../models/Address';
import { idParams, latitude, longitude } from './common';

const addressBody = z.object({
  label: z.enum(ADDRESS_LABELS).default('home'),
  name: z.string().trim().min(2, 'Enter the receiver’s name').max(80),
  phone: z.string().trim().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number'),
  line1: z.string().trim().min(5, 'Enter house / flat and street').max(200),
  landmark: z.string().trim().max(120).optional(),
  city: z.string().trim().min(2).max(60),
  pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit PIN code'),
  location: z.object({ lng: longitude, lat: latitude }),
  isDefault: z.boolean().optional(),
});

export const createAddressSchema = z.object({ body: addressBody });
export const updateAddressSchema = z.object({ params: idParams, body: addressBody.partial() });
export const addressIdSchema = z.object({ params: idParams });

export type AddressInput = z.infer<typeof addressBody>;
