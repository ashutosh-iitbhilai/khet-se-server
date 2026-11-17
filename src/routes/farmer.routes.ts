import { Router } from 'express';
import * as ctrl from '../controllers/farmer.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { publicCache } from '../middleware/cacheControl';
import { validate } from '../middleware/validate';
import { authenticate, authorize } from '../middleware/auth';
import { farmerIdSchema, upsertProfileSchema } from '../validators/farmer.validator';
import * as recCtrl from '../controllers/recommendation.controller';
import { nearbyFarmersSchema } from '../validators/recommendation.validator';

const router = Router();
const farmerOnly = [authenticate, authorize('farmer')];

// Static paths must come before "/:id".
router.get('/me', ...farmerOnly, asyncHandler(ctrl.getMe));
router.get('/me/overview', ...farmerOnly, asyncHandler(ctrl.getOverview));
router.post('/profile', ...farmerOnly, validate(upsertProfileSchema), asyncHandler(ctrl.createProfile));
router.put('/profile', ...farmerOnly, validate(upsertProfileSchema), asyncHandler(ctrl.updateProfile));
router.get('/nearby', publicCache(), validate(nearbyFarmersSchema), asyncHandler(recCtrl.nearbyFarmers));
router.get('/:id', publicCache(60, 120), validate(farmerIdSchema), asyncHandler(ctrl.getPublic));

export default router;
