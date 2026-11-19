/**
 * End-to-end journeys, one per kind of user, through the real HTTP API in the order a person
 * would click through the web app. They complement the feature tests by checking that each
 * role can get from "just arrived" to "done" without dead ends, and only sees what they should.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app, auth, eastKm, http, northKm, productId, RAIPUR, useDatabase } from './helpers';
import { testOutbox } from '../src/services/email.service';

useDatabase();

const HOME = { lng: eastKm(-2), lat: northKm(1) }; // the customer's flat, ~2 km from the farm
const FARM = { lng: eastKm(1), lat: RAIPUR.lat };
const ok = <T extends { status: number; body: unknown }>(res: T, status = 200) => {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res;
};

/** State shared along the story: each role's journey picks up where the last one left off. */
const story: {
  farmer?: { token: string; listing: string; farmId: string };
  customer?: { token: string; email: string; orderId: string; groupId: string; code: string };
  partner?: { token: string; jobId: string };
} = {};

describe('journey: farmer gets ready to sell', () => {
  it('signs up, describes the farm, lists produce and sees it go live', async () => {
    const reg = ok(await http().post('/api/auth/register').send({ name: 'Meena Patel', email: 'meena@journey.test', phone: '9812300001', password: 'kheti2026', role: 'farmer' }), 201);
    const token = reg.body.data.token as string;
    expect(reg.body.data.user.role).toBe('farmer');

    // Dashboard guides onboarding: nothing set up yet.
    const first = ok(await http().get('/api/farmers/me/overview').set(auth(token)));
    expect(first.body.data).toMatchObject({ farmCount: 0, profileComplete: false });

    ok(await http().post('/api/farmers/profile').set(auth(token)).send({ bio: 'Chemical-free vegetables from our family farm.', experienceYears: 12, languages: ['Hindi'], practices: ['vermicompost'] }), 201);
    const farm = ok(
      await http().post('/api/farms').set(auth(token)).send({
        name: 'Meena Organic Bagicha',
        city: 'Raipur',
        address: { line1: 'Behind the panchayat', village: 'Saddu', state: 'Chhattisgarh', pincode: '492014' },
        location: FARM,
        deliveryRadiusKm: 12,
      }),
      201,
    );
    const listing = ok(
      await http()
        .post('/api/inventory')
        .set(auth(token))
        .send({ product: await productId('spinach'), price: 30, unit: 'bunch', quantityAvailable: 40, harvestDate: new Date().toISOString().slice(0, 10) }),
      201,
    );

    // The listing is live for nearby customers straight away.
    const mine = ok(await http().get('/api/inventory/mine?status=active').set(auth(token)));
    expect(mine.body.data).toHaveLength(1);
    story.farmer = { token, listing: listing.body.data.item.id, farmId: farm.body.data.farm.id };
  });
});

