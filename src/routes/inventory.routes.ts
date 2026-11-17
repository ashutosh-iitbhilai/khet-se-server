import { Router } from 'express';
import * as ctrl from '../controllers/inventory.controller';
import * as recCtrl from '../controllers/recommendation.controller';
import { listingDetailSchema, nearbyListingsSchema } from '../validators/recommendation.validator';
import { asyncHandler } from '../utils/asyncHandler';
import { publicCache } from '../middleware/cacheControl';
import { validate } from '../middleware/validate';
import { authenticate, authorize } from '../middleware/auth';
import {
  adjustStockSchema,
  createInventorySchema,
  inventoryIdSchema,
  listMyInventorySchema,
  updateInventorySchema,
} from '../validators/inventory.validator';

const router = Router();
const farmerOnly = [authenticate, authorize('farmer')];

// Farmer's own listings — declared before "/:id" so "mine" is not read as an id.
router.get('/mine', ...farmerOnly, validate(listMyInventorySchema), asyncHandler(ctrl.listMine));
router.get('/mine/:id', ...farmerOnly, validate(inventoryIdSchema), asyncHandler(ctrl.getMine));

// Public marketplace: listings near a location, and a single listing.
router.get('/', publicCache(), validate(nearbyListingsSchema), asyncHandler(recCtrl.nearbyListings));
router.get('/:id', publicCache(15, 30), validate(listingDetailSchema), asyncHandler(recCtrl.listingDetail));

router.post('/', ...farmerOnly, validate(createInventorySchema), asyncHandler(ctrl.create));
router.put('/:id', ...farmerOnly, validate(updateInventorySchema), asyncHandler(ctrl.update));
router.patch('/:id/stock', ...farmerOnly, validate(adjustStockSchema), asyncHandler(ctrl.adjustStock));
router.delete('/:id', ...farmerOnly, validate(inventoryIdSchema), asyncHandler(ctrl.remove));

export default router;
