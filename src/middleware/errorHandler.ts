import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError';
import { logger } from '../utils/logger';
import { isProd } from '../config/env';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(ApiError.notFound(`Route ${req.method} ${req.originalUrl} not found`));
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  let error: ApiError;

  if (err instanceof ApiError) {
    error = err;
  } else if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((e) => ({ field: e.path, message: e.message }));
    error = ApiError.badRequest('Validation failed', details);
  } else if (err instanceof mongoose.Error.CastError) {
    error = ApiError.badRequest(`Invalid ${err.path}`);
  } else if (err?.code === 11000) {
    const field = Object.keys(err.keyValue ?? {})[0] ?? 'field';
    error = ApiError.conflict(`Duplicate value for ${field}`);
  } else if (err?.type === 'entity.parse.failed') {
    error = ApiError.badRequest('Malformed JSON body');
  } else {
    logger.error('Unhandled error', err);
    error = new ApiError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
  }

  res.status(error.statusCode).json({
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      ...(!isProd && error.statusCode === 500 && err?.stack ? { stack: err.stack } : {}),
    },
  });
};
