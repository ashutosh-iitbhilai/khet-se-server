import { Router } from 'express';
import { limiter } from '../middleware/rateLimit';
import { z } from 'zod';
import * as ctrl from '../controllers/order.controller';
import * as deliveryCtrl from '../controllers/delivery.controller';
import { groupDeliverySchema } from '../validators/delivery.validator';
import { asyncHandler } from '../utils/asyncHandler';
import { validate } from '../middleware/validate';
import { authenticate, authorize } from '../middleware/auth';
import { addressIdSchema, createAddressSchema, updateAddressSchema } from '../validators/address.validator';
import {
  cancelSchema,
  farmerOrdersSchema,
  groupCodeSchema,
  myOrdersSchema,
  orderIdSchema,
  placeOrderSchema,
  quoteSchema,
  updateStatusSchema,
} from '../validators/order.validator';
import { objectId } from '../validators/common';

const customerOnly = [authenticate, authorize('customer')];
const farmerOnly = [authenticate, authorize('farmer')];

const checkoutLimiter = limiter({ windowMs: 15 * 60 * 1000, limit: 30, message: 'Too many checkout attempts. Please wait a few minutes.' });

export const addressRoutes = Router()
  .get('/', ...customerOnly, asyncHandler(ctrl.listAddresses))
  .post('/', ...customerOnly, validate(createAddressSchema), asyncHandler(ctrl.createAddress))
  .put('/:id', ...customerOnly, validate(updateAddressSchema), asyncHandler(ctrl.updateAddress))
  .delete('/:id', ...customerOnly, validate(addressIdSchema), asyncHandler(ctrl.deleteAddress));

export const orderRoutes = Router()
  // Quote is public so guests can see delivery fees in their cart before logging in.
  .post('/quote', validate(quoteSchema), asyncHandler(ctrl.quote))
  .post('/', ...customerOnly, checkoutLimiter, validate(placeOrderSchema), asyncHandler(ctrl.place))
  .get('/my-orders', ...customerOnly, validate(myOrdersSchema), asyncHandler(ctrl.myOrders))
  .get('/farmer', ...farmerOnly, validate(farmerOrdersSchema), asyncHandler(ctrl.farmerOrders))
  .get('/:id', authenticate, validate(orderIdSchema), asyncHandler(ctrl.getOne))
  .put('/:id/status', ...farmerOnly, validate(updateStatusSchema), asyncHandler(ctrl.updateStatus))
  .post('/:id/cancel', ...customerOnly, validate(cancelSchema), asyncHandler(ctrl.cancel))
  .post('/:id/groups/:groupId/code', ...customerOnly, validate(groupCodeSchema), asyncHandler(ctrl.newCode))
  // Farmer hands the delivery to a Khet Se delivery partner (POST) or takes it back (DELETE).
  .post('/:id/groups/:groupId/delivery-partner', ...farmerOnly, validate(groupDeliverySchema), asyncHandler(deliveryCtrl.requestPartner))
  .delete('/:id/groups/:groupId/delivery-partner', ...farmerOnly, validate(groupDeliverySchema), asyncHandler(deliveryCtrl.cancelPartnerRequest))
  .post('/:id/pay', ...customerOnly, validate(orderIdSchema), asyncHandler(ctrl.retryPayment));

const verifySchema = z.object({
  body: z.object({
    orderId: objectId,
    razorpayOrderId: z.string().min(5).max(64),
    razorpayPaymentId: z.string().min(5).max(64),
    signature: z.string().min(10).max(256),
  }),
});

export const paymentRoutes = Router()
  .get('/methods', asyncHandler(ctrl.paymentMethods))
  .post('/razorpay/verify', ...customerOnly, validate(verifySchema), asyncHandler(ctrl.verifyPayment));

/** Mounted in app.ts with a raw body parser, before express.json(). */
export const razorpayWebhookHandler = asyncHandler(ctrl.razorpayWebhook);
