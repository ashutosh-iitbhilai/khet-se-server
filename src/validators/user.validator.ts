import { z } from 'zod';

export const updateMeSchema = z.object({
  body: z
    .object({
      name: z.string().trim().min(2, 'Name is too short').max(80),
      phone: z
        .string()
        .trim()
        .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')
        .or(z.literal('')),
    })
    .partial(),
});

export type UpdateMeInput = z.infer<typeof updateMeSchema>['body'];
