import { z } from 'zod';

export const registerSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, 'Name is too short').max(80),
    email: z.string().trim().toLowerCase().email('Enter a valid email'),
    phone: z
      .string()
      .trim()
      .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')
      .optional()
      .or(z.literal('').transform(() => undefined)),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .max(72, 'Password is too long')
      .regex(/[A-Za-z]/, 'Password must contain a letter')
      .regex(/\d/, 'Password must contain a number'),
    // Admins are never self-registered.
    role: z.enum(['customer', 'farmer']).default('customer'),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email('Enter a valid email'),
    password: z.string().min(1, 'Password is required'),
  }),
});

export type RegisterInput = z.infer<typeof registerSchema>['body'];
export type LoginInput = z.infer<typeof loginSchema>['body'];
