import { Router } from 'express';
import * as ctrl from '../controllers/farm.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate, authorize } from '../middleware/auth';
import { createFarmSchema, updateFarmSchema } from '../validators/farm.validator';

const router = Router();
router.use(authenticate, authorize('farmer'));

router.get('/mine', asyncHandler(ctrl.listMine));
router.post('/', validate(createFarmSchema), asyncHandler(ctrl.create));
router.put('/:id', validate(updateFarmSchema), asyncHandler(ctrl.update));

export default router;
