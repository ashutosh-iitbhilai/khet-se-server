import { z } from 'zod';
import { mobile } from './common';

export const updateMeSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2, 'Name is too short').max(80),
      // Can be changed, not removed: it is how people log in and how farmers and partners reach them.
      phone: mobile,
      // Optional: used for password-reset emails. An empty value removes it.
      email: z.string().trim().toLowerCase().email('Enter a valid email').or(z.literal('')),
    })
    .partial(),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>['body'];