describe('journey: customer finds produce, orders and receives it', () => {
  it('browses as a guest, signs up at checkout, orders, tracks and recovers a forgotten password', async () => {
    const { listing } = story.farmer!;

    // Guest: produce near home, the listing page, the farmer's profile, a cart quote.
    const near = ok(await http().get(`/api/inventory?lng=${HOME.lng}&lat=${HOME.lat}`));
    const found = near.body.data.find((l: { id: string }) => l.id === listing);
    expect(found).toMatchObject({ product: { name: 'Spinach' }, price: 30 });
    expect(found.distanceKm).toBeGreaterThan(2);
    ok(await http().get(`/api/inventory/${listing}?lng=${HOME.lng}&lat=${HOME.lat}`));
    ok(await http().get(`/api/farmers/${found.farmer.id}?lng=${HOME.lng}&lat=${HOME.lat}`));
    const quote = ok(await http().post('/api/orders/quote').send({ items: [{ listing, quantity: 3 }], location: HOME }));
    expect(quote.body.data.issues).toEqual([]);
    expect(quote.body.data.itemsTotal).toBe(90);

    // Checkout needs an account and an address.
    expect((await http().post('/api/orders').send({})).status).toBe(401);
    const reg = ok(await http().post('/api/auth/register').send({ name: 'Anita Rao', phone: '+91 98123 00004', email: 'anita@journey.test', password: 'sabzi2026', role: 'customer' }), 201);
    const token = reg.body.data.token as string;
    const address = ok(
      await http().post('/api/addresses').set(auth(token)).send({ name: 'Anita Rao', phone: '9812300002', line1: 'Flat 4B, Green Residency', landmark: 'Near Shankar Nagar chowk', city: 'Raipur', pincode: '492007', location: HOME }),
      201,
    );
    const placed = ok(
      await http()
        .post('/api/orders')
        .set({ ...auth(token), 'Idempotency-Key': 'journey-checkout-1' })
        .send({ items: [{ listing, quantity: 3 }], addressId: address.body.data.address.id, paymentMethod: 'cod', expectedTotal: quote.body.data.grandTotal }),
      201,
    );
    const order = placed.body.data.order;
    expect(order).toMatchObject({ status: 'placed', paymentStatus: 'cod_pending', grandTotal: quote.body.data.grandTotal });
    expect(order.groups[0].handoverCode).toMatch(/^\d{4}$/);
    expect(order.groups[0].acceptBy).toBeTruthy(); // shown as "waiting for the farmer to confirm by …"

    // A double-tap on "Place order" returns the same order instead of a second one.
    const again = await http()
      .post('/api/orders')
      .set({ ...auth(token), 'Idempotency-Key': 'journey-checkout-1' })
      .send({ items: [{ listing, quantity: 3 }], addressId: address.body.data.address.id, paymentMethod: 'cod', expectedTotal: quote.body.data.grandTotal });
    expect(again.body.data.order.id).toBe(order.id);

    const history = ok(await http().get('/api/orders/my-orders').set(auth(token)));
    expect(history.body.data.map((o: { id: string }) => o.id)).toEqual([order.id]);
    story.customer = { token, email: 'anita@journey.test', orderId: order.id, groupId: order.groups[0]._id, code: order.groups[0].handoverCode };

    // Forgot password → email link → new password → old sessions end.
    testOutbox.length = 0;
    ok(await http().post('/api/auth/forgot-password').send({ email: 'anita@journey.test' }));
    const link = testOutbox[0]!.text.match(/token=(\S+)/)![1]!;
    ok(await http().post('/api/auth/reset-password').send({ token: decodeURIComponent(link), password: 'naya-pass-7' }));
    // Back in with her mobile number and the new password.
    const relogin = ok(await http().post('/api/auth/login').send({ identifier: '9812300004', password: 'naya-pass-7' }));
    story.customer.token = relogin.body.data.token;
  });
});

describe('journey: farmer handles the order and books a delivery partner', () => {
  it('sees the new order without the customer’s code, accepts, packs and asks for a partner', async () => {
    const { token } = story.farmer!;
    const { orderId, groupId } = story.customer!;

    const overview = ok(await http().get('/api/farmers/me/overview').set(auth(token)));
    expect(overview.body.data.orders.pending).toBe(1);
    const incoming = ok(await http().get('/api/orders/farmer?view=incoming').set(auth(token)));
    expect(incoming.body.data).toHaveLength(1);
    expect(JSON.stringify(incoming.body.data)).not.toContain('handoverCode');
    expect(incoming.body.data[0].address).toMatchObject({ name: 'Anita Rao', phone: '9812300002' });

    const put = (status: string, extra: object = {}) => http().put(`/api/orders/${orderId}/status`).set(auth(token)).send({ groupId, status, ...extra });
    ok(await put('accepted', { deliveryDate: new Date().toISOString().slice(0, 10) }));
    ok(await put('packed'));
    const requested = ok(await http().post(`/api/orders/${orderId}/groups/${groupId}/delivery-partner`).set(auth(token)));
    expect(requested.body.data.order.groups[0].deliveryMode).toBe('partner');

    // Stock: 3 bunches are held for this order, not sold twice.
    const stock = ok(await http().get(`/api/inventory/mine/${story.farmer!.listing}`).set(auth(token)));
    expect(stock.body.data.item).toMatchObject({ quantityAvailable: 37, quantityReserved: 3 });
  });
});

