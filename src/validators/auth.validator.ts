import { z } from 'zod';
import { mobile, normalizePhone } from './common';

const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password is too long')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

const email = z.string().trim().toLowerCase().email('Enter a valid email');

export const registerSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, 'Name is too short').max(80),
    // Mobile number is the login; email is optional (needed only for password-reset emails).
    phone: mobile,
    email: email.optional().or(z.literal('').transform(() => undefined)),
    password,
    // Admins are never self-registered.
    role: z.enum(['customer', 'farmer', 'delivery']).default('customer'),
  }),
});

/**
 * "Mobile number or email" in one field. Older clients that send `email` still work.
 * Resolves to exactly one of { phone } or { email }.
 */
const identifier = z
  .string({ required_error: 'Enter your mobile number or email' })
  .trim()
  .min(1, 'Enter your mobile number or email')
  .transform((v, ctx) => {
    if (v.includes('@')) {
      const parsed = email.safeParse(v);
      if (parsed.success) return { email: parsed.data };
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid email' });
      return z.NEVER;
    }
    const phone = normalizePhone(v);
    if (/^[6-9]\d{9}$/.test(phone)) return { phone };
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Enter a valid 10-digit mobile number or an email' });
    return z.NEVER;
  });

export const loginSchema = z.object({
  body: z
    .object({
      identifier: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      password: z.string().min(1, 'Password is required'),
    })
    .transform((b, ctx) => {
      const raw = b.identifier ?? b.phone ?? b.email ?? '';
      const parsed = identifier.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['identifier'] });
        return z.NEVER;
      }
      return { ...parsed.data, password: b.password };
    }),
});

/** Mobile number or email; the reset link goes to the email on the account. */
export const forgotPasswordSchema = z.object({
  body: z
    .object({ identifier: z.string().optional(), email: z.string().optional() })
    .transform((b, ctx) => {
      const parsed = identifier.safeParse(b.identifier ?? b.email ?? '');
      if (!parsed.success) {
        for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ['identifier'] });
        return z.NEVER;
      }
      return parsed.data;
    }),
});

export const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().trim().min(20, 'This reset link is incomplete').max(200),
    password,
  }),
});

export const googleStartSchema = z.object({
  query: z.object({
    role: z.enum(['customer', 'farmer', 'delivery']).default('customer'),
    next: z.string().max(200).optional(),
  }),
});

export type RegisterInput = z.infer<typeof registerSchema>['body'];
export type LoginInput = z.infer<typeof loginSchema>['body'];
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>['body'];
