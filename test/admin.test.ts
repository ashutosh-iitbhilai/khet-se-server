import bcrypt from 'bcryptjs';
import { beforeAll, describe, expect, it } from 'vitest';
import { AdminAction } from '../src/models/AdminAction';
import { Farmer } from '../src/models/Farmer';
import { Inventory } from '../src/models/Inventory';
import { Order } from '../src/models/Order';
import { User } from '../src/models/User';
import { addListing, auth, createCustomer, createFarm, http, placeOrder, quote, RAIPUR, registerUser, uniquePhone, useDatabase } from './helpers';

useDatabase();

async function createAdmin() {
  const phone = uniquePhone();
  await User.create({ name: 'Ops Admin', phone, role: 'admin', status: 'active', passwordHash: await bcrypt.hash('admin-pass-123', 10) });
  const res = await http().post('/api/auth/login').send({ identifier: phone, password: 'admin-pass-123' });
  return { token: res.body.data.token as string, id: res.body.data.user.id as string };
}

describe('admin console', () => {
  let admin: Awaited<ReturnType<typeof createAdmin>>;
  let farm: Awaited<ReturnType<typeof createFarm>>;
  let listing: string;
  const A = () => auth(admin.token);
  const visible = async () => (await http().get(`/api/inventory?lng=${RAIPUR.lng}&lat=${RAIPUR.lat}&limit=50`)).body.data.map((l: { id: string }) => l.id);

  beforeAll(async () => {
    admin = await createAdmin();
    farm = await createFarm({ name: 'Admin Test Farm' });
    listing = await addListing(farm.token, 'tomato', { quantityAvailable: 100 });
  });

  it('is only for admins', async () => {
    const customer = await registerUser('customer');
    expect((await http().get('/api/admin/overview')).status).toBe(401);
    expect((await http().get('/api/admin/overview').set(auth(customer.token))).status).toBe(403);
    expect((await http().get('/api/admin/overview').set(auth(farm.token))).status).toBe(403);
    expect((await http().get('/api/admin/overview').set(A())).status).toBe(200);
  });

  it('overview counts people, verification work, orders and money', async () => {
    const c = await createCustomer();
    expect((await placeOrder(c.token, c.addressId, [{ listing, quantity: 2 }])).status).toBe(201);
    const res = await http().get('/api/admin/overview').set(A());
    expect(res.body.data.users.farmers).toBeGreaterThanOrEqual(1);
    expect(res.body.data.users.customers).toBeGreaterThanOrEqual(1);
    expect(res.body.data.verification.profilesPending).toBeGreaterThanOrEqual(1); // new farmers start pending
    expect(res.body.data.orders.today).toBeGreaterThanOrEqual(1);
    expect(res.body.data.money.codToCollect).toBeGreaterThan(0);
    expect(res.body.data.recentOrders[0]).toHaveProperty('orderNumber');
  });

  it('finds people by name, mobile number or email and shows role details', async () => {
    const c = await registerUser('customer', { name: 'Findable Person' });
    const byPhone = await http().get(`/api/admin/users?q=${c.phone.slice(-6)}`).set(A());
    expect(byPhone.body.data.map((u: { id: string }) => u.id)).toContain(c.user.id);
    const byName = await http().get('/api/admin/users?q=findable&role=customer').set(A());
    expect(byName.body.data).toHaveLength(1);
    const farmers = await http().get('/api/admin/users?role=farmer').set(A());
    expect(farmers.body.data[0].farmer).toHaveProperty('profileStatus');

    const me = await http().get('/api/farmers/me').set(auth(farm.token));
    const detail = await http().get(`/api/admin/users/${me.body.data.farmer.user}`).set(A());
    expect(detail.body.data.user.farmer).toMatchObject({ activeListings: 1 });
    expect(detail.body.data.user.farmer.farms[0].name).toBe('Admin Test Farm');
  });

  it('suspends and reactivates with a reason; a suspended farmer’s produce leaves the marketplace', async () => {
    const me = await http().get('/api/farmers/me').set(auth(farm.token));
    const userId = me.body.data.farmer.user;
    expect((await http().patch(`/api/admin/users/${userId}/status`).set(A()).send({ status: 'suspended' })).status).toBe(400); // reason required
    await http().patch(`/api/admin/users/${userId}/status`).set(A()).send({ status: 'suspended', reason: 'Selling non-organic produce as organic' }).expect(200);
    expect(await visible()).not.toContain(listing);
    expect((await http().get('/api/farmers/me').set(auth(farm.token))).status).toBe(200); // access token still valid…
    await http().patch(`/api/admin/users/${userId}/status`).set(A()).send({ status: 'active', reason: 'Appeal accepted' }).expect(200);
    expect(await visible()).toContain(listing);
    expect(await AdminAction.countDocuments({ targetId: userId })).toBe(2);

    expect((await http().patch(`/api/admin/users/${admin.id}/status`).set(A()).send({ status: 'suspended', reason: 'oops' })).status).toBe(400);
  });

  it('verifies farmers: rejecting a profile needs a note and hides the farm; verifying brings it back', async () => {
    const f = await createFarm({ name: 'Verification Farm' });
    const item = await addListing(f.token, 'onion');
    await http().put('/api/farmers/profile').set(auth(f.token)).send({ bio: 'Onions since 1998.', organicCertification: { certificateNumber: 'PGS-77', issuer: 'PGS-India' } }).expect(200);

    const queue = await http().get('/api/admin/verification?kind=all').set(A());
    const entry = queue.body.data.find((x: { id: string }) => x.id === f.farmerId);
    expect(entry).toMatchObject({ profileStatus: 'pending', organicCertification: { status: 'pending', certificateNumber: 'PGS-77' }, activeListings: 1 });

    const url = `/api/admin/farmers/${f.farmerId}/verification`;
    expect((await http().post(url).set(A()).send({ profile: 'rejected' })).status).toBe(400);
    await http().post(url).set(A()).send({ profile: 'rejected', note: 'Farm address does not match land records' }).expect(200);
    expect(await visible()).not.toContain(item);
    expect((await quote([{ listing: item, quantity: 1 }])).issues[0].code).toBe('UNAVAILABLE');
    expect((await http().get(`/api/farmers/${f.farmerId}`)).status).toBe(404);
    // The farmer sees the decision and the reason.
    const mine = await http().get('/api/farmers/me').set(auth(f.token));
    expect(mine.body.data.farmer).toMatchObject({ profileStatus: 'rejected', profileReviewNote: 'Farm address does not match land records' });

    await http().post(url).set(A()).send({ profile: 'verified', organic: 'verified', note: 'Documents checked' }).expect(200);
    expect(await visible()).toContain(item);
    const organic = await http().get(`/api/inventory?lng=${RAIPUR.lng}&lat=${RAIPUR.lat}&organic=true&limit=50`);
    expect(organic.body.data.map((l: { id: string }) => l.id)).toContain(item);
    expect((await Farmer.findById(f.farmerId))!.organicCertification.reviewedAt).toBeTruthy();
    expect(await AdminAction.countDocuments({ targetId: f.farmerId })).toBe(3);
  });

  it('lists and searches orders, shows the full picture, and cancels part of an order with stock released', async () => {
    const c = await createCustomer();
    const placed = await placeOrder(c.token, c.addressId, [{ listing, quantity: 3 }]);
    expect(placed.status).toBe(201);
    const order = placed.body.data.order;
    const stockBefore = await Inventory.findById(listing).lean();

    const list = await http().get(`/api/admin/orders?q=${order.orderNumber}`).set(A());
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ orderNumber: order.orderNumber, paymentMethod: 'cod' });
    const byPhone = await http().get('/api/admin/orders?q=9876543210').set(A());
    expect(byPhone.body.data.length).toBeGreaterThanOrEqual(1);

    const detail = await http().get(`/api/admin/orders/${order.id}`).set(A());
    expect(detail.body.data.customer).toMatchObject({ id: c.userId });
    expect(detail.body.data.payments[0]).toMatchObject({ provider: 'cod' });

    const cancel = (note?: string) => http().post(`/api/admin/orders/${order.id}/groups/${order.groups[0]._id}/cancel`).set(A()).send({ note });
    expect((await cancel()).status).toBe(400);
    const done = await cancel('Farmer called: crop damaged by hail');
    expect(done.status).toBe(200);
    expect(done.body.data.order.groups[0]).toMatchObject({ status: 'cancelled', cancelReason: 'Cancelled by Khet Se support: Farmer called: crop damaged by hail' });
    const stockAfter = await Inventory.findById(listing).lean();
    expect(stockAfter!.quantityReserved).toBe(stockBefore!.quantityReserved - 3);
    expect(done.body.data.actions[0]).toMatchObject({ action: 'order.group.cancelled', by: 'Ops Admin' });
  });

  it('records refunds paid outside the app, never more than is owed', async () => {
    const c = await createCustomer();
    const placed = await placeOrder(c.token, c.addressId, [{ listing, quantity: 1 }]);
    expect(placed.status).toBe(201);
    const id = placed.body.data.order.id;
    // An online order that was paid and then partly cancelled owes this much back.
    await Order.updateOne({ _id: id }, { $set: { paymentMethod: 'online', paymentStatus: 'refund_pending', refundDue: 80 } });

    const refunds = await http().get('/api/admin/orders?refunds=true').set(A());
    expect(refunds.body.data.find((o: { id: string }) => o.id === id).refundOutstanding).toBe(80);
    const pay = (amount: number) => http().post(`/api/admin/orders/${id}/refunds`).set(A()).send({ amount, reference: 'rfnd_123', note: 'Refunded in Razorpay' });
    expect((await pay(100)).status).toBe(400);
    expect((await pay(50)).body.data.refundOutstanding).toBe(30);
    expect((await pay(30)).body.data.refundOutstanding).toBe(0);
    expect((await pay(1)).status).toBe(409);

    const overview = await http().get('/api/admin/overview').set(A());
    expect(overview.body.data.money.refundsOutstanding).toBe(0);
  });

  it('lists transactions with totals, and keeps an audit trail', async () => {
    const payments = await http().get('/api/admin/payments?provider=cod').set(A());
    expect(payments.body.data.length).toBeGreaterThanOrEqual(1);
    expect(payments.body.meta.totals.some((t: { provider: string }) => t.provider === 'cod')).toBe(true);

    const trail = await http().get('/api/admin/audit').set(A());
    const actions = trail.body.data.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['user.suspended', 'user.reactivated', 'farmer.profile.rejected', 'farmer.profile.verified', 'farmer.organic.verified', 'order.group.cancelled', 'order.refund.recorded']));
    expect(trail.body.data[0]).toMatchObject({ by: 'Ops Admin' });
  });
});
