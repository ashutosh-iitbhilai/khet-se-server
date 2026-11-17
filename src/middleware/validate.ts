import type { RequestHandler } from 'express';
import type { AnyZodObject } from 'zod';
import { ApiError } from '../utils/ApiError';

/**
 * Validates { body, query, params } against a Zod schema and replaces them
 * with the parsed (coerced, trimmed, defaulted) values.
 */
export const validate =
  (schema: AnyZodObject): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse({ body: req.body, query: req.query, params: req.params });
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        field: i.path.slice(1).join('.'),
        message: i.message,
      }));
      return next(ApiError.badRequest('Please check the highlighted fields', details));
    }
    const data = result.data as { body?: unknown; query?: unknown; params?: unknown };
    if (data.body !== undefined) req.body = data.body;
    // req.query is a getter in Express 5; assigning keeps Express 4 compatible.
    if (data.query !== undefined) Object.assign(req.query, data.query);
    if (data.params !== undefined) Object.assign(req.params, data.params);
    next();
  };
