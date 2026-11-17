import { Order, type OrderDocument } from '../../models/Order';
import { Payment, type PaymentDocument } from '../../models/Payment';
import { User } from '../../models/User';
import { env } from '../../config/env';
import { ApiError } from '../../utils/ApiError';
import { logger } from '../../utils/logger';
import { derivePayment } from '../order/rules';
import { createRazorpayOrder, razorpayEnabled, verifyCheckoutSignature, verifyWebhookSignature } from './razorpay';

export function availableMethods() {
  return { cod: true, online: razorpayEnabled() };
}

/** Records the cash-on-delivery "payment" so every order has a payment trail. */
export async function recordCod(order: OrderDocument) {
  await Payment.create({ order: order._id, customer: order.customer, provider: 'cod', amount: order.grandTotal });
}

/** Keeps the COD payment record in step with the order (called after status changes). */
export async function syncCodRecord(order: OrderDocument) {
  if (order.paymentMethod !== 'cod') return;
  if (order.paymentStatus === 'paid') {
    await Payment.updateOne({ order: order._id, provider: 'cod', status: 'created' }, { $set: { status: 'paid', paidAt: new Date() } });
  } else if (order.paymentStatus === 'cancelled') {
    await Payment.updateOne({ order: order._id, provider: 'cod', status: 'created' }, { $set: { status: 'cancelled' } });
  }
}

/** Parameters the browser needs to open Razorpay Checkout for this order. */
export async function startOnlinePayment(order: OrderDocument) {
  if (!razorpayEnabled()) throw ApiError.badRequest('Online payment is not available. Please choose cash on delivery.');
  if (order.paymentMethod !== 'online' || order.paymentStatus !== 'pending') throw ApiError.conflict('This order does not need payment');
  if (order.reservationExpiresAt && order.reservationExpiresAt < new Date()) {
    throw ApiError.conflict('The payment window for this order has closed. Please place the order again.');
  }

  const rp = await createRazorpayOrder(order.grandTotal, order.orderNumber, { orderId: String(order._id) });
  await Payment.create({
    order: order._id,
    customer: order.customer,
    provider: 'razorpay',
    amount: order.grandTotal,
    providerOrderId: rp.id,
  });
  const customer = await User.findById(order.customer, 'name email phone');
  return {
    provider: 'razorpay' as const,
    keyId: env.RAZORPAY_KEY_ID,
    razorpayOrderId: rp.id,
    amount: rp.amount,
    currency: rp.currency,
    orderNumber: order.orderNumber,
    expiresAt: order.reservationExpiresAt,
    prefill: { name: customer?.name, email: customer?.email, contact: customer?.phone },
  };
}

/** Customer retries payment for their own pending order (e.g. closed the payment window). */
export async function retryPayment(customerId: string, orderId: string) {
  const order = await Order.findOne({ _id: orderId, customer: customerId });
  if (!order) throw ApiError.notFound('Order not found');
  return startOnlinePayment(order);
}

/**
 * Marks a payment as paid exactly once, then updates the order. If the order had already
 * expired (stock released), the money is flagged as a refund rather than lost.
 */
async function markPaid(payment: PaymentDocument, providerPaymentId: string) {
  const res = await Payment.updateOne(
    { _id: payment._id, status: 'created' },
    { $set: { status: 'paid', providerPaymentId, paidAt: new Date() } },
  );
  if (res.modifiedCount === 0) return; // already processed (browser callback + webhook both arrive)

  const order = await Order.findById(payment.order);
  if (!order) return;
  const pay = derivePayment('online', 'paid', order.groups);
  await Order.updateOne(
    { _id: order._id, paymentStatus: { $in: ['pending', 'cancelled'] } },
    { $set: { paymentStatus: pay.paymentStatus, refundDue: pay.refundDue, reservationExpiresAt: null } },
  );
  logger.info(`Payment received for ${order.orderNumber}: ₹${payment.amount}${pay.refundDue ? ` (refund due ₹${pay.refundDue})` : ''}`);
}

export async function verifyCheckout(
  customerId: string,
  input: { orderId: string; razorpayOrderId: string; razorpayPaymentId: string; signature: string },
) {
  const payment = await Payment.findOne({ order: input.orderId, customer: customerId, providerOrderId: input.razorpayOrderId });
  if (!payment) throw ApiError.notFound('Payment not found');
  if (!verifyCheckoutSignature(input.razorpayOrderId, input.razorpayPaymentId, input.signature)) {
    await Payment.updateOne({ _id: payment._id, status: 'created' }, { $set: { failureReason: 'Invalid signature' } });
    throw ApiError.badRequest('We could not verify this payment. If money was deducted, it will be confirmed automatically or refunded.');
  }
  await markPaid(payment, input.razorpayPaymentId);
  return Order.findById(input.orderId);
}

/** Razorpay webhook — the source of truth even if the customer's browser closed mid-payment. */
export async function handleWebhook(rawBody: Buffer, signature: string | undefined) {
  if (!signature || !verifyWebhookSignature(rawBody, signature)) throw ApiError.unauthorized('Invalid webhook signature');
  const event = JSON.parse(rawBody.toString('utf8')) as {
    event: string;
    payload?: { payment?: { entity?: { id: string; order_id: string; error_description?: string } } };
  };
  const entity = event.payload?.payment?.entity;
  if (!entity?.order_id) return { ignored: true };

  const payment = await Payment.findOne({ providerOrderId: entity.order_id });
  if (!payment) return { ignored: true };

  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    await markPaid(payment, entity.id);
  } else if (event.event === 'payment.failed') {
    await Payment.updateOne({ _id: payment._id, status: 'created' }, { $set: { failureReason: entity.error_description ?? 'Payment failed' } });
  }
  return { ok: true };
}
