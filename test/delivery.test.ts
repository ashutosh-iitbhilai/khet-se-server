import { beforeAll, describe, expect, it } from 'vitest';
import { Delivery } from '../src/models/Delivery';
import { Order } from '../src/models/Order';
import { User } from '../src/models/User';
import { addListing, auth, createCustomer, createFarm, eastKm, http, northKm, placeOrder, RAIPUR, registerUser, useDatabase } from './helpers';

useDatabase();

/** A partner with a base near central Raipur, online unless told otherwise. */
async function createPartner(opts: { lng?: number; lat?: number; radiusKm?: number; online?: boolean; phone?: string } = {}) {
  const p = await registerUser('delivery', { phone: opts.phone ?? `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}` });
  const res = await http()
    .put('/api/delivery/profile')
    .set(auth(p.token))
    .send({
      vehicle: 'bike',
      base: { lng: opts.lng ?? RAIPUR.lng, lat: opts.lat ?? RAIPUR.lat, label: 'Pandri' },
      serviceRadiusKm: opts.radiusKm ?? 10,
      isOnline: opts.online ?? true,
    });
  if (res.status !== 200) throw new Error(`profile failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: p.token, userId: p.user.id as string };
}

describe('delivery partners', () => {
  let farm: Awaited<ReturnType<typeof createFarm>>;
  let listing: string;

  beforeAll(async () => {
    farm = await createFarm({ name: 'Partner Test Farm', lng: eastKm(2), lat: RAIPUR.lat, radiusKm: 15 });
    listing = await addListing(farm.token, 'tomato', { quantityAvailable: 500 });
  });

  /** A COD order accepted by the farmer: the starting point for every delivery. */
  async function acceptedOrder() {
    const at = { lng: eastKm(-3), lat: northKm(1) };
    const c = await createCustomer(at);
    const placed = await placeOrder(c.token, c.addressId, [{ listing, quantity: 2 }], { at });
    if (placed.status !== 201) throw new Error(`order failed: ${placed.status} ${JSON.stringify(placed.body)}`);
    const order = placed.body.data.order;
    const group = order.groups[0];
    await http().put(`/api/orders/${order.id}/status`).set(auth(farm.token)).send({ groupId: group._id, status: 'accepted' }).expect(200);
    return { customer: c, orderId: order.id as string, groupId: group._id as string, code: group.handoverCode as string, total: group.total as number };
  }
  const request = (o: { orderId: string; groupId: string }) =>
    http().post(`/api/orders/${o.orderId}/groups/${o.groupId}/delivery-partner`).set(auth(farm.token));
  const board = (token: string) => http().get('/api/delivery/jobs/available').set(auth(token));

  it('registers as a partner and must set a base before going online', async () => {
    const p = await registerUser('delivery');
    expect(p.user.role).toBe('delivery');
    const profile = await http().get('/api/delivery/profile').set(auth(p.token));
    expect(profile.body.data.profile).toMatchObject({ ready: false, isOnline: false, vehicle: 'bike' });
    const online = await http().put('/api/delivery/profile').set(auth(p.token)).send({ isOnline: true });
    expect(online.status).toBe(400);
    // A base alone isn't enough without a phone number (e.g. an account created with Google).
    await User.updateOne({ _id: p.user.id }, { $unset: { phone: 1 } });
    await http().put('/api/delivery/profile').set(auth(p.token)).send({ base: { lng: RAIPUR.lng, lat: RAIPUR.lat } }).expect(200);
    const noPhone = await http().put('/api/delivery/profile').set(auth(p.token)).send({ isOnline: true });
    expect(noPhone.status).toBe(400);
    expect(noPhone.body.error.details[0].field).toBe('phone');
    // Customers and farmers can't use partner endpoints.
    expect((await board(farm.token)).status).toBe(403);
  });

  it('runs the whole job: request → nearby board → accept → pickup → code → delivered, cash and payout recorded', async () => {
    const o = await acceptedOrder();
    const partner = await createPartner({ phone: '9811122233' });

    // Not on the board until the farmer asks for a partner.
    expect((await board(partner.token)).body.data).toHaveLength(0);
    const req = await request(o);
    expect(req.status).toBe(200);
    expect(req.body.data.order.groups[0].deliveryMode).toBe('partner');

    const jobs = (await board(partner.token)).body.data as { id: string; payout: number; codAmount: number; pickupDistanceKm: number; drop: Record<string, unknown>; pickup: Record<string, unknown> }[];
    const job = jobs.find((j) => j.codAmount === o.total)!;
    expect(job).toBeTruthy();
    expect(job.payout).toBeGreaterThanOrEqual(30);
    expect(job.pickupDistanceKm).toBeCloseTo(2, 0);
    // Before accepting, a partner sees areas, not phone numbers or exact addresses.
    expect(job.drop.phone).toBeUndefined();
    expect(job.drop.line1).toBeUndefined();
    expect(job.pickup.farmerPhone).toBeUndefined();

    const accepted = await http().post(`/api/delivery/jobs/${job.id}/accept`).set(auth(partner.token));
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.job.drop.line1).toBe('House 1, Test Lane');

    // The customer sees who is coming; the farmer can't deliver it themself any more.
    const forCustomer = await http().get(`/api/orders/${o.orderId}`).set(auth(o.customer.token));
    expect(forCustomer.body.data.order.groups[0].courier).toMatchObject({ name: 'Test Rider', phone: '9811122233', vehicle: 'bike' });
    const farmerTry = await http().put(`/api/orders/${o.orderId}/status`).set(auth(farm.token)).send({ groupId: o.groupId, status: 'out_for_delivery' });
    expect(farmerTry.status).toBe(409);

    // Must pick up before delivering; a wrong code is refused.
    expect((await http().post(`/api/delivery/jobs/${job.id}/deliver`).set(auth(partner.token)).send({ code: o.code })).status).toBe(409);
    await http().post(`/api/delivery/jobs/${job.id}/pickup`).set(auth(partner.token)).expect(200);
    const wrong = o.code === '0000' ? '1111' : '0000';
    expect((await http().post(`/api/delivery/jobs/${job.id}/deliver`).set(auth(partner.token)).send({ code: wrong })).status).toBe(400);
    const done = await http().post(`/api/delivery/jobs/${job.id}/deliver`).set(auth(partner.token)).send({ code: o.code });
    expect(done.status).toBe(200);
    expect(done.body.data.job.status).toBe('delivered');

    const order = await Order.findById(o.orderId);
    expect(order!.groups[0]!.status).toBe('delivered');
    expect(order!.groups[0]!.paymentCollected).toBe(true);
    expect(order!.groups[0]!.history.map((h) => h.by)).toEqual(['customer', 'farmer', 'delivery', 'delivery']);

    const ov = await http().get('/api/delivery/overview').set(auth(partner.token));
    expect(ov.body.data.today).toMatchObject({ jobs: 1, earned: job.payout });
    expect(ov.body.data.cashInHand).toBe(o.total);
    const history = await http().get('/api/delivery/jobs?view=completed').set(auth(partner.token));
    expect(history.body.data).toHaveLength(1);
    // Finished jobs keep names and areas for the record, but not phone numbers.
    expect(history.body.data[0].drop.phone).toBeUndefined();
    expect(history.body.data[0].pickup.farmerPhone).toBeUndefined();
  });

  it('only one partner gets a job when several accept at once', async () => {
    const o = await acceptedOrder();
    await request(o).expect(200);
    const job = await Delivery.findOne({ order: o.orderId });
    const partners = await Promise.all([1, 2, 3, 4].map(() => createPartner()));
    const results = await Promise.all(partners.map((p) => http().post(`/api/delivery/jobs/${job!._id}/accept`).set(auth(p.token))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    const winner = partners[results.findIndex((r) => r.status === 200)]!;
    // A losing partner can't act on it.
    const loser = partners[results.findIndex((r) => r.status === 409)]!;
    expect((await http().post(`/api/delivery/jobs/${job!._id}/pickup`).set(auth(loser.token))).status).toBe(404);
    await http().post(`/api/delivery/jobs/${job!._id}/pickup`).set(auth(winner.token)).expect(200);
  });

  it('shows jobs only to online partners whose service area covers the farm', async () => {
    const o = await acceptedOrder();
    await request(o).expect(200);
    const job = await Delivery.findOne({ order: o.orderId });
    const near = await createPartner();
    const far = await createPartner({ lng: eastKm(40), radiusKm: 10 });
    const offline = await createPartner({ online: false });

    const ids = async (token: string) => ((await board(token)).body.data as { id: string }[]).map((j) => j.id);
    expect(await ids(near.token)).toContain(String(job!._id));
    expect(await ids(far.token)).not.toContain(String(job!._id));
    expect((await http().post(`/api/delivery/jobs/${job!._id}/accept`).set(auth(offline.token))).status).toBe(409);
  });

  it('a partner can hand a job back before pickup, and caps how many they hold', async () => {
    const partner = await createPartner();
    await http().put('/api/delivery/profile').set(auth(partner.token)).send({ isOnline: true }).expect(200);
    const orders = await Promise.all([1, 2, 3, 4].map(() => acceptedOrder()));
    for (const o of orders) await request(o).expect(200);
    const jobs = await Delivery.find({ order: { $in: orders.map((o) => o.orderId) } });
    const accept = (id: unknown) => http().post(`/api/delivery/jobs/${id}/accept`).set(auth(partner.token));
    for (const j of jobs.slice(0, 3)) await accept(j._id).expect(200);
    expect((await accept(jobs[3]!._id)).status).toBe(409); // max 3 active

    await http().post(`/api/delivery/jobs/${jobs[0]!._id}/release`).set(auth(partner.token)).expect(200);
    const back = await Delivery.findById(jobs[0]!._id);
    expect(back).toMatchObject({ status: 'requested', partner: null });
    const g = (await Order.findById(back!.order))!.groups[0]!;
    expect(g.courier).toBeUndefined();
    await accept(jobs[3]!._id).expect(200);

    // After pickup it can't be handed back.
    await http().post(`/api/delivery/jobs/${jobs[1]!._id}/pickup`).set(auth(partner.token)).expect(200);
    expect((await http().post(`/api/delivery/jobs/${jobs[1]!._id}/release`).set(auth(partner.token))).status).toBe(409);
  });

  it('the farmer can withdraw an unaccepted request, or cancel the order and remove the job', async () => {
    const o = await acceptedOrder();
    await request(o).expect(200);
    expect((await request(o)).status).toBe(409); // already requested
    const withdrawn = await http().delete(`/api/orders/${o.orderId}/groups/${o.groupId}/delivery-partner`).set(auth(farm.token));
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.data.order.groups[0].deliveryMode).toBe('self');
    expect(await Delivery.findOne({ order: o.orderId })).toMatchObject({ status: 'scheduled', mode: 'self' });
    // Back to self-delivery: the farmer can take it out themself.
    await http().put(`/api/orders/${o.orderId}/status`).set(auth(farm.token)).send({ groupId: o.groupId, status: 'out_for_delivery' }).expect(200);

    const o2 = await acceptedOrder();
    await request(o2).expect(200);
    const partner = await createPartner();
    const job = await Delivery.findOne({ order: o2.orderId });
    await http().post(`/api/delivery/jobs/${job!._id}/accept`).set(auth(partner.token)).expect(200);
    expect((await http().delete(`/api/orders/${o2.orderId}/groups/${o2.groupId}/delivery-partner`).set(auth(farm.token))).status).toBe(409);
    await http().put(`/api/orders/${o2.orderId}/status`).set(auth(farm.token)).send({ groupId: o2.groupId, status: 'cancelled', note: 'Crop failed' }).expect(200);
    expect((await Delivery.findById(job!._id))!.status).toBe('cancelled');
    expect((await http().post(`/api/delivery/jobs/${job!._id}/pickup`).set(auth(partner.token))).status).toBe(409);
  });

  it('a request is only possible after the farmer accepts the order', async () => {
    const c = await createCustomer();
    const placed = await placeOrder(c.token, c.addressId, [{ listing, quantity: 1 }]);
    const group = placed.body.data.order.groups[0];
    expect((await request({ orderId: placed.body.data.order.id, groupId: group._id })).status).toBe(409);
  });
});
