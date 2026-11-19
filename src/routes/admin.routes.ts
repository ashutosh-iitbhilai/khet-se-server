import { Router } from 'express';
import * as ctrl from '../controllers/admin.controller';
import { authenticate, authorize } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  auditSchema,
  cancelGroupSchema,
  decideVerificationSchema,
  listOrdersSchema,
  listPaymentsSchema,
  listUsersSchema,
  orderIdSchema,
  recordRefundSchema,
  setStatusSchema,
  userIdSchema,
  verificationQueueSchema,
} from '../validators/admin.validator';

/** Admin console. Every route requires an admin session; every change is audited. */
const router = Router();
router.use(authenticate, authorize('admin'));

router.get('/overview', asyncHandler(ctrl.overview));
router.get('/users', validate(listUsersSchema), asyncHandler(ctrl.users));
router.get('/users/:id', validate(userIdSchema), asyncHandler(ctrl.user));
router.patch('/users/:id/status', validate(setStatusSchema), asyncHandler(ctrl.setStatus));
router.get('/verification', validate(verificationQueueSchema), asyncHandler(ctrl.verificationQueue));
router.post('/farmers/:id/verification', validate(decideVerificationSchema), asyncHandler(ctrl.decideVerification));
router.get('/orders', validate(listOrdersSchema), asyncHandler(ctrl.orders));
router.get('/orders/:id', validate(orderIdSchema), asyncHandler(ctrl.order));
router.post('/orders/:id/groups/:groupId/cancel', validate(cancelGroupSchema), asyncHandler(ctrl.cancelGroup));
router.post('/orders/:id/refunds', validate(recordRefundSchema), asyncHandler(ctrl.recordRefund));
router.get('/payments', validate(listPaymentsSchema), asyncHandler(ctrl.payments));
router.get('/audit', validate(auditSchema), asyncHandler(ctrl.audit));

export default router;
