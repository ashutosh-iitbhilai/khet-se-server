import { beforeAll, describe, expect, it } from 'vitest';
import { Inventory } from '../src/models/Inventory';
import { Order } from '../src/models/Order';
import { Payment } from '../src/models/Payment';
import { Delivery } from '../src/models/Delivery';
import { transactionsSupported } from '../src/config/db';
import { expireUnpaidOrders, placeOrder as placeOrderService } from '../src/services/order/order.service';
import { buildQuote } from '../src/services/order/quote.service';
import { RAIPUR, addListing, auth, createCustomer, createFarm, eastKm, http, placeOrder, quote, useDatabase } from './helpers';

useDatabase();

const stock = async (id: string) => {
  const l = await Inventory.findById(id).lean();
  return { a: l!.quantityAvailable, r: l!.quantityReserved };
};

let farmA: Awaited<ReturnType<typeof createFarm>>;
let farmB: Awaited<ReturnType<typeof createFarm>>;
let tomato: string; // farm A, kg
let chilli: string; // farm A, packet
let spinach: string; // farm B, bunch

beforeAll(async () => {
  farmA = await createFarm({ name: 'Farm A', lng: eastKm(3) });
  farmB = await createFarm({ name: 'Farm B', lng: eastKm(-4) });
  tomato = await addListing(farmA.token, 'tomato', { price: 40, quantityAvailable: 100 });
  chilli = await addListing(farmA.token, 'dried-red-chilli', { price: 90, quantityAvailable: 20 });
  spinach = await addListing(farmB.token, 'spinach', { price: 30, quantityAvailable: 40 });
});

it('runs on a replica set, so checkout uses real transactions', () => {
  expect(transactionsSupported()).toBe(true);
});

describe('quote', () => {
  it('prices groups per farm with delivery fees', async () => {
    const q = await quote([
      { listing: tomato, quantity: 2 },
      { listing: spinach, quantity: 1 },
    ]);
    expect(q.groups).toHaveLength(2);
    expect(q.issues).toEqual([]);
    const a = q.groups.find((g: { farmName: string }) => g.farmName === 'Farm A');
    expect(a.subtotal).toBe(80);
    expect(a.deliveryFee).toBe(20 + 3 * Math.ceil(a.distanceKm));
    expect(q.grandTotal).toBeCloseTo(q.itemsTotal + q.deliveryTotal, 2);
  });

  it('flags quantity steps, stock and reach', async () => {
    const q = await quote([
      { listing: tomato, quantity: 1.3 }, // not a ¼ kg step
      { listing: chilli, quantity: 1.5 }, // packets are whole
      { listing: spinach, quantity: 999 }, // more than stock
    ]);
    expect(q.issues.map((i: { code: string }) => i.code).sort()).toEqual(['INSUFFICIENT_STOCK', 'INVALID_QUANTITY', 'INVALID_QUANTITY']);
    const far = await quote([{ listing: tomato, quantity: 1 }], { lng: eastKm(60), lat: RAIPUR.lat });
    expect(far.issues[0].code).toBe('NOT_DELIVERABLE');
  });
});

