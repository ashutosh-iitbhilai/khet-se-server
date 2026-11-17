import { z } from 'zod';
import { FARMING_PRACTICES } from '../models/Farmer';
import { dateInput, httpUrl, idParams, latitude, longitude } from './common';

const profileBody = z.object({
  bio: z.string().trim().max(1000).optional(),
  experienceYears: z.coerce.number().int().min(0).max(80).optional(),
  languages: z.array(z.string().trim().min(2).max(30)).max(8).optional(),
  practices: z.array(z.enum(FARMING_PRACTICES)).max(FARMING_PRACTICES.length).optional(),
  organicCertification: z
    .object({
      certificateNumber: z.string().trim().min(3).max(80),
      issuer: z.string().trim().min(2).max(120),
      documentUrl: httpUrl.optional(),
      validUntil: dateInput.optional(),
    })
    .optional(),
});

export const upsertProfileSchema = z.object({ body: profileBody });
export const farmerIdSchema = z.object({
  params: idParams,
  query: z.object({ lng: longitude.optional(), lat: latitude.optional() }),
});

export type ProfileInput = z.infer<typeof profileBody>;
