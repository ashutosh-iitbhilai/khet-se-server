import { Router } from 'express';
import * as ctrl from '../controllers/delivery.controller';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  availableJobsSchema,
  deliverSchema,
  jobIdSchema,
  myJobsSchema,
  updatePartnerProfileSchema,
} from '../validators/delivery.validator';

const partnerOnly = [authenticate, authorize('delivery')];

/** Delivery partners: profile, job board, and their own deliveries. */
export default Router()
  .get('/profile', ...partnerOnly, asyncHandler(ctrl.profile))
  .put('/profile', ...partnerOnly, validate(updatePartnerProfileSchema), asyncHandler(ctrl.updateProfile))
  .get('/overview', ...partnerOnly, asyncHandler(ctrl.overview))
  .get('/jobs/available', ...partnerOnly, validate(availableJobsSchema), asyncHandler(ctrl.available))
  .get('/jobs', ...partnerOnly, validate(myJobsSchema), asyncHandler(ctrl.mine))
  .post('/jobs/:id/accept', ...partnerOnly, validate(jobIdSchema), asyncHandler(ctrl.accept))
  .post('/jobs/:id/release', ...partnerOnly, validate(jobIdSchema), asyncHandler(ctrl.release))
  .post('/jobs/:id/pickup', ...partnerOnly, validate(jobIdSchema), asyncHandler(ctrl.pickUp))
  .post('/jobs/:id/deliver', ...partnerOnly, validate(deliverSchema), asyncHandler(ctrl.deliver));