describe('placing orders', () => {
  it('reserves stock once, even when the same request is retried', async () => {
    const c = await createCustomer();
    const before = await stock(tomato);
    const first = await placeOrder(c.token, c.addressId, [{ listing: tomato, quantity: 2 }], { key: 'retry-key-0001' });
    const retry = await placeOrder(c.token, c.addressId, [{ listing: tomato, quantity: 2 }], { key: 'retry-key-0001' });
    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retry.body.data.replayed).toBe(true);
    expect(retry.body.data.order.id).toBe(first.body.data.order.id);
    expect(await stock(tomato)).toEqual({ a: before.a - 2, r: before.r + 2 });
    expect(await Payment.countDocuments({ order: first.body.data.order.id, provider: 'cod' })).toBe(1);
  });

  it('refuses when the total changed since the customer looked', async () => {
    const c = await createCustomer();
    const res = await placeOrder(c.token, c.addressId, [{ listing: spinach, quantity: 1 }], { expectedTotal: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PRICE_CHANGED');
    expect(res.body.error.details.grandTotal).toBeGreaterThan(1);
  });

  it('requires an Idempotency-Key and a customer account', async () => {
    const c = await createCustomer();
    const noKey = await http().post('/api/orders').set(auth(c.token)).send({ items: [{ listing: spinach, quantity: 1 }], addressId: c.addressId, paymentMethod: 'cod', expectedTotal: 1 });
    expect(noKey.status).toBe(400);
    const asFarmer = await placeOrder(farmA.token, c.addressId, [{ listing: spinach, quantity: 1 }]);
    expect(asFarmer.status).toBe(403);
  });

  it('never oversells: 6 buyers race for the last 3 units', async () => {
    const id = await addListing(farmB.token, 'coriander', { price: 15, quantityAvailable: 3 });
    const buyers = await Promise.all(Array.from({ length: 6 }, () => createCustomer()));
    const total = (await quote([{ listing: id, quantity: 1 }])).grandTotal;
    const results = await Promise.all(buyers.map((b) => placeOrder(b.token, b.addressId, [{ listing: id, quantity: 1 }], { expectedTotal: total })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 201, 201, 409, 409, 409]);
    expect(await stock(id)).toEqual({ a: 0, r: 3 });
  });

  it('rolls back the whole order if any line runs out mid-checkout', async () => {
    const c = await createCustomer();
    const before = { tomato: await stock(tomato), chilli: await stock(chilli) };
    // Quote while stock exists, then drain chilli behind the customer's back.
    const total = (await quote([{ listing: tomato, quantity: 1 }, { listing: chilli, quantity: 1 }])).grandTotal;
    await Inventory.updateOne({ _id: chilli }, { $set: { quantityAvailable: 0 } });
    const res = await placeOrder(c.token, c.addressId, [{ listing: tomato, quantity: 1 }, { listing: chilli, quantity: 1 }], { expectedTotal: total });
    expect(res.status).toBe(409);
    expect(await stock(tomato)).toEqual(before.tomato); // nothing half-reserved
    await Inventory.updateOne({ _id: chilli }, { $set: { quantityAvailable: before.chilli.a } });
  });
});

describe('fulfilment', () => {
  it('runs the full farmer flow with the handover code, per farm', async () => {
    const c = await createCustomer();
    const before = { tomato: await stock(tomato), spinach: await stock(spinach) };
    const res = await placeOrder(c.token, c.addressId, [
      { listing: tomato, quantity: 1.5 },
      { listing: spinach, quantity: 2 },
    ]);
    expect(res.status).toBe(201);
    const order = res.body.data.order;
    const gA = order.groups.find((g: { farmName: string }) => g.farmName === 'Farm A');
    const gB = order.groups.find((g: { farmName: string }) => g.farmName === 'Farm B');
    expect(gA.handoverCode).toMatch(/^\d{4}$/);

    // Farmer B can't see or touch farm A's group; farmers never see codes.
    const queueA = await http().get('/api/orders/farmer?view=incoming').set(auth(farmA.token));
    const mine = queueA.body.data.find((o: { id: string }) => o.id === order.id);
    expect(mine.groups).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toContain('handoverCode');
    const put = (token: string, body: object) => http().put(`/api/orders/${order.id}/status`).set(auth(token)).send(body);
    expect((await put(farmB.token, { groupId: gA._id, status: 'accepted' })).status).toBe(404);

    // Double-tap accept: exactly one wins.
    const taps = await Promise.all([1, 2, 3].map(() => put(farmA.token, { groupId: gA._id, status: 'accepted' })));
    expect(taps.map((t) => t.status).sort()).toEqual([200, 409, 409]);
    expect(await Delivery.countDocuments({ order: order.id, status: 'scheduled' })).toBe(1);

    await put(farmA.token, { groupId: gA._id, status: 'out_for_delivery' }).expect(200);
    expect((await put(farmA.token, { groupId: gA._id, status: 'delivered', code: gA.handoverCode === '0000' ? '1111' : '0000' })).status).toBe(400);
    await put(farmA.token, { groupId: gA._id, status: 'delivered', code: gA.handoverCode }).expect(200);
    expect(await stock(tomato)).toEqual({ a: before.tomato.a - 1.5, r: before.tomato.r }); // sale final

    await put(farmB.token, { groupId: gB._id, status: 'rejected', note: 'Rain damage' }).expect(200);
    expect(await stock(spinach)).toEqual(before.spinach); // released

    const final = await http().get(`/api/orders/${order.id}`).set(auth(c.token));
    expect(final.body.data.order.status).toBe('completed');
    expect(final.body.data.order.paymentStatus).toBe('paid'); // COD collected for the delivered part
    expect((await Payment.findOne({ order: order.id }))!.status).toBe('paid');
  });

  it('customers can cancel only before the farmer accepts', async () => {
    const c = await createCustomer();
    const before = await stock(tomato);
    const res = await placeOrder(c.token, c.addressId, [{ listing: tomato, quantity: 1 }]);
    const id = res.body.data.order.id;
    const cancel = await http().post(`/api/orders/${id}/cancel`).set(auth(c.token)).send({});
    expect(cancel.status).toBe(200);
    expect(cancel.body.data.order.status).toBe('cancelled');
    expect(await stock(tomato)).toEqual(before);
    expect((await http().post(`/api/orders/${id}/cancel`).set(auth(c.token)).send({})).status).toBe(409);
  });

  it("hides other people's orders", async () => {
    const owner = await createCustomer();
    const other = await createCustomer();
    const res = await placeOrder(owner.token, owner.addressId, [{ listing: spinach, quantity: 1 }]);
    expect((await http().get(`/api/orders/${res.body.data.order.id}`).set(auth(other.token))).status).toBe(404);
    expect((await http().get(`/api/orders/${res.body.data.order.id}`).set(auth(farmA.token))).status).toBe(404);
  });
});

describe('unpaid online orders', () => {
  it('hold stock, stay hidden from farmers, and are released by the expiry job', async () => {
    const c = await createCustomer();
    const before = await stock(spinach);
    const q = await buildQuote([{ listing: spinach, quantity: 2 }], RAIPUR);
    // The service directly: online checkout is disabled in this file (no Razorpay keys).
    const { order } = await placeOrderService(c.userId, 'online-expiry-0001', {
      items: [{ listing: spinach, quantity: 2 }],
      addressId: c.addressId,
      paymentMethod: 'online',
      expectedTotal: q.grandTotal,
    });
    expect(await stock(spinach)).toEqual({ a: before.a - 2, r: before.r + 2 });
    const queue = await http().get('/api/orders/farmer?view=incoming').set(auth(farmB.token));
    expect(queue.body.data.map((o: { id: string }) => o.id)).not.toContain(String(order._id));

    expect((await expireUnpaidOrders()).groupsCancelled).toBe(0); // still inside the window
    await Order.updateOne({ _id: order._id }, { $set: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    expect((await expireUnpaidOrders()).groupsCancelled).toBe(1);
    expect(await stock(spinach)).toEqual(before);
    expect((await Order.findById(order._id))!.paymentStatus).toBe('cancelled');
    expect((await expireUnpaidOrders()).orders).toBe(0); // idempotent
  });

  it('online checkout is refused while payments are not configured', async () => {
    const c = await createCustomer();
    const before = await stock(tomato);
    const res = await placeOrder(c.token, c.addressId, [{ listing: tomato, quantity: 1 }], { paymentMethod: 'online' });
    expect(res.status).toBe(400);
    expect(await stock(tomato)).toEqual(before);
  });
});
