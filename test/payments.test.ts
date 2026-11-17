/**
 * Online payment flow with the Razorpay HTTP API mocked. Payment keys must be in the
 * environment before the app is imported, hence the dynamic imports below.
 */
import crypto from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const KEY_SECRET = 'rzp_test_secret_for_tests';
const WEBHOOK_SECRET = 'whsec_for_tests';
process.env.RAZORPAY_KEY_ID = 'rzp_test_key';
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;

const h = await import('./helpers');
const { Order } = await import('../src/models/Order');
const { Payment } = await import('../src/models/Payment');
const { expireUnpaidOrders } = await import('../src/services/order/order.service');

h.useDatabase();

// Mock only Razorpay's "create order" call; everything else goes through untouched.
const realFetch = globalThis.fetch;
let rzpCounter = 0;
let rzpDown = false;
beforeAll(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://api.razorpay.com/v1/orders') {
      if (rzpDown) return new Response('{"error":{}}', { status: 500 });
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: `order_TEST${++rzpCounter}`, amount: body.amount, currency: 'INR', status: 'created' }), { status: 200 });
    }
    return realFetch(input, init);
  });
});
afterAll(() => vi.restoreAllMocks());

const sign = (data: string, secret: string) => crypto.createHmac('sha256', secret).update(data).digest('hex');

let farm: Awaited<ReturnType<typeof h.createFarm>>;
let listing: string;
beforeAll(async () => {
  farm = await h.createFarm({ lng: h.eastKm(2) });
  listing = await h.addListing(farm.token, 'tomato', { price: 50, quantityAvailable: 100 });
});

async function startOnlineOrder() {
  const c = await h.createCustomer();
  const res = await h.placeOrder(c.token, c.addressId, [{ listing, quantity: 2 }], { paymentMethod: 'online' });
  expect(res.status).toBe(201);
  return { c, order: res.body.data.order, payment: res.body.data.payment };
}

describe('online payments', () => {
  it('advertises online payment when keys are set', async () => {
    const res = await h.http().get('/api/payments/methods');
    expect(res.body.data).toEqual({ cod: true, online: true });
  });

  it('creates a provider order and confirms a correctly signed payment', async () => {
    const { c, order, payment } = await startOnlineOrder();
    expect(payment.razorpayOrderId).toMatch(/^order_TEST/);
    expect(payment.amount).toBe(Math.round(order.grandTotal * 100));
    expect(order.paymentStatus).toBe('pending');

    const bad = await h.http().post('/api/payments/razorpay/verify').set(h.auth(c.token)).send({
      orderId: order.id, razorpayOrderId: payment.razorpayOrderId, razorpayPaymentId: 'pay_FAKE1', signature: sign('wrong', KEY_SECRET),
    });
    expect(bad.status).toBe(400);

    const ok = await h.http().post('/api/payments/razorpay/verify').set(h.auth(c.token)).send({
      orderId: order.id, razorpayOrderId: payment.razorpayOrderId, razorpayPaymentId: 'pay_REAL1', signature: sign(`${payment.razorpayOrderId}|pay_REAL1`, KEY_SECRET),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.data.order.paymentStatus).toBe('paid');

    // Now the farmer can see and accept it.
    const queue = await h.http().get('/api/orders/farmer?view=incoming').set(h.auth(farm.token));
    expect(queue.body.data.map((o: { id: string }) => o.id)).toContain(order.id);
  });

  it('webhook confirms payment exactly once, even alongside the browser callback', async () => {
    const { order, payment } = await startOnlineOrder();
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_WH1', order_id: payment.razorpayOrderId } } } });
    const send = (sig: string) => h.http().post('/api/payments/razorpay/webhook').set({ 'Content-Type': 'application/json', 'X-Razorpay-Signature': sig }).send(body);

    expect((await send(sign(body, 'wrong-secret'))).status).toBe(401);
    const results = await Promise.all([send(sign(body, WEBHOOK_SECRET)), send(sign(body, WEBHOOK_SECRET))]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect((await Order.findById(order.id))!.paymentStatus).toBe('paid');
    expect(await Payment.countDocuments({ order: order.id, status: 'paid' })).toBe(1);
  });

  it('a farm rejecting a paid order creates a refund due', async () => {
    const { c, order, payment } = await startOnlineOrder();
    await h.http().post('/api/payments/razorpay/verify').set(h.auth(c.token)).send({
      orderId: order.id, razorpayOrderId: payment.razorpayOrderId, razorpayPaymentId: 'pay_R2', signature: sign(`${payment.razorpayOrderId}|pay_R2`, KEY_SECRET),
    }).expect(200);
    const groupId = order.groups[0]._id;
    await h.http().put(`/api/orders/${order.id}/status`).set(h.auth(farm.token)).send({ groupId, status: 'rejected' }).expect(200);
    const o = await Order.findById(order.id);
    expect(o!.paymentStatus).toBe('refund_pending');
    expect(o!.refundDue).toBe(order.grandTotal);
  });

  it('a payment that lands after the order expired is flagged for refund, not lost', async () => {
    const { order, payment } = await startOnlineOrder();
    await Order.updateOne({ _id: order.id }, { $set: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await expireUnpaidOrders();
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_LATE', order_id: payment.razorpayOrderId } } } });
    await h.http().post('/api/payments/razorpay/webhook').set({ 'Content-Type': 'application/json', 'X-Razorpay-Signature': sign(body, WEBHOOK_SECRET) }).send(body).expect(200);
    const o = await Order.findById(order.id);
    expect(o!.status).toBe('cancelled');
    expect(o!.paymentStatus).toBe('refund_pending');
    expect(o!.refundDue).toBe(order.grandTotal);
  });

  it('if the provider is down, the new order is cancelled and its stock released at once', async () => {
    const c = await h.createCustomer();
    const before = (await (await import('../src/models/Inventory')).Inventory.findById(listing).lean())!.quantityAvailable;
    rzpDown = true;
    const res = await h.placeOrder(c.token, c.addressId, [{ listing, quantity: 1 }], { paymentMethod: 'online' });
    rzpDown = false;
    expect(res.status).toBe(502);
    const after = (await (await import('../src/models/Inventory')).Inventory.findById(listing).lean())!.quantityAvailable;
    expect(after).toBe(before);
  });
});
