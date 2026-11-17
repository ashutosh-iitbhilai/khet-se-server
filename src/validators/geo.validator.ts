import { z } from 'zod';
import { latitude, longitude } from './common';

export const geoSearchSchema = z.object({
  query: z.object({ q: z.string().trim().min(3, 'Type at least 3 characters').max(120) }),
});

export const geoReverseSchema = z.object({
  query: z.object({ lat: latitude, lng: longitude }),
});
