import { Router } from 'express';
import { limiter } from '../middleware/rateLimit';
import { z } from 'zod';
import * as ctrl from '../controllers/misc.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate, authorize } from '../middleware/auth';
import { geoReverseSchema, geoSearchSchema } from '../validators/geo.validator';
import { updateMeSchema } from '../validators/user.validator';

// Geocoding hits a shared public service — keep per-client volume low.
const geoLimiter = limiter({ windowMs: 60 * 1000, limit: 30, message: 'Too many location searches. Wait a moment.' });

export const geoRoutes = Router()
  .get('/search', geoLimiter, validate(geoSearchSchema), asyncHandler(ctrl.geoSearch))
  .get('/reverse', geoLimiter, validate(geoReverseSchema), asyncHandler(ctrl.geoReverse));

const signSchema = z.object({ body: z.object({ kind: z.enum(['farm', 'product', 'certificate']) }) });

export const uploadRoutes = Router()
  .get('/config', asyncHandler(ctrl.uploadConfig))
  .post('/sign', authenticate, authorize('farmer', 'admin'), validate(signSchema), asyncHandler(ctrl.signUpload));

export const userRoutes = Router().patch('/me', authenticate, validate(updateMeSchema), asyncHandler(ctrl.updateMe));
