import { z } from 'zod';
import { VEHICLES } from '../models/DeliveryPartner';
import { idParams, latitude, longitude, objectId, pagination } from './common';

export const updatePartnerProfileSchema = z.object({
  body: z
    .object({
      vehicle: z.enum(VEHICLES).optional(),
      base: z.object({ lng: longitude, lat: latitude, label: z.string().trim().max(120).optional() }).optional(),
      serviceRadiusKm: z.coerce.number().min(1).max(30).optional(),
      isOnline: z.boolean().optional(),
    })
    .refine((b) => Object.keys(b).length > 0, 'Nothing to update'),
});

export const availableJobsSchema = z.object({ query: z.object({ ...pagination }) });

export const myJobsSchema = z.object({
  query: z.object({ view: z.enum(['active', 'completed']).default('active'), ...pagination }),
});

export const jobIdSchema = z.object({ params: idParams });

export const deliverSchema = z.object({
  params: idParams,
  body: z.object({ code: z.string().trim().regex(/^\d{4}$/, 'Enter the 4-digit code') }),
});

export const groupDeliverySchema = z.object({ params: z.object({ id: objectId, groupId: objectId }) });
