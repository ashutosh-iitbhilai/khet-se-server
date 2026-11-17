import { z } from 'zod';
import { idParams, imageRef, latitude, longitude } from './common';

const farmBody = z.object({
  name: z.string().trim().min(2, 'Farm name is too short').max(100),
  description: z.string().trim().max(1500).optional(),
  city: z
    .string()
    .trim()
    .min(2)
    .max(60)
    .transform((v) => v.toLowerCase().replace(/\s+/g, '-')),
  address: z.object({
    line1: z.string().trim().min(3, 'Enter the farm address').max(200),
    village: z.string().trim().max(100).optional(),
    district: z.string().trim().max(100).optional(),
    state: z.string().trim().min(2).max(60),
    pincode: z.string().trim().regex(/^\d{6}$/, 'Enter a 6-digit PIN code'),
  }),
  location: z.object({ lng: longitude, lat: latitude }),
  areaAcres: z.coerce.number().min(0).max(100000).optional(),
  images: z.array(imageRef).max(8, 'At most 8 photos').optional(),
  deliveryRadiusKm: z.coerce.number().min(1).max(50).optional(),
  deliveryAvailable: z.boolean().optional(),
  pickupAvailable: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const createFarmSchema = z.object({ body: farmBody });
export const updateFarmSchema = z.object({ params: idParams, body: farmBody.partial() });

export type FarmInput = z.infer<typeof farmBody>;
