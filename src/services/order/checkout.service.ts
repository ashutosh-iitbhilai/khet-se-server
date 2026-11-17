import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { startOnlinePayment } from '../payments/payment.service';
import { razorpayEnabled } from '../payments/razorpay';
import { forCustomer, placeOrder, transitionGroup } from './order.service';
import type { PlaceOrderInput } from '../../validators/order.validator';

/**
 * Place the order (stock reserved), then — for online payment — open a payment with the
 * provider. If the provider can't be reached, the new order is cancelled so its stock is
 * released straight away instead of waiting for the expiry job.
 */
export async function checkout(customerId: string, idempotencyKey: string, input: PlaceOrderInput) {
  if (input.paymentMethod === 'online' && !razorpayEnabled()) {
    throw ApiError.badRequest('Online payment is not available yet. Please choose cash on delivery.');
  }
  const { order, replayed } = await placeOrder(customerId, idempotencyKey, input);

  let payment = null;
  if (order.paymentMethod === 'online' && order.paymentStatus === 'pending') {
    try {
      payment = await startOnlinePayment(order);
    } catch (err) {
      if (!replayed) {
        for (const g of order.groups.filter((x) => x.status === 'pending')) {
          await transitionGroup(String(order._id), String(g._id), 'cancelled', { actor: 'system', note: 'Payment could not be started' }).catch(
            (e) => logger.warn('Cleanup after payment failure failed', e),
          );
        }
      }
      throw err instanceof ApiError ? err : new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'Online payment is unavailable right now.');
    }
  }
  return { order: forCustomer(order), payment, replayed };
}
