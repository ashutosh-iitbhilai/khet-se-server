import { Router } from 'express';
import * as ctrl from '../controllers/product.controller';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate, authorize, optionalAuth } from '../middleware/auth';
import {
  createProductSchema,
  listProductsSchema,
  productParamSchema,
  updateProductSchema,
} from '../validators/product.validator';

const router = Router();
const adminOnly = [authenticate, authorize('admin')];

router.get('/', optionalAuth, validate(listProductsSchema), asyncHandler(ctrl.list));
router.get('/:id', validate(productParamSchema), asyncHandler(ctrl.get));
router.post('/', ...adminOnly, validate(createProductSchema), asyncHandler(ctrl.create));
router.put('/:id', ...adminOnly, validate(updateProductSchema), asyncHandler(ctrl.update));
router.delete('/:id', ...adminOnly, validate(productParamSchema), asyncHandler(ctrl.remove));

export default router;
