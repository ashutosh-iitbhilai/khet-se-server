import rateLimit, { type Options } from 'express-rate-limit';
import { env } from '../config/env';

/**
 * Per-instance, in-memory rate limiting. With several API instances behind a load balancer,
 * plug in a shared store (e.g. rate-limit-redis) so limits apply across instances.
 * Disabled under NODE_ENV=test so the integration suite can make many requests.
 */
export function limiter(opts: { windowMs: number; limit: number; message: string }) {
  const options: Partial<Options> = {
    windowMs: opts.windowMs,
    limit: opts.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => env.NODE_ENV === 'test',
    message: { success: false, error: { code: 'RATE_LIMITED', message: opts.message } },
  };
  return rateLimit(options);
}

/** Generous global limit for all API traffic. */
export const apiLimiter = limiter({ windowMs: 60 * 1000, limit: 300, message: 'Too many requests. Please slow down.' });

/** Strict limit on credential endpoints to slow brute-force attempts. */
export const authLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: 'Too many attempts. Please try again in a few minutes.',
});
