import { Router } from 'express';
import * as ctrl from '../controllers/recommendation.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { publicCache } from '../middleware/cacheControl';
import { validate } from '../middleware/validate';
import { nearbyFarmersSchema, nearbyListingsSchema } from '../validators/recommendation.validator';

const router = Router();

router.get('/farmers', publicCache(), validate(nearbyFarmersSchema), asyncHandler(ctrl.recommendedFarmers));
router.get('/products', publicCache(), validate(nearbyListingsSchema), asyncHandler(ctrl.recommendedProducts));

export default router;