describe('journey: delivery partner signs up and completes the delivery', () => {
  it('sets up, goes online, takes the nearby job, picks up and hands over with the code', async () => {
    const reg = ok(await http().post('/api/auth/register').send({ name: 'Ravi Kumar', email: 'ravi@journey.test', phone: '9812300003', password: 'cycle2026', role: 'delivery' }), 201);
    const token = reg.body.data.token as string;

    // Can't go online until the work area is set (the mobile number came with signup).
    expect((await http().put('/api/delivery/profile').set(auth(token)).send({ isOnline: true })).status).toBe(400);
    ok(await http().put('/api/delivery/profile').set(auth(token)).send({ vehicle: 'scooter', base: { ...RAIPUR, label: 'Pandri' }, serviceRadiusKm: 10 }));
    ok(await http().put('/api/delivery/profile').set(auth(token)).send({ isOnline: true }));

    const overview = ok(await http().get('/api/delivery/overview').set(auth(token)));
    expect(overview.body.data).toMatchObject({ availableJobs: 1, activeJobs: 0, today: { jobs: 0, earned: 0 } });

    // The board shows pay, distance and areas — no phone numbers until accepted.
    const board = ok(await http().get('/api/delivery/jobs/available').set(auth(token)));
    const job = board.body.data[0];
    expect(job).toMatchObject({ pickup: { farmName: 'Meena Organic Bagicha' }, codAmount: expect.any(Number) });
    expect(job.drop.area).toContain('Shankar Nagar');
    expect(job.drop.phone).toBeUndefined();

    const accepted = ok(await http().post(`/api/delivery/jobs/${job.id}/accept`).set(auth(token)));
    expect(accepted.body.data.job.drop).toMatchObject({ name: 'Anita Rao', phone: '9812300002', line1: 'Flat 4B, Green Residency' });
    expect(accepted.body.data.job.pickup).toMatchObject({ farmerName: 'Meena Patel', farmerPhone: '9812300001' });
    expect(accepted.body.data.job.items).toEqual([{ name: 'Spinach', quantity: 3, unit: 'bunch' }]);

    // The customer sees who is coming; the partner still can't open the order itself.
    const customerView = ok(await http().get(`/api/orders/${story.customer!.orderId}`).set(auth(story.customer!.token)));
    expect(customerView.body.data.order.groups[0].courier).toMatchObject({ name: 'Ravi Kumar', phone: '9812300003', vehicle: 'scooter' });
    expect((await http().get(`/api/orders/${story.customer!.orderId}`).set(auth(token))).status).toBe(404);

    ok(await http().post(`/api/delivery/jobs/${job.id}/pickup`).set(auth(token)));
    const tracking = ok(await http().get(`/api/orders/${story.customer!.orderId}`).set(auth(story.customer!.token)));
    expect(tracking.body.data.order.groups[0].status).toBe('out_for_delivery');

    const wrong = story.customer!.code === '1234' ? '4321' : '1234';
    const bad = await http().post(`/api/delivery/jobs/${job.id}/deliver`).set(auth(token)).send({ code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.body.error.message).toMatch(/4 tries left/);
    ok(await http().post(`/api/delivery/jobs/${job.id}/deliver`).set(auth(token)).send({ code: story.customer!.code }));

    const after = ok(await http().get('/api/delivery/overview').set(auth(token)));
    expect(after.body.data.today.jobs).toBe(1);
    expect(after.body.data.today.earned).toBe(job.payout);
    expect(after.body.data.cashInHand).toBe(job.codAmount);
    story.partner = { token, jobId: job.id };
  });
});

describe('journey: everyone sees the finished order', () => {
  it('customer sees it completed and paid; farmer sees the sale; stock is final', async () => {
    const final = ok(await http().get(`/api/orders/${story.customer!.orderId}`).set(auth(story.customer!.token)));
    expect(final.body.data.order).toMatchObject({ status: 'completed', paymentStatus: 'paid' });
    expect(final.body.data.order.groups[0].history.map((h: { status: string; by: string }) => `${h.status}:${h.by}`)).toEqual([
      'pending:customer',
      'accepted:farmer',
      'packed:farmer',
      'out_for_delivery:delivery',
      'delivered:delivery',
    ]);

    const done = ok(await http().get('/api/orders/farmer?view=completed').set(auth(story.farmer!.token)));
    expect(done.body.data[0].groups[0]).toMatchObject({ status: 'delivered', paymentCollected: true });
    const stock = ok(await http().get(`/api/inventory/mine/${story.farmer!.listing}`).set(auth(story.farmer!.token)));
    expect(stock.body.data.item).toMatchObject({ quantityAvailable: 37, quantityReserved: 0 });

    const history = ok(await http().get('/api/delivery/jobs?view=completed').set(auth(story.partner!.token)));
    expect(history.body.data[0]).toMatchObject({ id: story.partner!.jobId, status: 'delivered' });
  });

  it('each role is kept out of the others’ areas', async () => {
    const { farmer, customer, partner } = story;
    expect((await http().get('/api/delivery/jobs/available').set(auth(customer!.token))).status).toBe(403);
    expect((await http().get('/api/delivery/jobs/available').set(auth(farmer!.token))).status).toBe(403);
    expect((await http().get('/api/orders/farmer?view=incoming').set(auth(partner!.token))).status).toBe(403);
    expect((await http().get('/api/addresses').set(auth(partner!.token))).status).toBe(403);
    expect((await http().post('/api/inventory').set(auth(customer!.token)).send({})).status).toBe(403);
    // A browser session (cookies) works across the whole journey too.
    const browser = request.agent(app);
    ok(await browser.post('/api/auth/login').send({ identifier: '9812300003', password: 'cycle2026' }));
    ok(await browser.get('/api/delivery/overview'));
  });
});
